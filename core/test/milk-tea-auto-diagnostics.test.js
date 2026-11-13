'use strict';
// 奶茶自动检查失败日志诊断（2026-11-13 不可读 code 缺口）：
// 生产 combined-*.log 中 milk_tea_auto_check/result=error 的动态 code 被键名
// 脱敏成 [REDACTED]，事后无法判别预算/业务/会话/传输失败。本文件用真实
// runAutomaticMilkTea 入口验证：code 已改为有限枚举 failureReason，落盘不被
// 脱敏，且任何错误原文/合成秘密都不出现在任何输出里。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
// 复用 milk-tea-autonomy-baseline 夹具（模块加载即先完成 FARM_DATA_DIR 隔离，
// 并注册源码指纹与临时目录收尾钩子）。
const { fixture, fixturePath } = require('./milk-tea-autonomy-baseline.test.js');
const { setLogHook } = require('../src/utils/utils');

// 抓真实日志入口：utils.log → sanitizeMeta → logHook，meta 为进入 sink 前的
// 最终元数据（旧 code 字段在此已变成 [REDACTED]，failureReason 必须原样可见）。
const autoCheckRows = [];
setLogHook((tag, message, warn, meta) => {
  if (meta && meta.event === 'milk_tea_auto_check') autoCheckRows.push({ tag, message, warn, ...meta });
});

// 收尾核源码指纹：本轮改动仅允许三文件，源文件在测试过程中必须保持不变。
const fingerprintFiles = [__filename, path.resolve(__dirname, '../src/services/milk-tea-activity.js')];
const fingerprint = file => ({ mode: fs.statSync(file).mode, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
const fingerprintsBefore = fingerprintFiles.map(fingerprint);
test.after(() => {
  setLogHook(null);
  fingerprintFiles.forEach((file, index) => {
    assert.deepEqual(fingerprint(file), fingerprintsBefore[index], 'source content and mode unchanged');
  });
});

const REASONS = new Set(['budget_total', 'budget_method', 'business_rejected', 'control_unavailable', 'check_failed']);
const oneRow = before => {
  assert.equal(autoCheckRows.length - before, 1, `exactly one milk_tea_auto_check failure log, got ${autoCheckRows.length - before}`);
  const row = autoCheckRows[before];
  assert.equal(row.tag, '活动'); assert.equal(row.message, '奶茶自动化本轮未完成，等待下次状态复核');
  assert.equal(row.module, 'activity'); assert.equal(row.result, 'error'); assert.equal(row.warn, false);
  assert.ok(REASONS.has(row.failureReason), `failureReason within finite enum, got ${row.failureReason}`);
  assert.ok(!('code' in row), 'dynamic code field must be gone (it was [REDACTED]-masked at the sink)');
  assert.equal(JSON.stringify(row).includes('[REDACTED]'), false);
  return row;
};

test('list/group/read failures log one classified row, keep zero writes, existing backoff, then recover fresh', async () => {
  for (const stage of ['list', 'group', 63]) {
    const f = await fixture({ milk_tea_auto_work: true });
    try {
      const before = autoCheckRows.length;
      f.hook(async where => { if (where === stage) throw new Error('synthetic transport read failure'); });
      await f.service.runAutomaticMilkTea(f.deps);
      assert.equal(f.writes().length, 0, `${stage}: read failure must not trigger any game write`);
      assert.equal(oneRow(before).failureReason, 'check_failed', `${stage}: plain transport failure classified as check_failed`);
      // 既有退避：失败后同刻重跑必须被抑制（零新调用、零新日志）。
      const callsAfterFailure = f.calls.length;
      await f.service.runAutomaticMilkTea(f.deps);
      assert.equal(f.calls.length, callsAfterFailure, `${stage}: immediate retry suppressed by existing backoff`);
      assert.equal(autoCheckRows.length, before + 1, `${stage}: suppressed retry stays silent`);
      f.clock.now += 59999;
      await f.service.runAutomaticMilkTea(f.deps);
      assert.equal(f.calls.length, callsAfterFailure, `${stage}: no read before the existing one-minute minimum`);
      assert.equal(autoCheckRows.length, before + 1, `${stage}: backoff must not repeat the failure log`);
      // 正常新鲜恢复：退避窗口过后读取恢复，成功轮次零失败日志且收益链（领工资写）照常。
      f.hook(null);
      await f.tick();
      assert.equal(autoCheckRows.length, before + 1, `${stage}: successful fresh round logs no failure`);
      assert.ok(f.calls.slice(callsAfterFailure).includes('List'), `${stage}: fresh round reads again`);
      assert.ok(f.writes().includes(64), `${stage}: fresh round still claims wages through the automatic entry`);
    } finally { f.close(); }
  }
});

test('failure classification matrix through the real automatic entry', async () => {
  const cases = [
    ['strict budget total rejection', () => Object.assign(new Error('请求被治理器拦截(budget_total): List'), { isGovernedRejection: true, governedReason: 'budget_total', isLocalRequestRejection: true }), 'budget_total'],
    ['strict budget method rejection', () => Object.assign(new Error('请求被治理器拦截(budget_method): GetGroup'), { isGovernedRejection: true, governedReason: 'budget_method', isLocalRequestRejection: true }), 'budget_method'],
    ['local business rejection', () => Object.assign(new Error('奶茶热销中未下发'), { business: true, code: 'SEASON_WISH_MILK_TEA_UNAVAILABLE' }), 'business_rejected'],
    ['strict server business rejection', () => Object.assign(new Error('gamepb 错误: code=2001'), { isServerBusinessError: true, serverErrorCode: 2001 }), 'business_rejected'],
    ['session connection changed', () => Object.assign(new Error('连接已更换'), { business: true, code: 'SEASON_WISH_MILK_TEA_CONNECTION_CHANGED' }), 'control_unavailable'],
    ['session account not ready', () => Object.assign(new Error('账号未就绪'), { business: true, code: 'SEASON_WISH_MILK_TEA_NOT_READY' }), 'control_unavailable'],
    ['bridge control unavailable', () => Object.assign(new Error('SYNTHETIC_SECRET_CONTROL'), { code: 'SESSION_CONTROL_UNAVAILABLE' }), 'control_unavailable'],
    ['bridge bad synchronous reply', () => Object.assign(new Error('SYNTHETIC_SECRET_REPLY'), { code: 'SESSION_BAD_SYNC_REPLY' }), 'control_unavailable'],
    ['unknown control-like code', () => Object.assign(new Error('SYNTHETIC_SECRET_CONTROL'), { code: 'SESSION_CONTROL_UNAVAILABLE_INJECTED' }), 'check_failed'],
    ['control code contradicted by unknown result', () => ({ code: 'SESSION_CONTROL_UNAVAILABLE', unknown: true }), 'check_failed'],
    ['control code contradicted by server rejection', () => ({ code: 'SESSION_BAD_SYNC_REPLY', isServerBusinessError: true, serverErrorCode: 2001 }), 'check_failed'],
    ['non-boolean business marker', () => ({ business: 'true' }), 'check_failed'],
    ['non-boolean unknown marker', () => ({ business: true, unknown: 'false' }), 'check_failed'],
    ['secret-bearing business error keeps only the enum', () => Object.assign(new Error('SYNTHETIC_SECRET_MILK_MESSAGE'), { business: true, code: 'SEASON_WISH_MILK_TEA_SYNTHETIC_SECRET_CODE' }), 'business_rejected'],
    ['malicious governed reason is not trusted', () => Object.assign(new Error('SYNTHETIC_SECRET_GOVERNED'), { isGovernedRejection: true, governedReason: 'budget_total_evil_injected', isLocalRequestRejection: true }), 'check_failed'],
    ['changing budget getter never escapes the finite enum', () => {
      let reads = 0;
      return Object.defineProperty(Object.assign(new Error('budget getter'), { isGovernedRejection: true }), 'governedReason', {
        get() { return reads++ === 0 ? 'budget_total' : 'SYNTHETIC_SECRET_BUDGET'; },
      });
    }, 'check_failed'],
    ['governed marker contradicted by business marker', () => Object.assign(new Error('mixed markers'), { isGovernedRejection: true, governedReason: 'budget_total', business: true, code: 'SEASON_WISH_MILK_TEA_LIMIT' }), 'check_failed'],
    ['business marker contradicted by unknown outcome', () => Object.assign(new Error('mixed markers'), { business: true, code: 'SEASON_WISH_MILK_TEA_LIMIT', unknown: true }), 'check_failed'],
    ['malformed server business code is not trusted', () => Object.assign(new Error('bad code'), { isServerBusinessError: true, serverErrorCode: '0x10' }), 'check_failed'],
    ['plain string throw is malformed, not guessed', () => 'SYNTHETIC_SECRET_PLAIN_THROW', 'check_failed'],
    ['null throw is malformed, not guessed', () => null, 'check_failed'],
    ['throwing getter marker is contained', () => Object.defineProperty(new Error('marker getter'), 'isGovernedRejection', { get() { throw new Error('SYNTHETIC_SECRET_GETTER'); } }), 'check_failed'],
  ];
  for (const [name, makeError, expected] of cases) {
    const f = await fixture({ milk_tea_auto_work: true });
    try {
      const before = autoCheckRows.length;
      f.hook(async () => { throw makeError(); });
      await f.service.runAutomaticMilkTea(f.deps);
      assert.equal(f.writes().length, 0, `${name}: classified failure must not trigger any game write`);
      assert.equal(oneRow(before).failureReason, expected, name);
    } finally { f.close(); }
  }
  assert.equal(JSON.stringify(autoCheckRows).includes('SYNTHETIC_SECRET'), false);
  assert.equal(JSON.stringify(autoCheckRows).includes('budget_total_evil_injected'), false);
});

test('PAUSED/YIELD stay suppressed and successful rounds log no failure', async () => {
  { // 入口即暂停：零调用零日志。
    const f = await fixture({ milk_tea_auto_work: true });
    try {
      const before = autoCheckRows.length;
      f.deps.isPaused = () => true;
      await f.service.runAutomaticMilkTea(f.deps);
      assert.equal(f.calls.length, 0); assert.equal(autoCheckRows.length, before);
    } finally { f.close(); }
  }
  { // 运行中策略翻转 → PAUSED 抑制依旧。
    const f = await fixture({ milk_tea_auto_work: true });
    try {
      const before = autoCheckRows.length;
      f.hook(async () => { f.setFlags({ milk_tea_auto_work: false }); });
      await f.service.runAutomaticMilkTea(f.deps);
      assert.equal(f.writes().length, 0); assert.equal(autoCheckRows.length, before, 'PAUSED must not produce a failure log');
    } finally { f.close(); }
  }
  { // 让位收获 → YIELD 抑制依旧（含 1 秒快速复核路径）。
    const f = await fixture({ milk_tea_auto_work: true });
    try {
      const before = autoCheckRows.length;
      f.deps.canRun = () => false;
      await f.service.runAutomaticMilkTea(f.deps);
      assert.equal(f.calls.length, 0); assert.equal(autoCheckRows.length, before, 'YIELD must not produce a failure log');
    } finally { f.close(); }
  }
  { // 正常成功轮次：零失败日志，收益链照常。
    const f = await fixture({ milk_tea_auto_work: true });
    try {
      const before = autoCheckRows.length;
      await f.service.runAutomaticMilkTea(f.deps);
      assert.equal(autoCheckRows.length, before, 'successful round logs no failure');
      assert.ok(f.writes().includes(64));
    } finally { f.close(); }
  }
});

test('subprocess default logger keeps failureReason readable on disk with zero secret leakage', () => {
  const childRoot = fixturePath('diagnostic-logger-child');
  assert.equal(path.dirname(childRoot), path.resolve(process.env.FARM_DATA_DIR));
  fs.mkdirSync(childRoot, { mode: 0o700 });
  const baselinePath = require.resolve('./milk-tea-autonomy-baseline.test.js');
  const script = [
    'const fs=require("node:fs"),path=require("node:path");',
    `const {fixture}=require(${JSON.stringify(baselinePath)});`,
    '(async()=>{',
    '  const f=await fixture({milk_tea_auto_work:true});',
    '  f.hook(async()=>{throw Object.assign(new Error("SYNTHETIC_SECRET_MILK_MESSAGE"),{business:true,code:"SEASON_WISH_MILK_TEA_SYNTHETIC_SECRET_CODE"});});',
    '  await f.service.runAutomaticMilkTea(f.deps);',
    '  f.close();',
    // 既有具名限时轮询：等真实 winston sink 落盘（非任意 sleep）。
    '  const guard=setTimeout(()=>process.exit(2),10000);',
    '  const timer=setInterval(()=>{',
    '    const root=path.join(process.env.FARM_DATA_DIR,"logs");',
    '    if(!fs.existsSync(root))return;',
    '    const names=fs.readdirSync(root).filter(n=>n.startsWith("combined-")&&n.endsWith(".log"));',
    '    if(!names.length)return;',
    '    const files=names.map(n=>[n,fs.readFileSync(path.join(root,n),"utf8")]);',
    '    const row=files.flatMap(([,text])=>text.split("\\n").filter(Boolean)).map(l=>{try{return JSON.parse(l)}catch{return null}})',
    '      .find(x=>x&&x.event==="milk_tea_auto_check"&&x.result==="error");',
    '    if(row){clearInterval(timer);clearTimeout(guard);',
    '      console.log(JSON.stringify({dir:process.env.FARM_DATA_DIR,row,files}));process.exit(0);}',
    '  },20);',
    '})().catch(err=>{console.error(String((err&&err.stack)||err));process.exit(3);});',
  ].join('\n');
  const env = { ...process.env, NODE_OPTIONS: '', TMPDIR: childRoot };
  delete env.NODE_TEST_CONTEXT; delete env.FARM_LOG_DIR; // 子进程用真实默认 sink（非测试抑制模式）
  try {
    const result = require('node:child_process').spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const envelope = result.stdout.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).find(x => x && x.row);
    assert.ok(envelope, 'subprocess reported the disk row');
    assert.ok(path.resolve(envelope.dir).startsWith(childRoot + path.sep), 'child runtime remains in the prevalidated fixture');
    const { row, files } = envelope;
    assert.equal(row.event, 'milk_tea_auto_check'); assert.equal(row.result, 'error');
    assert.equal(row.failureReason, 'business_rejected', 'failureReason must survive the default sink un-redacted');
    assert.ok(!('code' in row), 'old dynamic code field must not exist on disk');
    assert.equal(JSON.stringify(row).includes('[REDACTED]'), false);
    assert.ok(files.length >= 1, 'combined log actually written');
    for (const [name, text] of files) assert.equal(text.includes('SYNTHETIC_SECRET'), false, `no secret in ${name}`);
    assert.equal(result.stdout.includes('SYNTHETIC_SECRET'), false);
    assert.equal(result.stderr.includes('SYNTHETIC_SECRET'), false, 'console transport output stays clean too');
  } finally {
    fs.rmSync(childRoot, { recursive: true, force: true });
    assert.equal(fs.existsSync(childRoot), false, 'child logs are removed after success or failure');
  }
});
