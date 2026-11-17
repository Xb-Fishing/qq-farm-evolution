const test = require('node:test');
const assert = require('node:assert/strict');
const codec = require('../src/services/ranch-codec');
const { createGameSceneCoordinator } = require('../src/runtime/game-scene-coordinator');
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(extra = {}) {
  const calls = []; const saved = []; const scheduled = [];
  const identity = { key: 'synthetic-connection', connected: true, level: 30, revision: 1 };
  let urgent = false; let handler = async () => ({ body: Buffer.alloc(0) });
  const scene = createGameSceneCoordinator({
    identity: () => identity, priority: () => urgent,
    profile: () => ({ totalLimit: 80, perMethodLimit: 30, windowCount: 0, top: [] }),
    encodeScene: id => codec.encode('PlayerSceneLoginRequest', { global_scene_id: id }),
    decodeScene: body => codec.decode('PlayerSceneLoginReply', body),
    save: value => saved.push(value), scheduleRecovery: (fn, delay) => scheduled.push({ fn, delay }), cancelRecovery() {},
    send: async (service, method, body, timeout, options, restore) => {
      const id = method === 'PlayerSceneLogin' ? codec.decode('PlayerSceneLoginRequest', body).global_scene_id : null;
      calls.push({ service, method, id, restore });
      if (id) return { body: codec.encode('PlayerSceneLoginReply', { global_scene_id: id,
        ...(id === 2 ? { big_farm_scene_ext_data: Buffer.from([1]) } : { farm_scene_ext_data: Buffer.from([1]) }) }) };
      return handler(service, method, body, timeout, options);
    }, ...extra,
  });
  return { scene, calls, saved, scheduled, identity, setUrgent: v => { urgent = v; }, handler: fn => { handler = fn; } };
}

test('scene lease drains farm calls, reads ranch, and restores before queued farm work', async () => {
  const f = fixture(); const gate = deferred();
  f.handler(async (_s, m) => m === 'AllLands' ? gate.promise : { body: Buffer.alloc(0) });
  const farm = f.scene.send('gamepb.plantpb.PlantService', 'AllLands', Buffer.alloc(0), 1000);
  const ranch = f.scene.run(async () => {
    await f.scene.send('gamepb.itempb.ItemService', 'GetBag', Buffer.alloc(0), 1000);
    return { data: 1 };
  });
  await tick(); assert.equal(f.calls.some(c => c.id === 2), false);
  gate.resolve({ body: Buffer.alloc(0) }); await farm; assert.equal((await ranch).sceneRecoveryRequired, false);
  assert.deepEqual(f.calls.map(c => c.id || c.method), ['AllLands', 2, 'GetBag', 1]);
  assert.deepEqual(f.saved.map(s => s.scene), [0, 1]);
});

test('priority request during a ranch read cancels later ranch writes and runs after restoration', async () => {
  const f = fixture(); const gate = deferred(); const entered = deferred();
  f.handler(async (_s, m) => { if (m === 'GetBag') { entered.resolve(); return gate.promise; } return { body: Buffer.alloc(0) }; });
  const ranch = f.scene.run(async () => {
    await f.scene.send('gamepb.itempb.ItemService', 'GetBag', Buffer.alloc(0), 1000);
    await f.scene.send('gamepb.animalpb.AnimalService', 'PlaceAnimal', Buffer.alloc(0), 1000);
  }); ranch.catch(() => {});
  await entered.promise;
  const harvest = f.scene.send('gamepb.plantpb.PlantService', 'Harvest', Buffer.alloc(0), 1000);
  gate.resolve({ body: Buffer.alloc(0) });
  await assert.rejects(ranch, { code: 'RANCH_FARM_PRIORITY' }); await harvest;
  assert.equal(f.calls.some(c => c.method === 'PlaceAnimal'), false);
  assert.ok(f.calls.findIndex(c => c.id === 1) < f.calls.findIndex(c => c.method === 'Harvest'));
});

test('known imminent harvest and insufficient budget reject before any scene request', async () => {
  const f = fixture(); f.setUrgent(true);
  await assert.rejects(f.scene.run(async () => {}), { code: 'RANCH_FARM_PRIORITY' }); assert.equal(f.calls.length, 0);
  const b = fixture({ profile: () => ({ totalLimit: 80, perMethodLimit: 30, windowCount: 75, top: [] }) });
  await assert.rejects(b.scene.run(async () => {}), { code: 'RANCH_BUDGET_BUSY' }); assert.equal(b.calls.length, 0);
});

test('policy change stops resource calls but uses fixed scene1 restoration path; scene2 task notifications are withheld', async () => {
  const f = fixture();
  await assert.rejects(f.scene.run(async () => {
    assert.equal(f.scene.acceptsEvent('taskInfoNotify'), false);
    assert.equal(f.scene.acceptsEvent('landsChanged'), true);
    f.identity.revision++;
    await f.scene.send('gamepb.animalpb.AnimalService', 'PlaceAnimal', Buffer.alloc(0));
  }), { code: 'RANCH_SETTINGS_CHANGED' });
  assert.deepEqual(f.calls.map(c => c.id), [2, 1]);
  assert.equal(f.calls.at(-1).restore, true);
  assert.equal(f.scene.acceptsEvent('taskInfoNotify'), true);
});

test('restore failure quarantines only scene business, preserves heartbeat and schedules bounded recovery', async () => {
  let restoreWorks = false; const calls = [];
  const f = fixture({ send: async (s, m, body) => {
    calls.push(m);
    if (m !== 'PlayerSceneLogin') return { body: Buffer.alloc(0) };
    const id = codec.decode('PlayerSceneLoginRequest', body).global_scene_id;
    if (id === 1 && !restoreWorks) throw new Error('synthetic transport interruption');
    return { body: codec.encode('PlayerSceneLoginReply', { global_scene_id: id,
      ...(id === 2 ? { big_farm_scene_ext_data: Buffer.from([1]) } : { farm_scene_ext_data: Buffer.from([1]) }) }) };
  } });
  const result = await f.scene.run(async () => ({ outcome: 'confirmed' }));
  assert.equal(result.outcome, 'confirmed'); assert.equal(result.sceneRecoveryRequired, true);
  await assert.rejects(f.scene.send('gamepb.plantpb.PlantService', 'Harvest', Buffer.alloc(0)), { code: 'RANCH_SCENE_RECOVERING' });
  await f.scene.send('gamepb.userpb.UserService', 'Heartbeat', Buffer.alloc(0));
  assert.ok(calls.includes('Heartbeat')); assert.ok(!calls.includes('Harvest')); assert.ok(f.scheduled.length > 0);
  restoreWorks = true; await f.scene.recover();
  await f.scene.send('gamepb.plantpb.PlantService', 'Harvest', Buffer.alloc(0)); assert.ok(calls.includes('Harvest'));
});

test('intent persistence failure sends zero requests; a retained recovery marker survives worker replacement', async () => {
  const f = fixture({ save: () => { throw new Error('synthetic write failure'); } });
  await assert.rejects(f.scene.run(async () => {})); assert.equal(f.calls.length, 0);
  const restored = fixture({ load: () => ({ identity: 'synthetic-connection', scene: 0 }) });
  assert.equal(restored.scene.snapshot().recoveryRequired, true);
  await restored.scene.recover(); assert.equal(restored.scene.snapshot().scene, 1);
});
