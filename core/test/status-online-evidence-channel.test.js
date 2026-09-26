'use strict';
// 好友在线证据独立订阅通道回归（2026-09-26）：日志展示筛选（realtimeLogsEnabled）
// 不得连坐业务在线信号。编译真实 status.ts / friend.ts store，用测试入口
// __handleRealtimeLogForTests 直接喂 log:new 载荷（真实 socket handler 同体）。
// 全程内存态：无 HTTP、无游戏 RPC、无真实账号。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const vue = require(path.join(root, 'web/node_modules/vue'));
const pinia = require(path.join(root, 'web/node_modules/pinia'));
const ts = require(path.join(root, 'web/node_modules/typescript'));

function loadModule(relPath, resolve) {
  const source = fs.readFileSync(path.join(root, relPath), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
  }).outputText;
  const mod = { exports: {} };
  vm.compileFunction(code, ['require', 'module', 'exports'])(resolve, mod, mod.exports);
  return mod.exports;
}

function harness(accountId = 'account-a') {
  const account = vue.reactive({ currentAccountId: accountId });
  const apiStub = { get: async () => ({ data: { ok: true, data: [] } }), post: async () => ({ data: { ok: true } }) };
  const friendSource = loadModule('web/src/stores/friend.ts', name => {
    if (name === 'pinia') return pinia;
    if (name === 'vue') return vue;
    if (name === '@/api') return { __esModule: true, default: apiStub };
    if (name === '@/stores/account') return { useAccountStore: () => account };
    throw new Error(`unexpected import ${name}`);
  });
  const statusSource = loadModule('web/src/stores/status.ts', name => {
    if (name === 'pinia') return pinia;
    if (name === 'vue') return vue;
    if (name === 'socket.io-client') return { io: () => { throw new Error('测试不得建立真实 socket'); } };
    if (name === '@vueuse/core') return { useStorage: () => vue.ref('') };
    if (name === '@/api') return { __esModule: true, default: apiStub };
    if (name === '@/stores/account') return { useAccountStore: () => account };
    throw new Error(`unexpected import ${name}`);
  });
  const statusStore = statusSource.useStatusStore(pinia.createPinia());
  const friendStore = friendSource.useFriendStore(pinia.createPinia());
  return { statusStore, friendStore, account };
}

function evidencePayload(accountId, gid, source = 'at_home', at = Date.now()) {
  return { accountId, meta: { event: 'friend_activity_evidence', friendGid: gid, at, source } };
}

test('日志展示关闭时在线证据仍更新；普通日志不进展示数组', () => {
  const h = harness();
  h.statusStore.setRealtimeLogsEnabled(false);
  const seen = [];
  const off = h.statusStore.onOnlineEvidence(e => seen.push(e.meta.friendGid));
  // 同批多好友事件：同步逐条分发，一个不丢（Vue 批量不吞）
  h.statusStore.__handleRealtimeLogForTests(evidencePayload('account-a', 101));
  h.statusStore.__handleRealtimeLogForTests(evidencePayload('account-a', 102));
  h.statusStore.__handleRealtimeLogForTests(evidencePayload('account-a', 103));
  assert.deepEqual(seen, [101, 102, 103], '关闭日志展示时分发通道不受影响');
  assert.equal(h.statusStore.logs.length, 0, '普通日志展示保持关闭');
  off();
});

test('消费链路：订阅方喂 friendStore.applyOnlineEvidenceLog → 在线标记点亮', () => {
  const h = harness();
  h.friendStore.friends = [{ gid: 201, online: false }];
  let consumed = 0;
  const off = h.statusStore.onOnlineEvidence((entry) => {
    consumed += h.friendStore.applyOnlineEvidenceLog(entry) ? 1 : 0;
  });
  h.statusStore.__handleRealtimeLogForTests(evidencePayload('account-a', 201));
  assert.equal(consumed, 1, '有效证据被消费');
  assert.equal(h.friendStore.friends[0].online, true, '好友在线点亮');
  off();
});

test('异账号/非法源/过期事件不更新（通道账号过滤 + 消费方复验）', () => {
  const h = harness();
  // 通道层账号过滤：currentRealtimeAccountId 通过 connectRealtime 前需要 token，
  // 测试直接用 payload 与订阅侧消费方复验共同覆盖：异账号 payload 被消费方拒绝
  h.friendStore.friends = [{ gid: 301, online: false }];
  const seen = [];
  const off = h.statusStore.onOnlineEvidence(e => seen.push(e));
  h.statusStore.__handleRealtimeLogForTests(evidencePayload('account-b', 301)); // 异账号
  h.statusStore.__handleRealtimeLogForTests(evidencePayload('account-a', 301, 'unknown_source')); // 非法源
  h.statusStore.__handleRealtimeLogForTests(evidencePayload('account-a', 301, 'at_home', Date.now() - 60_000)); // 过期
  assert.equal(seen.filter(e => h.friendStore.applyOnlineEvidenceLog(e)).length, 0, '全部被复验拒绝');
  assert.equal(h.friendStore.friends[0].online, false, '在线标记不被污染');
  // 但异账号/非法源的"分发"本身：unknown_source 事件仍是 friend_activity_evidence
  // 形状，会到订阅方（由消费方白名单拒绝）——分发层只做事件形状过滤
  assert.equal(seen.length, 3, '通道分发所有同形事件，消费方负责白名单');
  off();
});

test('非证据事件不分发；卸载退订后不再收到', () => {
  const h = harness();
  const seen = [];
  const off = h.statusStore.onOnlineEvidence(e => seen.push(e));
  h.statusStore.__handleRealtimeLogForTests({ accountId: 'account-a', meta: { event: 'other_event', friendGid: 1 } });
  h.statusStore.__handleRealtimeLogForTests({ accountId: 'account-a', msg: 'plain log' });
  assert.equal(seen.length, 0, '非 friend_activity_evidence 不进通道');
  h.statusStore.__handleRealtimeLogForTests(evidencePayload('account-a', 401));
  assert.equal(seen.length, 1);
  off(); // 模拟 Friends.vue onBeforeUnmount 退订
  h.statusStore.__handleRealtimeLogForTests(evidencePayload('account-a', 402));
  assert.equal(seen.length, 1, '退订后不再分发');
});

test('日志展示开启时原有行为保留：证据既分发也进展示数组', () => {
  const h = harness();
  const seen = [];
  const off = h.statusStore.onOnlineEvidence(e => seen.push(e));
  h.statusStore.__handleRealtimeLogForTests(evidencePayload('account-a', 501));
  assert.equal(seen.length, 1, '开启时分发照常');
  assert.equal(h.statusStore.logs.length, 1, '日志照常展示');
  assert.equal(h.statusStore.logs[0].meta.event, 'friend_activity_evidence');
  off();
});
