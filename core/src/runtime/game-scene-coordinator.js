'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');

function sceneError(code, message) {
  return Object.assign(new Error(message), { code, isLocalRequestRejection: true, outcome: 'not_sent' });
}
const SCENE_SERVICE = 'gamepb.globalscenepb.GlobalSceneService';
const SCENE_METHOD = 'PlayerSceneLogin';
const maintenance = (service, method) => (service === 'gamepb.userpb.UserService' && method === 'Heartbeat')
  || (service === 'gamepb.acepb.AceService' && method === 'AntiData');
const priorityMethod = (service, method) => service === 'gamepb.plantpb.PlantService' && ['Harvest', 'Steal', 'AllLands'].includes(method);

/** One physical connection can only have one confirmed active gameplay scene. */
function createGameSceneCoordinator(options) {
  const context = new AsyncLocalStorage();
  const ordinary = new Set();
  const now = options.now || Date.now;
  const totalMs = options.totalMs || 12000;
  const rpcMs = options.rpcMs || 2500;
  let lease = null;
  let scene = 1;
  let recovery = null;
  let recoveryAttempts = 0;
  let connection = '';
  let taskDirty = false;
  let storageWarning = false;
  const identity = () => options.identity();
  function syncIdentity() {
    const current = identity();
    if (connection && connection !== current.key) {
      scene = 1; taskDirty = false; recoveryAttempts = 0;
      options.cancelRecovery?.();
    }
    connection = current.key;
    return current;
  }
  const localError = () => sceneError('RANCH_SCENE_RECOVERING', '正在恢复农场场景，请稍后刷新；已发送操作不会自动重放');
  function save(value) { options.save?.({ version: 1, identity: connection, scene: value, updatedAt: now() }); }
  function profileAllows(calls, sceneCalls = 2) {
    const profile = options.profile?.();
    if (profile?.policySupported === true && profile.enabled === false) return true;
    if (!profile || !Number.isFinite(profile.totalLimit) || !Number.isFinite(profile.windowCount)) return false;
    const top = profile.top || [];
    const found = top.find(item => item.method === `${SCENE_SERVICE}.${SCENE_METHOD}`);
    const used = found ? found.count : top.length < 12 ? 0 : Math.floor(profile.windowCount / 13);
    return profile.windowCount + calls + 8 <= profile.totalLimit && used + sceneCalls <= profile.perMethodLimit;
  }
  function scheduleRecovery() {
    if (scene === 1 || lease || recovery || !identity().connected) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(5, recoveryAttempts++));
    options.scheduleRecovery?.(() => recover().catch(() => {}), delay);
  }
  async function restore(expected) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = syncIdentity();
      if (current.key !== expected) return true; // A new physical login starts in the farm scene.
      if (!current.connected) { lastError = localError(); break; }
      try {
        const response = await options.send(SCENE_SERVICE, SCENE_METHOD, options.encodeScene(1), rpcMs, {}, true);
        const decoded = options.decodeScene(response.body);
        if (Number(decoded.global_scene_id) !== 1 || !decoded.farm_scene_ext_data?.length) throw localError();
        scene = 1;
        try { save(1); storageWarning = false; } catch { storageWarning = true; }
        recoveryAttempts = 0; options.cancelRecovery?.();
        if (taskDirty) { taskDirty = false; try { options.onFarmRestored?.(); } catch { /* Observation cannot undo confirmed restoration. */ } }
        return true;
      } catch (error) { lastError = error; }
    }
    scene = 0;
    throw lastError || localError();
  }
  async function recover() {
    if (lease) return false;
    if (recovery) return recovery;
    const current = syncIdentity();
    if (scene === 1) return true;
    if (!current.connected) throw localError();
    const pending = restore(current.key);
    recovery = pending;
    try { return await pending; }
    finally { if (recovery === pending) recovery = null; scheduleRecovery(); }
  }
  function checkOwner(current) {
    const state = syncIdentity();
    if (!current.live || context.getStore() !== current || state.key !== current.identity.key || !state.connected)
      throw sceneError('RANCH_SESSION_CHANGED', '账号连接已变化，未继续发送牧场操作');
    if (state.revision !== current.identity.revision) throw sceneError('RANCH_SETTINGS_CHANGED', '账号设置已变化，请刷新后重试');
    if (current.yieldRequested || options.priority?.(totalMs + 10000) || now() >= current.deadline)
      throw sceneError('RANCH_FARM_PRIORITY', '农场收获或好友抢收优先，请稍后重试');
    if (current.calls >= current.maxCalls - 2) throw sceneError('RANCH_REQUEST_BOUND', '本次牧场读取已达上限，请分次操作');
  }
  async function send(service, method, body, timeout, extra) {
    if (maintenance(service, method)) return options.send(service, method, body, timeout, extra, false);
    const current = context.getStore();
    if (current && current === lease) {
      checkOwner(current); current.calls++;
      return options.send(service, method, body, Math.min(timeout > 0 ? timeout : rpcMs, rpcMs, Math.max(1, current.deadline - now())), extra, false);
    }
    const started = now();
    if (lease) {
      if (priorityMethod(service, method)) lease.yieldRequested = true;
      const active = lease;
      let timer;
      try {
        await Promise.race([active.released, new Promise((_, reject) => {
          timer = setTimeout(() => reject(sceneError('LOCAL_REQUEST_TIMEOUT', '请求等待牧场场景恢复已超时，未发送')), timeout > 0 ? timeout : 20000);
        })]);
      } finally { clearTimeout(timer); }
    }
    syncIdentity();
    if (scene !== 1) { scheduleRecovery(); throw localError(); }
    const remaining = timeout > 0 ? timeout - (now() - started) : timeout;
    if (timeout > 0 && remaining <= 0) throw sceneError('LOCAL_REQUEST_TIMEOUT', '请求已过期，未发送');
    const pending = Promise.resolve(options.send(service, method, body, remaining, extra, false));
    ordinary.add(pending);
    try { return await pending; } finally { ordinary.delete(pending); }
  }
  async function run(callback, config = {}) {
    if (lease) throw sceneError('RANCH_BUSY', '牧场正在处理另一项操作，请稍候');
    const current = syncIdentity();
    if (!current.connected) throw sceneError('RANCH_OFFLINE', '账号尚未连接');
    if (Number(current.level) < 25) throw sceneError('RANCH_LEVEL_REQUIRED', '农场达到25级后可开启牧场');
    if (scene !== 1) { scheduleRecovery(); throw localError(); }
    const maxCalls = Math.min(10, Math.max(4, Number(config.maxCalls) || 7));
    if (options.priority?.(totalMs + 10000)) throw sceneError('RANCH_FARM_PRIORITY', '农场收获或好友抢收优先，请稍后重试');
    if (!profileAllows(maxCalls, 3)) throw sceneError('RANCH_BUDGET_BUSY', '本轮请求预算不足，已为农场与场景恢复保留额度');
    let release;
    const active = { identity: Object.freeze({ ...current }), live: true, calls: 0, maxCalls, deadline: now() + totalMs,
      yieldRequested: false, released: new Promise(resolve => { release = resolve; }) };
    lease = active;
    let value; let failure; let changed = false; let restored = true;
    try {
      // New normal requests now wait; drain requests admitted before this lease.
      if (ordinary.size) {
        let timer;
        try { await Promise.race([Promise.allSettled([...ordinary]), new Promise((_, reject) => {
          timer = setTimeout(() => reject(sceneError('RANCH_FARM_BUSY', '农场请求尚未完成，请稍后重试')), Math.min(1500, totalMs));
        })]); } finally { clearTimeout(timer); }
      }
      await context.run(active, async () => {
        checkOwner(active);
        save(0); changed = true; scene = 0;
        let response;
        try { response = await send(SCENE_SERVICE, SCENE_METHOD, options.encodeScene(2), rpcMs); }
        catch (failure) {
          if (failure.isServerBusinessError === true && failure.serverErrorCode === 1045002) {
            throw Object.assign(new Error('当前游戏连接暂未开放牧场，农场连接已保留；待下次正常登录后再检查'), {
              code: 'RANCH_SESSION_UPDATE_REQUIRED', isServerBusinessError: true, serverErrorCode: 1045002,
            });
          }
          throw failure;
        }
        const reply = options.decodeScene(response.body);
        if (Number(reply.global_scene_id) !== 2 || !reply.big_farm_scene_ext_data?.length)
          throw sceneError('RANCH_SCENE_UNAVAILABLE', '牧场场景暂不可用或尚未开启');
        scene = 2;
        checkOwner(active);
        value = await callback({ initial: reply.big_farm_scene_ext_data, assertCurrent: () => checkOwner(active) });
      });
    } catch (error) { failure = error; }
    finally {
      if (changed) {
        try { await restore(active.identity.key); }
        catch { restored = false; }
      }
      active.live = false; lease = null; release();
      if (!restored) scheduleRecovery();
    }
    if (failure) { if (!restored) failure.sceneRecoveryRequired = true; throw failure; }
    return value && typeof value === 'object' ? { ...value, sceneRecoveryRequired: !restored } : value;
  }
  function acceptsEvent(name) {
    syncIdentity();
    if (scene === 1 && !lease) return true;
    if (name === 'taskInfoNotify') { taskDirty = true; return false; }
    return true;
  }
  try {
    const saved = options.load?.(); const current = syncIdentity();
    if (saved && saved.identity === current.key && saved.scene !== 1) scene = 0;
  } catch { syncIdentity(); scene = 0; }
  scheduleRecovery();
  return { send, run, recover, acceptsEvent,
    snapshot: () => ({ scene, busy: !!lease, recoveryRequired: scene !== 1 && !lease, storageWarning }) };
}
module.exports = { createGameSceneCoordinator, sceneError, SCENE_SERVICE, SCENE_METHOD };
