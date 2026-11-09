const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const tempParent = fs.realpathSync(os.tmpdir());
const tempPrefix = path.resolve(tempParent, 'farm-automation-observe-');
assert.equal(path.dirname(tempPrefix), tempParent);
const root = fs.mkdtempSync(tempPrefix);
process.env.FARM_DATA_DIR = root;
process.env.FARM_PRIVATE_CONFIG_FILE = path.join(root, 'none.json');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const events = require('../src/services/daily-events');
const observe = require('../src/services/automation-observability');

test('查询、等待、跳过、未执行失败、已有核心动作不镜像今日事件', () => {
  const rejected = [
    { module: 'task', event: '扫描任务', result: 'ok', count: 8 },
    { module: 'task', event: 'automation_query', result: 'read' },
    { module: 'task', event: '领取任务', result: 'pending' },
    { module: 'task', event: '领取任务', result: 'error' },
    { module: 'shop', event: '神秘商人自动购买', result: 'skip', count: 1 },
    { module: 'task', event: 'vip_daily_gift', result: 'ok' },
    { module: 'task', event: 'vip_daily_gift', result: 'ok', vipTypes: [] },
    { module: 'warehouse', event: '购买化肥', result: 'ok', count: 3 },
    { module: 'warehouse', event: '购买化肥', result: 'error', count: 3, automationAction: true },
    { module: 'activity', event: 'milk_tea_operate', result: 'ok', action: 'hire', successCount: 0 },
    { module: 'activity', event: 'milk_tea_operate', result: 'gameplay_lose', action: 'upgrade' },
    { module: 'system', event: '领取任务', result: 'ok' },
    { module: 'farm', event: '收获作物', result: 'ok', count: 2 },
    { module: 'friend', event: '照顾好友', result: 'ok', actions: ['偷3'], completedActions: [] },
    { module: 'system', event: '__proto__', result: 'ok' },
  ];
  for (const meta of rejected) assert.equal(observe.actionFromLog('观察', meta), null, JSON.stringify(meta));
});

test('跨北京时间午夜的旧日写入不删除其他进程刚创建的新日动作', () => {
  const boundary = Date.parse('2026-11-09T16:00:00Z');
  let clock = boundary - 1;
  const originalNow = Date.now;
  const originalAppend = fs.appendFileSync;
  const next = path.resolve(root, 'automation-actions-midnight-2026-11-10.jsonl');
  assert.equal(path.dirname(next), root);
  Date.now = () => clock;
  fs.appendFileSync = (...args) => {
    clock = boundary + 1;
    fs.writeFileSync(next, `${JSON.stringify({ kind: 'automation-action', id: 'next-day-action',
      at: clock, type: 'auto_task', category: 'task', level: 'info', message: 'next day action' })}\n`, { mode: 0o600 });
    return originalAppend(...args);
  };
  try {
    assert.equal(events.recordAutomationEvent('midnight', 'task', 'previous day action'), true);
    assert.equal(fs.existsSync(next), true);
    assert.deepEqual(events.getTodayEvents('midnight').map(event => event.message), ['next day action']);
  } finally { Date.now = originalNow; fs.appendFileSync = originalAppend; }
});

test('只投影确认动作；化肥只取规范成功生产者，未知出售收益/玩法失败不虚构收益', () => {
  assert.equal(observe.actionFromLog('领任务', { module: 'task', event: '领取任务', result: 'ok' }).category, 'task');
  assert.equal(observe.actionFromLog('会员礼包已领取', { module: 'task', event: 'vip_daily_gift', result: 'ok', vipTypes: [1], count: 0 }).category, 'rewards');
  assert.equal(observe.actionFromLog('购买3个', { module: 'warehouse', event: '购买化肥', result: 'ok', count: 3, automationAction: true }).category, 'fertilizer');
  assert.match(observe.actionFromLog('sell', { module: 'warehouse', event: 'sell_done', result: 'unknown_gain', soldCount: 5 }).message, /已提交出售 5 个果实，金币收益尚未确认/);
  assert.match(observe.actionFromLog('milk', { module: 'activity', event: 'milk_tea_operate', result: 'gameplay_lose', action: 'interact' }).message, /本次玩法未生效/);
  assert.match(observe.actionFromLog('mixed', { module: 'friend', event: '照顾好友', result: 'ok', actions: ['偷3', '水2'], completedActions: ['水2'] }).message, /浇水 2 次/);
  assert.doesNotMatch(observe.actionFromLog('mixed', { module: 'friend', event: '照顾好友', result: 'ok', actions: ['偷3', '水2'], completedActions: ['水2'] }).message, /偷/);
  assert.equal(observe.actionFromLog('放虫', { module: 'friend', event: '在线自动捣乱', result: 'ok', putBug: 1 }).category, 'friend');
});

test('真实Worker日志hook：查询仅运行日志、成功动作双出口；事件落盘失败不丢运行日志', () => {
  const filename = path.resolve(__dirname, '../src/core/worker.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('setLogHook((tag, msg, isWarn, meta) => {');
  const end = source.indexOf('\n});', start) + 4;
  assert.ok(start > 0 && end > start);
  let hook;
  const sent = [];
  vm.runInNewContext(source.slice(start, end), {
    setLogHook: value => { hook = value; }, sendToMaster: value => sent.push(value),
    formatLocalDateTime24: () => 'fixture-time', Date,
    process: { env: { FARM_ACCOUNT_ID: 'hook-account' } },
    require: name => { assert.equal(name, '../services/automation-observability'); return observe; },
  });
  hook('任务', '查询完成', false, { module: 'task', event: '扫描任务', result: 'ok', count: 2 });
  assert.equal(events.getTodayEvents('hook-account').length, 0);
  hook('任务', '已领取任务奖励', false, { module: 'task', event: '领取任务', result: 'ok' });
  assert.equal(sent.length, 2);
  assert.equal(events.getTodayEvents('hook-account').length, 1, '确认动作应进入今日事件');
  assert.equal(events.getTodayEvents('hook-account')[0].category, 'task');
  assert.equal(sent[1].data.meta.logKind, 'action');
  const result = observe.observeAutomationLog('hook-account', '系统', '已买到商品', false,
    { module: 'shop', event: '神秘商人自动购买', result: 'success', count: 1 }, () => { throw new Error('fixture sink failed'); });
  assert.equal(result.tag, '仓库');
  assert.equal(result.meta.module, 'warehouse');
});

test('查询限频独立按消息：开始/结束交替不绕过去重，动作及告警不受限频影响', () => {
  const utils = require('../src/utils/utils');
  const original = utils.log;
  const logs = [];
  utils.log = (...args) => logs.push(args);
  try {
    assert.equal(observe.logAutomationQuery('task', 'fixture query begin'), true);
    assert.equal(observe.logAutomationQuery('task', 'fixture query end'), true);
    assert.equal(observe.logAutomationQuery('task', 'fixture query begin'), false);
    assert.equal(observe.logAutomationQuery('task', 'fixture query end'), false);
    assert.equal(logs.length, 2);
    assert.equal(logs[0][2].logKind, 'query');
    const actions = [];
    for (let index = 0; index < 2; index++) observe.observeAutomationLog('query-account', '任务', '同一任务的两次确认动作', false,
      { module: 'task', event: '领取任务', result: 'ok' }, (...args) => actions.push(args));
    assert.equal(actions.length, 2, '日志限频不得吞真实动作');
  } finally { utils.log = original; }
});

test('配置状态日志不泄露值、不进入今日动作；不变配置不重复提示', () => {
  const utils = require('../src/utils/utils');
  const original = utils.log;
  const logs = [];
  utils.log = (...args) => logs.push(args);
  try {
    const previous = observe.snapshotAutomationConfig({ task: false, sell: true });
    assert.equal(observe.logAutomationConfigChanges(previous, { task: true, sell: false }), true);
    assert.match(logs[0][1], /开启任务领奖/);
    assert.match(logs[0][1], /关闭自动出售/);
    assert.equal(observe.actionFromLog(logs[0][1], logs[0][2]), null);
    assert.equal(observe.logAutomationConfigChanges(observe.snapshotAutomationConfig({ task: true }), { task: true }), false);
    assert.equal(logs.length, 1);
  } finally { utils.log = original; }
});

test('跨进程并发动作追加不覆盖，旧事件快照写回也不抹掉新动作', async () => {
  const moduleFile = require.resolve('../src/services/daily-events');
  const code = 'const e=require(process.argv[1]);for(let i=0;i<20;i++)if(!e.recordAutomationEvent("parallel-account","task","completed action"))process.exit(2);';
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code, moduleFile], { env: { ...process.env, FARM_DATA_DIR: root }, stdio: 'pipe' });
    child.on('error', reject);
    child.on('close', exit => exit === 0 ? resolve() : reject(new Error(`fixture child failed ${exit}`)));
  });
  events.recordEvent('parallel-account', 'info', 'harvest', '已有收菜');
  await Promise.all([run(), run()]);
  events.recordEvent('parallel-account', 'info', 'plant', '已有播种');
  const today = events.getTodayEvents('parallel-account');
  assert.equal(today.length, 42);
  assert.equal(today.filter(event => event.type === 'auto_task').length, 40);
  assert.equal(new Set(today.filter(event => event.id).map(event => event.id)).size, 40);
  const persisted = events.readPersistedTodayEvents('parallel-account');
  assert.equal(persisted.length, 42);
});

test('动作文件拒绝越界/符号链接，部分末行不吞下一条；只清理自身昨日动作文件', () => {
  const write = (name, contents) => { const file = path.resolve(root, name); assert.equal(path.dirname(file), root); fs.writeFileSync(file, contents); return file; };
  const kept = write('unknown-user-file.txt', 'must remain');
  assert.equal(events.recordAutomationEvent('../escape', 'task', 'no write'), false);
  const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const linked = path.resolve(root, `automation-actions-linked-${day}.jsonl`);
  assert.equal(path.dirname(linked), root);
  fs.symlinkSync(kept, linked);
  assert.equal(events.recordAutomationEvent('linked', 'task', 'no write'), false);
  assert.equal(fs.readFileSync(kept, 'utf8'), 'must remain');
  const old = write('automation-actions-rollover-2000-01-01.jsonl', JSON.stringify({ kind: 'automation-action' }));
  const unknown = write('automation-actions-rollover-2000-01-02.jsonl', 'unknown evidence');
  const current = write(`automation-actions-rollover-${day}.jsonl`, '{partial');
  assert.equal(events.recordAutomationEvent('rollover', 'land', '已解锁土地'), true);
  assert.equal(events.getTodayEvents('rollover').length, 1);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(unknown), true);
  assert.equal(fs.statSync(current).mode & 0o777, 0o600);
});
