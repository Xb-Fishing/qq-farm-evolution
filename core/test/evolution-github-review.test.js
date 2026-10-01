'use strict';
// 单 Agent GitHub 修复复核回归：远端/本地基线、隔离快照、schema 严格解析、回执缓存
// 与 0600 落盘。全部外部依赖注入替身：不联网、不跑真实 git、不启动任何 Agent CLI。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 导入隔离：加载业务模块前把数据目录/私有配置指向一次性目录，结束后恢复并清理。
const importDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-gh-review-import-'));
const previousDataDir = process.env.FARM_DATA_DIR;
const previousPrivateConfig = process.env.FARM_PRIVATE_CONFIG_FILE;
process.env.FARM_DATA_DIR = importDataDir;
process.env.FARM_PRIVATE_CONFIG_FILE = path.join(importDataDir, 'none.json');
test.after(() => {
  if (previousDataDir === undefined) delete process.env.FARM_DATA_DIR;
  else process.env.FARM_DATA_DIR = previousDataDir;
  if (previousPrivateConfig === undefined) delete process.env.FARM_PRIVATE_CONFIG_FILE;
  else process.env.FARM_PRIVATE_CONFIG_FILE = previousPrivateConfig;
  fs.rmSync(importDataDir, { recursive: true, force: true });
});

const review = require('../src/services/evolution-github-review');

const REV = 'c'.repeat(40);
const FP = 'd'.repeat(64);
const RECEIPTS = 'evolution-github-review-receipts.json';

const issue = (number, fingerprint = FP) => ({
  number, title: `问题 ${number}`, body: '描述', author: 'reporter',
  comments: [], fingerprint, commentsTruncated: false, omittedComments: 0,
});
const receiptJson = (target, extra = {}) => JSON.stringify({
  approved: true, issue: target.number, status: 'fixed', repo: '', revision: REV,
  fingerprint: target.fingerprint, cause: '启动崩溃', change: '修复解析', verification: '回归通过',
  ...extra,
});

function tmpDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-gh-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function okDeps(overrides = {}) {
  const deps = {
    remoteHead: async () => REV,
    localHeadAndClean: () => ({ head: REV, clean: true }),
    runValidation: async () => {},
    checkout: async (dir) => {
      fs.mkdirSync(path.join(dir, 'core'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'core', 'package.json'), '{}');
    },
    runAgent: async ({ issue: target, repo }) => receiptJson(target, { repo }),
    ...overrides,
  };
  return deps;
}

const readReceiptsFile = dataDir => {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, RECEIPTS), 'utf8')); } catch { return null; }
};

test('parseReviewOutput：严格白名单解析，指纹必须钉住批次快照的报告版本', () => {
  const issues = [issue(2)];
  const base = { approved: true, issue: 2, status: 'fixed', repo: '', revision: REV, fingerprint: FP,
    cause: 'c', change: 'ch', verification: 'v' };
  const parsed = review.parseReviewOutput(JSON.stringify(base), { issues, revision: REV });
  assert.equal(parsed.approved, true);
  assert.equal(parsed.issue, 2);
  assert.equal(parsed.fingerprint, FP);
  assert.equal(parsed.revision, REV);

  for (const [name, bad] of [
    ['非 JSON', '我认为修好了'],
    ['多余字段', { ...base, extra: 1 }],
    ['缺指纹', { ...base, fingerprint: undefined }],
    ['指纹非 64hex', { ...base, fingerprint: 'zzz' }],
    ['指纹大写', { ...base, fingerprint: FP.toUpperCase() }],
    ['与批次指纹不符', { ...base, fingerprint: 'f'.repeat(64) }],
    ['issue 不在批次', { ...base, issue: 999 }],
    ['repo 缺失', { ...base, repo: undefined }],
    ['repo 不符', { ...base, repo: 'owner/other-farm' }],
    ['revision 缺失', { ...base, revision: undefined }],
    ['revision 不符', { ...base, revision: 'f'.repeat(40) }],
    ['状态非法', { ...base, status: 'merged' }],
    ['approved 非布尔', { ...base, approved: 'yes' }],
    ['数组输出', [base]],
  ]) {
    assert.equal(review.parseReviewOutput(typeof bad === 'string' ? bad : JSON.stringify(bad), { issues, revision: REV }), null, name);
  }
  // 可选字段缺省合法；note/cause 等必须是字符串。
  assert.equal(review.parseReviewOutput(JSON.stringify({ ...base, cause: undefined, change: undefined, verification: undefined }), { issues, revision: REV }).cause, '');
  assert.equal(review.parseReviewOutput(JSON.stringify({ ...base, note: 5 }), { issues, revision: REV }), null);
});

test('runGithubFixReview：基线全对齐才产出回执（0600），同 issue+revision 命中缓存不重跑', async (t) => {
  const dataDir = tmpDataDir(t);
  const agentCalls = [];
  const deps = okDeps({ runAgent: async ({ issue: target }) => { agentCalls.push(target.number); return receiptJson(target); } });
  const first = await review.runGithubFixReview({ revision: REV, agent: 'claude', issues: [issue(2), issue(3, 'e'.repeat(64))], dataDir }, deps);
  assert.equal(first.ok, true);
  assert.equal(first.cached, undefined);
  assert.deepEqual(first.receipts.map(item => item.issue), [2, 3]);
  assert.equal(first.receipts[0].reviewedBy, 'claude');
  assert.ok(first.receipts[0].reviewedAt > 0);
  const persisted = readReceiptsFile(dataDir);
  assert.deepEqual(Object.keys(persisted.receipts).sort(), [`:2:${FP}:${REV}`, `:3:${'e'.repeat(64)}:${REV}`]);
  assert.equal(fs.statSync(path.join(dataDir, RECEIPTS)).mode & 0o777, 0o600, '回执私有 0600');

  const cached = await review.runGithubFixReview({ revision: REV, agent: 'claude', issues: [issue(2)], dataDir }, deps);
  assert.equal(cached.ok, true);
  assert.equal(cached.cached, true);
  assert.deepEqual(agentCalls, [2, 3], '缓存命中不再调用复核 Agent');
});

test('runGithubFixReview：任何基线失败整体拒绝，绝不部分放行、不落回执', async (t) => {
  const cases = [
    { name: 'invalid_revision', patch: { revision: 'zzz' }, expected: 'invalid_revision' },
    { name: 'no_issues', patch: { issues: [] }, expected: 'no_issues' },
    { name: 'revision_not_published', deps: { remoteHead: async () => 'f'.repeat(40) }, expected: 'revision_not_published' },
    { name: 'source_changed_pre', deps: { localHeadAndClean: () => ({ head: 'f'.repeat(40), clean: true }) }, expected: 'source_changed' },
    { name: 'validation_failed', deps: { runValidation: async () => { throw new Error('tests failed'); } }, expected: 'validation_failed' },
    { name: 'checkout_failed', deps: { checkout: async () => { throw new Error('archive failed'); } }, expected: 'checkout_failed' },
    { name: 'agent_failed', deps: { runAgent: async () => { throw new Error('cli down'); } }, expected: 'agent_failed' },
    { name: 'invalid_output', deps: { runAgent: async () => '看起来修好了' }, expected: 'invalid_output' },
    { name: 'head_changed', deps: {}, expected: 'head_changed' },
    { name: 'source_changed_post', deps: {}, expected: 'source_changed' },
  ];
  for (const item of cases) {
    const dataDir = tmpDataDir(t);
    let remoteCalls = 0;
    let localCalls = 0;
    const deps = okDeps({
      ...item.deps,
      ...(item.name === 'head_changed' ? { remoteHead: async () => { remoteCalls += 1; return remoteCalls === 1 ? REV : 'f'.repeat(40); } } : {}),
      ...(item.name === 'source_changed_post' ? { localHeadAndClean: () => { localCalls += 1; return localCalls === 1 ? { head: REV, clean: true } : { head: REV, clean: false }; } } : {}),
      ...(item.name === 'source_changed_pre' ? { localHeadAndClean: () => ({ head: 'f'.repeat(40), clean: true }) } : {}),
    });
    const result = await review.runGithubFixReview({ revision: REV, agent: 'claude', issues: [issue(2)], dataDir, ...item.patch }, deps);
    assert.equal(result.ok, false, item.name);
    assert.equal(result.reason, item.expected, item.name);
    assert.equal(fs.existsSync(path.join(dataDir, RECEIPTS)), false, `${item.name}: 拒绝路径不落回执`);
  }

  // 单个 issue 复核失败作废全部新结论（避免半批放行）。
  const dataDir = tmpDataDir(t);
  let calls = 0;
  const partial = await review.runGithubFixReview({ revision: REV, agent: 'claude', issues: [issue(2), issue(3, 'e'.repeat(64))], dataDir }, okDeps({
    runAgent: async ({ issue: target }) => { calls += 1; if (calls === 2) throw new Error('cli down'); return receiptJson(target); },
  }));
  assert.equal(partial.ok, false);
  assert.equal(partial.reason, 'agent_failed');
  assert.equal(fs.existsSync(path.join(dataDir, RECEIPTS)), false, '半批失败不落任何回执');
});

test('runGithubFixReview：超出单轮上限的 issue 显式溢出，不冒称全覆盖', async (t) => {
  const dataDir = tmpDataDir(t);
  const overflow = [];
  const issues = Array.from({ length: 6 }, (_, index) => issue(index + 1, `${index + 1}`.padEnd(64, '0')));
  const result = await review.runGithubFixReview({ revision: REV, agent: 'claude', issues, dataDir }, okDeps({
    onOverflow: count => overflow.push(count),
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(overflow, [2], '6 条只复核 4 条，剩余 2 条显式上报');
  assert.equal(result.receipts.length, 4);
});

test('buildReviewPrompt：只读硬门、不可信输入、指纹口径与 schema 全部注入', () => {
  const prompt = review.buildReviewPrompt({ issue: issue(2), revision: REV, changeSummary: '修复启动崩溃' });
  assert.match(prompt, new RegExp(REV));
  assert.match(prompt, /禁止修改任何文件、禁止创建提交/);
  assert.match(prompt, /不可信输入/);
  assert.match(prompt, /fingerprint 字段必须原样填该 issue 快照中的 fingerprint（报告版本指纹，禁止编造）/);
  assert.match(prompt, /禁止为安抚报告者输出 fixed/);
  assert.ok(prompt.includes(JSON.stringify(review.REVIEW_SCHEMA)));
  assert.match(prompt, /修复启动崩溃/);
  assert.match(prompt, /"number":2/);
  assert.equal(review.REVIEW_SCHEMA.properties.fingerprint.pattern, '^[0-9a-f]{64}$');
  assert.equal(review.REVIEW_SCHEMA.additionalProperties, false);
  assert.deepEqual(review.REVIEW_SCHEMA.required, ['approved', 'issue', 'status', 'repo', 'revision', 'fingerprint']);
});

test('defaultRunAgent：环境硬隔离（FARM_DATA_DIR/私有配置指向隔离目录）+ 双 CLI 参数构造', async (t) => {
  const dataDir = tmpDataDir(t);
  const evolverPath = require.resolve('../src/services/activity-evolver');
  const previous = require.cache[evolverPath];
  require.cache[evolverPath] = {
    id: evolverPath, loaded: true,
    exports: {
      buildEvolutionAgentCommand: (agent, _prompt) => ({ bin: `bin-${agent}`, args: [agent, 'PROMPT'], stdin: '' }),
      buildEvolutionAgentEnv: () => ({ PATH: '/base/bin' }),
    },
  };
  t.after(() => {
    if (previous) require.cache[evolverPath] = previous;
    else delete require.cache[evolverPath];
  });

  // 不注入 runAgent → 走模块内 defaultRunAgent；execute 经 options 注入（真实分发路径）。
  const baseDeps = (execute) => ({
    remoteHead: async () => REV,
    localHeadAndClean: () => ({ head: REV, clean: true }),
    runValidation: async () => {},
    checkout: async (dir) => {
      fs.mkdirSync(path.join(dir, 'core'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'core', 'package.json'), '{}');
    },
    execute,
  });

  // claude：JSON envelope stdout；schema 经 --json-schema 内联传入。
  const claudeRuns = [];
  const claude = await review.runGithubFixReview({ revision: REV, agent: 'claude', issues: [issue(2)], dataDir }, baseDeps((bin, args, opts) => {
    claudeRuns.push({ bin, args, env: opts.env, cwd: opts.cwd });
    return Promise.resolve(JSON.stringify({
      is_error: false, subtype: 'success',
      result: { approved: true, issue: 2, status: 'fixed', repo: '', revision: REV, fingerprint: FP },
    }));
  }));
  assert.equal(claude.ok, true, 'claude 默认链路产出有效回执');
  assert.equal(claude.receipts[0].fingerprint, FP);
  const claudeRun = claudeRuns[0];
  assert.equal(claudeRun.bin, 'bin-claude');
  assert.equal(claudeRun.cwd.includes('farm-github-review-'), true, '复核只看隔离快照目录');
  assert.ok(claudeRun.args.includes('--output-format') && claudeRun.args.includes('json'));
  assert.ok(claudeRun.args.includes('--json-schema'));
  assert.equal(claudeRun.args[claudeRun.args.indexOf('--json-schema') + 1], JSON.stringify(review.REVIEW_SCHEMA));
  const reviewHome = path.resolve(claudeRun.cwd, '..');
  assert.equal(claudeRun.env.FARM_DATA_DIR, path.join(reviewHome, 'runtime'), '生产数据目录被覆盖为独占宿主内的运行目录');
  assert.equal(claudeRun.env.FARM_PRIVATE_CONFIG_FILE, path.join(reviewHome, 'review-private-config.json'), '私有配置被替换');
  assert.equal(path.basename(claudeRun.cwd), 'source', '源码快照在独占宿主的子目录');
  assert.equal(fs.existsSync(reviewHome), false, '复核后连同运行产物清理整个宿主目录');

  // codex：schema 落隔离目录文件，结果从 --output-last-message 文件读回。
  const codexRuns = [];
  const codex = await review.runGithubFixReview({ revision: REV, agent: 'codex', issues: [issue(3, 'e'.repeat(64))], dataDir }, baseDeps((bin, args, opts) => {
    const schemaFile = args[args.indexOf('--output-schema') + 1];
    codexRuns.push({ bin, args, env: opts.env, cwd: opts.cwd, schema: fs.readFileSync(schemaFile, 'utf8').trim() });
    const outputFile = args[args.indexOf('--output-last-message') + 1];
    fs.writeFileSync(outputFile, receiptJson(issue(3, 'e'.repeat(64))));
    return Promise.resolve('');
  }));
  assert.equal(codex.ok, true, 'codex 默认链路产出有效回执');
  const codexRun = codexRuns[0];
  assert.equal(codexRun.bin, 'bin-codex');
  assert.ok(codexRun.args.includes('--output-schema'));
  const codexSchemaFile = codexRun.args[codexRun.args.indexOf('--output-schema') + 1];
  assert.equal(codexSchemaFile.startsWith(path.dirname(codexRun.cwd)), true, 'schema 文件写在隔离宿主目录，不进快照');
  assert.equal(codexRun.schema, JSON.stringify(review.REVIEW_SCHEMA));
  assert.equal(fs.existsSync(path.dirname(codexRun.cwd)), false, 'schema/输出/配置均随宿主清理');
});

test('超时必须先杀并回收复核子进程（SIGTERM→SIGKILL 预案），再结束等待', async (t) => {
  const dataDir = tmpDataDir(t);
  const kills = [];
  // 模块的计时器全部 unref（不拖住生产进程）：测试侧保持一个 ref'd 句柄让超时能到达。
  const keepAlive = setTimeout(() => {}, 5000);
  t.after(() => clearTimeout(keepAlive));
  const result = await review.runGithubFixReview({ revision: REV, agent: 'claude', issues: [issue(2)], dataDir }, {
    remoteHead: async () => REV,
    localHeadAndClean: () => ({ head: REV, clean: true }),
    runValidation: async () => {},
    checkout: async (dir) => {
      fs.mkdirSync(path.join(dir, 'core'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'core', 'package.json'), '{}');
    },
    agentTimeoutMs: 40,    execute: (bin, args, opts) => new Promise((resolve, reject) => {
      // 卡死的复核进程：只有被 kill 才结束（close 事件 reject），自身永不完成。
      opts.childRef.kill = signal => { kills.push(signal); reject(new Error(`killed:${signal}`)); };
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'agent_failed');
  assert.ok(kills.includes('SIGTERM'), '超时先发 SIGTERM 回收子进程');
});

test('快照完整性：复核 Agent 写快照（改内容/加文件）即使输出 approved+fixed 也全部作废', async (t) => {
  // 场景 A：直接改 core/package.json 内容后谎报已修复。
  const dataDirA = tmpDataDir(t);
  const tamperContent = okDeps({
    runAgent: async ({ issue: target, dir }) => {
      fs.appendFileSync(path.join(dir, 'core', 'package.json'), '\n// injected');
      return receiptJson(target);
    },
  });
  const a = await review.runGithubFixReview({ revision: REV, agent: 'claude', issues: [issue(2)], dataDir: dataDirA }, tamperContent);
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'snapshot_changed', '在隔离快照内写入 = 伪造修复证据');
  assert.equal(fs.existsSync(path.join(dataDirA, RECEIPTS)), false, '作废路径不落任何回执');

  // 场景 B：新增源码文件（评审产物伪装成已有修复）。
  const dataDirB = tmpDataDir(t);
  const tamperAdd = okDeps({
    runAgent: async ({ issue: target, dir }) => {
      fs.mkdirSync(path.join(dir, 'core', 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'core', 'src', 'fabricated-fix.js'), 'module.exports = {};\n');
      return receiptJson(target);
    },
  });
  const b = await review.runGithubFixReview({ revision: REV, agent: 'claude', issues: [issue(2)], dataDir: dataDirB }, tamperAdd);
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'snapshot_changed');
  assert.equal(fs.existsSync(path.join(dataDirB, RECEIPTS)), false);

  // 场景 C：只读复核（不写快照）照常产出回执——完整性检查不误伤正常路径。
  const dataDirC = tmpDataDir(t);
  const c = await review.runGithubFixReview({ revision: REV, agent: 'claude', issues: [issue(2)], dataDir: dataDirC }, okDeps());
  assert.equal(c.ok, true);
  assert.equal(c.receipts[0].fingerprint, FP);
});

test('回执钉死 仓库+issue+报告指纹+提交：旧指纹/别的仓库的回执不算已复核', async (t) => {
  const dataDir = tmpDataDir(t);
  const OLD_FP = '9'.repeat(64);
  // 预置旧回执：同一 issue+提交、但指纹是旧报告版本（仓库 ''）。
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, RECEIPTS), JSON.stringify({
    version: 1,
    receipts: {
      [`:2:${OLD_FP}:${REV}`]: {
        approved: true, issue: 2, status: 'fixed', revision: REV, repo: '',
        fingerprint: OLD_FP, cause: '旧报告', change: '', verification: '',
        reviewedBy: 'claude', reviewedAt: 1,
      },
    },
  }));
  const calls = [];
  const deps = okDeps({ runAgent: async ({ issue: target, repo }) => { calls.push(target.fingerprint); return receiptJson(target, { repo }); } });

  // 新报告版本（指纹不同）：旧回执不得覆盖 → 必须真实复核。
  const fresh = await review.runGithubFixReview({ revision: REV, agent: 'claude', issues: [issue(2)], dataDir }, deps);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.cached, undefined, '旧指纹回执不命中缓存');
  assert.deepEqual(calls, [FP]);

  // 同一指纹再次进入：命中缓存，不再跑复核。
  const cached = await review.runGithubFixReview({ revision: REV, agent: 'claude', issues: [issue(2)], dataDir }, deps);
  assert.equal(cached.ok, true);
  assert.equal(cached.cached, true);
  assert.deepEqual(calls, [FP], '缓存命中不再调用复核 Agent');
  assert.deepEqual(cached.receipts.map(item => item.issue), [2], '缓存路径只返回当前批次的回执');

  // 同 issue+指纹+提交但换了仓库：回执按仓库隔离，必须重新复核。
  const otherRepo = await review.runGithubFixReview({ revision: REV, agent: 'claude', repo: 'owner/other-farm', issues: [issue(2)], dataDir }, deps);
  assert.equal(otherRepo.ok, true);
  assert.equal(otherRepo.cached, undefined, '别的仓库的回执不算数');
  assert.deepEqual(calls, [FP, FP]);
  const persisted = readReceiptsFile(dataDir);
  assert.ok(persisted.receipts[`owner/other-farm:2:${FP}:${REV}`], '回执按仓库+指纹+提交落盘');
  assert.ok(persisted.receipts[`:2:${OLD_FP}:${REV}`], '旧回执保留原键，不串用');
});

test('单飞：同一发布的并发复核只跑一次真实执行，完成后缓存接管', async (t) => {
  const dataDir = tmpDataDir(t);
  let started = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const deps = okDeps({
    runAgent: async ({ issue: target }) => {
      started += 1;
      await gate;
      return receiptJson(target);
    },
  });
  const args = { revision: REV, agent: 'claude', issues: [issue(2)], dataDir };
  const first = review.runGithubFixReview(args, deps);
  const second = review.runGithubFixReview({ ...args }, deps);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, 1, '重叠触发的父进程挂钩共享同一次复核执行');
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(started, 1);
  // 落盘后再次进入：走回执缓存，同样零次执行。
  const third = await review.runGithubFixReview(args, deps);
  assert.equal(third.cached, true);
  assert.equal(started, 1);
});

test('复核回执必须属于真正注入 prompt 的 issue/指纹/仓库/提交，不能冒领同批其他 issue', async (t) => {
  const targets = [issue(2), issue(3)];
  for (const [name, output] of [
    ['同批错误 issue', receiptJson(targets[1], { repo: 'owner/farm' })],
    ['错误指纹', receiptJson(targets[0], { repo: 'owner/farm', fingerprint: 'e'.repeat(64) })],
    ['错误仓库', receiptJson(targets[0], { repo: 'owner/other-farm' })],
    ['错误提交', receiptJson(targets[0], { repo: 'owner/farm', revision: 'a'.repeat(40) })],
  ]) {
    const dataDir = tmpDataDir(t);
    const prompted = [];
    const result = await review.runGithubFixReview({ revision: REV, repo: 'owner/farm', issues: targets, dataDir }, okDeps({
      runAgent: async ({ issue: target, prompt }) => { prompted.push(target.number); assert.match(prompt, /repo 字段必须原样填 "owner\/farm"/); return output; },
    }));
    assert.equal(result.ok, false, name);
    assert.equal(result.reason, 'invalid_output', name);
    assert.deepEqual(prompted, [2], `${name}：第一个 issue 的错误输出立即拒绝`);
    assert.equal(fs.existsSync(path.join(dataDir, RECEIPTS)), false, `${name}：不落回执`);
  }
});

test('回执保存后尚未入队就重启：4 条精确缓存 + 1 条新复核必须全部返回', async (t) => {
  const dataDir = tmpDataDir(t);
  const repo = 'owner/farm';
  const targets = Array.from({ length: 5 }, (_, index) => issue(index + 1, `${index + 1}`.padEnd(64, '0')));
  const called = [];
  const deps = okDeps({ runAgent: async ({ issue: target }) => { called.push(target.number); return receiptJson(target, { repo }); } });
  const args = { revision: REV, repo, issues: targets, dataDir };
  const beforeCrash = await review.runGithubFixReview(args, deps);
  assert.equal(beforeCrash.ok, true);
  assert.deepEqual(beforeCrash.receipts.map(receipt => receipt.issue), [1, 2, 3, 4]);
  assert.equal(Object.keys(readReceiptsFile(dataDir).receipts).length, 4);
  assert.equal(fs.existsSync(path.join(dataDir, 'evolution-github-outbox.json')), false, '模拟回执已保存、调用方尚未入队');

  const recovered = await review.runGithubFixReview(args, deps);
  assert.equal(recovered.ok, true);
  assert.deepEqual(called, [1, 2, 3, 4, 5], '只执行第五条新复核');
  assert.deepEqual(recovered.receipts.map(receipt => receipt.issue), [1, 2, 3, 4, 5], '缓存与新回执都交给调用方恢复入队');
  for (const receipt of recovered.receipts) {
    assert.equal(receipt.repo, repo);
    assert.equal(receipt.revision, REV);
    assert.equal(receipt.fingerprint, targets.find(target => target.number === receipt.issue).fingerprint);
  }
});

test('并发默认复核使用独占宿主/schema/输出/运行目录，一个快照写入不会污染另一个', async (t) => {
  const evolverPath = require.resolve('../src/services/activity-evolver');
  const previous = require.cache[evolverPath];
  require.cache[evolverPath] = {
    id: evolverPath, loaded: true,
    exports: {
      buildEvolutionAgentCommand: (agent, prompt) => ({ bin: `mock-${agent}`, args: ['exec', '-'], stdin: prompt }),
      buildEvolutionAgentEnv: () => ({ PATH: '/mock/bin', FARM_DATA_DIR: '/unused-production-path', FARM_PRIVATE_CONFIG_FILE: '/unused-production-config' }),
    },
  };
  t.after(() => {
    if (previous) require.cache[evolverPath] = previous;
    else delete require.cache[evolverPath];
  });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const runs = [];
  const executeFor = (target, mutate) => async (_bin, args, opts) => {
    const schema = args[args.indexOf('--output-schema') + 1];
    const output = args[args.indexOf('--output-last-message') + 1];
    const home = path.dirname(opts.cwd);
    runs.push({ schema, output, home, cwd: opts.cwd, env: opts.env });
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    assert.equal(fs.statSync(schema).mode & 0o777, 0o600);
    assert.equal(opts.env.FARM_DATA_DIR, path.join(home, 'runtime'));
    assert.equal(opts.env.FARM_PRIVATE_CONFIG_FILE, path.join(home, 'review-private-config.json'));
    assert.deepEqual(JSON.parse(fs.readFileSync(opts.env.FARM_PRIVATE_CONFIG_FILE, 'utf8')), {});
    fs.writeFileSync(path.join(opts.env.FARM_DATA_DIR, 'review-log.txt'), 'isolated runtime');
    await gate;
    assert.equal(fs.readFileSync(path.join(opts.cwd, 'core', 'package.json'), 'utf8'), '{}', '另一个快照的写入不泄漏');
    if (mutate) fs.appendFileSync(path.join(opts.cwd, 'core', 'package.json'), '\n// invented fix');
    fs.writeFileSync(output, receiptJson(target));
    return '';
  };
  const defaultDeps = execute => {
    const deps = okDeps({ execute });
    delete deps.runAgent;
    return deps;
  };
  const a = review.runGithubFixReview({ revision: REV, agent: 'codex', issues: [issue(2)], dataDir: tmpDataDir(t) }, defaultDeps(executeFor(issue(2), true)));
  const b = review.runGithubFixReview({ revision: REV, agent: 'codex', issues: [issue(2)], dataDir: tmpDataDir(t) }, defaultDeps(executeFor(issue(2), false)));
  while (runs.length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(runs[0].home, runs[1].home);
  assert.notEqual(runs[0].schema, runs[1].schema);
  assert.notEqual(runs[0].output, runs[1].output);
  assert.notEqual(runs[0].env.FARM_DATA_DIR, runs[1].env.FARM_DATA_DIR);
  assert.notEqual(runs[0].env.FARM_PRIVATE_CONFIG_FILE, runs[1].env.FARM_PRIVATE_CONFIG_FILE);
  release();
  const [tampered, unchanged] = await Promise.all([a, b]);
  assert.equal(tampered.ok, false);
  assert.equal(tampered.reason, 'snapshot_changed');
  assert.equal(unchanged.ok, true);
  assert.equal(unchanged.receipts[0].issue, 2);
  for (const run of runs) assert.equal(fs.existsSync(run.home), false, '成功/拒绝两条路径都清理独占宿主与全部产物');
});

test('异步复核保存输入快照：调用方随后修改 issue 不能改变被批准的报告版本', async (t) => {
  const dataDir = tmpDataDir(t);
  const target = issue(2);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const resultPromise = review.runGithubFixReview({ revision: REV, issues: [target], dataDir }, okDeps({
    remoteHead: async () => { await gate; return REV; },
    runAgent: async ({ issue: captured }) => {
      assert.equal(captured.fingerprint, FP);
      assert.equal(captured.body, '描述');
      return receiptJson(captured);
    },
  }));
  target.fingerprint = 'a'.repeat(64);
  target.body = '未经复核的不同问题';
  release();
  const result = await resultPromise;
  assert.equal(result.ok, true);
  assert.equal(result.receipts[0].fingerprint, FP);
});
