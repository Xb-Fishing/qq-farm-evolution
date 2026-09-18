const test = require('node:test');
const assert = require('node:assert/strict');

// 协议加载生命周期回归（2026-09-18 启动竞态修复）：
// 旧实现把 loadProto 开头创建的 root 当成就绪判据，且独立等待 Promise 只有
// resolve 没有 reject——加载窗口内 waitForProtoReady 立即假就绪，加载失败时
// 等待者永远悬挂。本文件锁定：就绪只在完整加载+类型解析成功后发布；
// 并发调用共享单次加载（成功与失败都共享）；失败统一收口所有等待者且不
// 自动重试；未开始/已失败时等待立即本地失败，不替调用者启动加载；
// 任何失败路径都不留下 unhandled rejection。

const protoPath = require.resolve('../src/utils/proto');
const protobufPath = require.resolve('protobufjs');

// 全文件 unhandled rejection 跟踪：失败/等待/重试路径一律不得让拒绝裸奔
const unhandledRejections = [];
process.on('unhandledRejection', reason => {
  unhandledRejections.push(String((reason && reason.message) || reason));
});
const assertNoUnhandledRejection = async () => {
  await tick();
  await tick();
  assert.deepEqual(unhandledRejections, [], 'no unhandled rejection left behind');
};

function mockModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports, paths: [] };
}

// 可控假 protobufjs：Root.load 返回手动兑现的 Promise，lookupType 可注入失败
function makeFakeProtobuf() {
  const state = { loads: 0, lookups: 0, failLookup: false, pending: [] };
  class FakeRoot {
    async load() {
      state.loads += 1;
      return new Promise((resolve, reject) => {
        state.pending.push({ resolve, reject });
      });
    }
    lookupType(name) {
      state.lookups += 1;
      if (state.failLookup) throw new Error(`lookup failed: ${name}`);
      return { name };
    }
  }
  return { state, protobuf: { Root: FakeRoot } };
}

/** 用假 protobufjs 换取一个全新的 proto 模块实例；restore 恢复现场。 */
function freshProto(fakeProtobuf) {
  const previous = require.cache[protobufPath];
  if (fakeProtobuf) {
    require.cache[protobufPath] = mockModule(protobufPath, fakeProtobuf);
  } else if (previous) {
    delete require.cache[protobufPath];
  }
  delete require.cache[protoPath];
  const proto = require(protoPath);
  return {
    proto,
    restore() {
      delete require.cache[protoPath];
      if (previous) require.cache[protobufPath] = previous;
      else delete require.cache[protobufPath];
    },
  };
}

/** 等待一个宏任务节拍，让所有微任务（含拒绝传播）落地。 */
function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

test('未开始加载时 waitForProtoReady 立即本地失败，不替调用者启动加载', async () => {
  const { state, protobuf } = makeFakeProtobuf();
  const { proto, restore } = freshProto(protobuf);
  try {
    await assert.rejects(proto.waitForProtoReady(), /尚未加载/);
    assert.equal(state.loads, 0, 'must not start loading on behalf of the caller');
    assert.equal(proto.getRoot(), null, 'root is not published before loading');
    assert.equal(Object.keys(proto.types).length, 0);
  } finally {
    restore();
  }
});

test('加载完成前不报告就绪：等待者挂在该次真实加载上', async () => {
  const { state, protobuf } = makeFakeProtobuf();
  const { proto, restore } = freshProto(protobuf);
  try {
    const loading = proto.loadProto();
    let settled = false;
    const waitPromise = proto.waitForProtoReady();
    const waiter = waitPromise.then(
      value => { settled = `ok:${value}`; },
      err => { settled = `err:${err.message}`; },
    );
    await tick();
    assert.equal(settled, false, 'waiter must stay pending while the load is in flight');
    assert.equal(proto.getRoot(), null, 'root must not publish mid-load');
    assert.equal(state.loads, 1);

    state.pending[0].resolve();
    await loading;
    assert.equal(await waitPromise, true);
    await waiter;
    assert.ok(proto.getRoot(), 'root published after full load');
  } finally {
    restore();
  }
});

test('并发 loadProto 共享同一次加载', async () => {
  const { state, protobuf } = makeFakeProtobuf();
  const { proto, restore } = freshProto(protobuf);
  try {
    const first = proto.loadProto();
    const second = proto.loadProto();
    assert.equal(state.loads, 1, 'concurrent calls share one load');
    state.pending[0].resolve();
    await Promise.all([first, second]);
    assert.equal(state.loads, 1);
  } finally {
    restore();
  }
});

test('成功后类型可用且 types 引用稳定，重复 loadProto 直接复用不再加载', async () => {
  const { state, protobuf } = makeFakeProtobuf();
  const { proto, restore } = freshProto(protobuf);
  try {
    const loading = proto.loadProto();
    state.pending[0].resolve();
    await loading;

    assert.ok(proto.types.LoginRequest, 'message types resolved');
    assert.ok(proto.types.PetDiaryOperateRequest, 'pet-diary types resolved');
    assert.equal(await proto.waitForProtoReady(), true);

    const typesRef = proto.types;
    const loginType = proto.types.LoginRequest;
    await proto.loadProto();
    await proto.loadProto();
    assert.equal(state.loads, 1, 'successful repeat loads are reused, not re-executed');
    assert.strictEqual(proto.types, typesRef, 'exported types reference stays stable');
    assert.strictEqual(proto.types.LoginRequest, loginType);
  } finally {
    restore();
  }
});

test('加载失败：本次调用与所有等待者统一结束，保持未就绪且不自动重试', async () => {
  const { state, protobuf } = makeFakeProtobuf();
  const { proto, restore } = freshProto(protobuf);
  try {
    const loading = proto.loadProto();
    const results = [];
    const track = p => p.then(
      () => results.push('ok'),
      err => results.push(`err:${err.message}`),
    );
    track(proto.waitForProtoReady());
    track(proto.waitForProtoReady());

    state.pending[0].reject(new Error('load boom'));
    await assert.rejects(loading, /load boom/);
    await tick();
    assert.deepEqual(results, ['err:load boom', 'err:load boom'],
      'all waiters end with the underlying failure');

    assert.equal(proto.getRoot(), null, 'no half-ready root');
    assert.equal(Object.keys(proto.types).length, 0, 'types stay unpolluted');
    await assert.rejects(proto.waitForProtoReady(), /加载失败.*load boom/,
      'post-failure waits fail immediately instead of dangling');
    await tick();
    assert.equal(state.loads, 1, 'no automatic retry after failure');
    await assertNoUnhandledRejection();
  } finally {
    restore();
  }
});

test('并发 loadProto 共享同一次失败：两个调用者拿到同一错误，只加载一次', async () => {
  const { state, protobuf } = makeFakeProtobuf();
  const { proto, restore } = freshProto(protobuf);
  try {
    const first = proto.loadProto();
    const second = proto.loadProto();
    assert.equal(state.loads, 1, 'concurrent calls share one load attempt');

    state.pending[0].reject(new Error('shared failure'));
    await assert.rejects(first, /shared failure/);
    await assert.rejects(second, /shared failure/, 'the shared failure reaches both callers');
    await assert.rejects(proto.waitForProtoReady(), /加载失败.*shared failure/);
    assert.equal(state.loads, 1, 'failure does not trigger a second attempt');
    await assertNoUnhandledRejection();
  } finally {
    restore();
  }
});

test('孤儿调用（loadProto 不 await 也不 catch）失败后不留 unhandled rejection', async () => {
  // 启动窗口的调用方可能只发起不等待：失败记账挂接在共享 Promise 上，
  // 不允许出现裸奔的拒绝
  const { state, protobuf } = makeFakeProtobuf();
  const { proto, restore } = freshProto(protobuf);
  try {
    proto.loadProto(); // 故意不 await / 不 catch
    state.pending[0].reject(new Error('orphan failure'));
    await tick();
    await tick();
    await tick();
    assert.equal(state.loads, 1);
    await assert.rejects(proto.waitForProtoReady(), /加载失败.*orphan failure/);
    await assertNoUnhandledRejection();
  } finally {
    restore();
  }
});

test('类型解析失败同样使加载失败并收口等待者', async () => {
  const { state, protobuf } = makeFakeProtobuf();
  const { proto, restore } = freshProto(protobuf);
  try {
    const loading = proto.loadProto();
    state.failLookup = true;
    state.pending[0].resolve();
    await assert.rejects(loading, /lookup failed/);
    await assert.rejects(proto.waitForProtoReady(), /加载失败/);
    assert.equal(proto.getRoot(), null);
    assert.equal(Object.keys(proto.types).length, 0,
      'a failed type resolution must not partially populate types');
    assert.ok(state.lookups > 0);
    await assertNoUnhandledRejection();
  } finally {
    restore();
  }
});

test('显式失败后再次 loadProto 发起新尝试并可成功；成功后等待立即返回', async () => {
  const { state, protobuf } = makeFakeProtobuf();
  const { proto, restore } = freshProto(protobuf);
  try {
    const first = proto.loadProto();
    state.pending[0].reject(new Error('first attempt fails'));
    await assert.rejects(first, /first attempt fails/);
    await assert.rejects(proto.waitForProtoReady(), /加载失败/);

    const retry = proto.loadProto();
    assert.equal(state.loads, 2, 'explicit retry starts a new attempt');
    state.pending[1].resolve();
    await retry;

    assert.equal(await proto.waitForProtoReady(), true);
    assert.ok(proto.getRoot());
    assert.ok(proto.types.LoginRequest);
    await proto.loadProto();
    assert.equal(state.loads, 2, 'no extra load after a successful retry');
    await assertNoUnhandledRejection();
  } finally {
    restore();
  }
});

test('真实 proto 文件完整加载：类型齐备、等待返回、重复调用复用', async () => {
  const { proto, restore } = freshProto(null);
  try {
    await proto.loadProto();
    assert.ok(proto.getRoot(), 'real root loaded');
    for (const name of [
      'LoginRequest', 'GetAllFriendsRequest', 'HarvestRequest',
      'ActivityGetGroupRequest', 'PetDiaryOperateRequest', 'PetDiaryGetGroupReply',
    ]) {
      assert.ok(proto.types[name], `${name} resolved from real proto files`);
    }
    assert.equal(await proto.waitForProtoReady(), true);

    const typesRef = proto.types;
    const loginType = proto.types.LoginRequest;
    await proto.loadProto();
    assert.strictEqual(proto.types, typesRef);
    assert.strictEqual(proto.types.LoginRequest, loginType);
  } finally {
    restore();
  }
});
