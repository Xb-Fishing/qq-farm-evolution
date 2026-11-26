const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const state = {
    lands: [{ id: 2 }, { id: 3 }, { id: 5, plant: { id: 1020307 } }, { id: 6, plant: { id: 1010001 } }],
    reserved: [2],
    writes: [],
    connected: true,
    seedCount: 1,
    confirmPlant: true,
  };
  const target = path.resolve(__dirname, '../src/services/sweet-potato-plots.js');
  const mod = { exports: {} };
  const injected = {
    './farm-api': {
      getAllLands: async () => ({ lands: state.lands }),
      harvest: async (plots, choices) => {
        state.writes.push(['harvest', plots[0], choices.all]);
        return { items: [{ id: 40307, count: 48 }, { id: 1032, count: 40 }] };
      },
    },
    './farm-land-analyzer': {
      analyzeLands: lands => ({ empty: lands.filter(x => !x.plant).map(x => x.id), harvestable: [5, 6] }),
      invalidatePanelLandsCache() {},
    },
    './planting-service': {
      isReserved2x2Land: id => state.reserved.includes(id),
      plantSeeds: async (seed, ids, options) => {
        state.writes.push(['plant', seed, ids[0], options.maxPlantCount]);
        if (state.confirmPlant) state.lands.find(x => x.id === ids[0]).plant = { id: 1020307 };
        return { planted: 1 };
      },
    },
    './own-quiet-priority': { isActive: () => !!state.harvestPending },
    '../models/store': { getPrioritize2x2Crops: () => true },
    './warehouse': {
      getBag: async () => [{ id: 20307, count: state.seedCount }],
      getBagItems: value => value,
      invalidatePanelBagCache() {},
    },
    './activity': { sweetPotatoOutsideWindow: () => !!state.expired },
  };
  vm.runInNewContext(fs.readFileSync(target, 'utf8'), {
    module: mod, require: name => injected[name],
  }, { filename: target });
  const checkConnection = () => { if (!state.connected) throw new Error('connection changed'); };
  return { state, get: () => mod.exports.getSweetPotatoPlots(checkConnection),
    act: (action, id) => mod.exports.performSweetPotatoPlotAction(action, id, checkConnection) };
}

test('planting uses one red-sweet-potato seed in the specified unreserved plot and reads it back', async () => {
  const f = fixture();
  const plots = await f.get();
  assert.deepEqual(Array.from(plots.empty), [3]);
  await assert.rejects(f.act('plantCrop', 2), /土地状态已变化/);
  assert.equal((await f.act('plantCrop', 3)).planted, true);
  assert.deepEqual(f.state.writes, [['plant', 20307, 3, 1]]);
});

test('harvest exclusively targets the selected mature sweet potato and reports the confirmed extra item', async () => {
  const f = fixture();
  assert.deepEqual(Array.from((await f.get()).ready), [5]);
  await assert.rejects(f.act('harvestCrop', 6), /土地状态已变化/);
  assert.equal((await f.act('harvestCrop', 5)).potatoes, 40);
  assert.deepEqual(f.state.writes, [['harvest', 5, false]]);
});

test('absence of seeds, an expired activity or a busy priority harvest prevents a plot mutation', async () => {
  const f = fixture();
  f.state.seedCount = 0;
  await assert.rejects(f.act('plantCrop', 3), /没有红薯种子/);
  f.state.harvestPending = true;
  await assert.rejects(f.act('harvestCrop', 5), /优先收获/);
  f.state.harvestPending = false;
  f.state.expired = true;
  await assert.rejects(f.act('harvestCrop', 5), /活动已结束/);
  assert.deepEqual(f.state.writes, []);
});

test('a plant acknowledgement without the matching crop never reports success', async () => {
  const f = fixture();
  f.state.confirmPlant = false;
  await assert.rejects(f.act('plantCrop', 3), /种植回执待核对/);
  assert.deepEqual(f.state.writes, [['plant', 20307, 3, 1]]);
});
