'use strict';
// GitHub issues 反馈路由回归：全部外部效果（HTTPS/gh CLI、git 远端、飞书、时间）注入
// 替身；断言采集/去重/门控/发件箱/模板/锁语义。不联网、不写真实仓库、不启动任何 Agent。
// 本文件必须最先加载被测模块（见首个用例：模块加载不得触发进化器或网络副作用）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// 导入隔离：加载任何业务模块前先把数据目录/私有配置指向一次性目录，结束后恢复并清理，
// 绝不把全局变量泄漏给其他测试进程或真实数据目录。
const importDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-gh-feedback-import-'));
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

const feedback = require('../src/services/evolution-github-feedback');
// normalizeGithubResolutions 的独立单元断言放在本文件（依赖新模块，不做旧源码基线对照）。
const { normalizeGithubResolutions } = require('../src/services/evolution-team');

const REPO = 'owner/example-farm';
const REV = 'c'.repeat(40);
const REV2 = 'e'.repeat(40);
const FP64 = 'd'.repeat(64);
const RESOLUTIONS = [
  { issue: 2, status: 'fixed', fingerprint: FP64, note: '启动崩溃已修复' },
  { issue: 7, status: 'in_progress' },
];
const ISSUE = 2;
const NOW = Date.parse('2026-10-01T08:00:00Z');
const LIST_PATH = `/repos/${REPO}/issues?state=open&sort=updated&direction=desc&per_page=30`;
const commentsPath = (issue, page) => `/repos/${REPO}/issues/${issue}/comments?per_page=30&page=${page}`;
const postPath = issue => `/repos/${REPO}/issues/${issue}/comments`;

function makeConfig(overrides = {}) {
  return {
    evolutionGithubFeedback: {
      enabled: true, repo: REPO, ownerLogin: 'owner', token: 'ghp_testtoken01',
      publicActions: ['git_pull'], ...overrides,
    },
  };
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-github-feedback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const comment = (id, author, body, createdAt = '2026-09-01T00:00:00Z') => ({
  id, user: { login: author }, body, created_at: createdAt,
});

function githubApi(pages) {
  const calls = [];
  const request = async (apiPath, { method = 'GET', body } = {}) => {
    calls.push({ apiPath, method, body });
    const handler = pages[apiPath];
    // 默认已认证登录 = owner（自有身份判定的 API 侧来源）。
    if (!handler && apiPath === '/user') return { statusCode: 200, body: { login: 'owner' } };
    if (!handler) return { statusCode: 404, body: null };
    const value = await (typeof handler === 'function' ? handler(method, body) : handler);
    if (value instanceof Error) throw value;
    if (value && typeof value === 'object' && !Array.isArray(value) && 'statusCode' in value) return value;
    return { statusCode: 200, body: value };
  };
  return { calls, request };
}

function collectOnce(t, { request, dataDir, config = makeConfig(), now = () => NOW }) {
  return feedback.collectGithubFeedback({ request, config, dataDir, now });
}

/** issue 详情（comments 数量 + updated_at 是分页与采纳判定的元数据）。 */
const detail = (issue, overrides = {}) => ({
  number: issue.number ?? issue, title: issue.title ?? 't', body: issue.body ?? 'b',
  state: 'open', user: { login: issue.author ?? 'reporter' },
  comments: Array.isArray(issue.comments) ? issue.comments.length : (issue.comments ?? 0),
  updated_at: issue.updatedAt ?? '2026-09-01T00:00:00Z',
  ...overrides,
});

/** 按实现语义同构的报告指纹（own=owner：自有送达评论被排除，伪造者不算）。 */
const OWN = new Set(['owner']);
const loginOf = c => String(c.author ?? c.user?.login ?? '').toLowerCase();
const isOwnDelivery = c => /<!--\s*farm-bot-feedback\s+\d+\s+[0-9a-f]{7,40}\s*-->/i.test(c.body) && OWN.has(loginOf(c));
const issueFp = issue => crypto.createHash('sha256').update(JSON.stringify({
  number: issue.number, title: issue.title, body: issue.body, reporter: issue.author,
  comments: issue.comments.filter(c => !isOwnDelivery(c)).sort((l, r) => l.id - r.id)
    .map(c => [loginOf(c), c.body]),
})).digest('hex');

const PENDING_ISSUE = { number: ISSUE, title: '启动失败', body: 'bot 起不来', author: 'reporter', comments: [] };

/** 单 issue 详情+评论页（评论按升序 API 提供，最新在最后一页）。 */
function detailPages(issueSpec) {
  const comments = issueSpec.comments ?? [];
  const pages = { [`/repos/${REPO}/issues/${issueSpec.number}`]: detail(issueSpec) };
  const lastPage = Math.max(1, Math.ceil(comments.length / 30));
  for (let page = 1; page <= lastPage; page += 1) {
    pages[commentsPath(issueSpec.number, page)] = comments.slice((page - 1) * 30, page * 30);
  }
  return pages;
}

const listItem = issueSpec => ({ number: issueSpec.number, title: issueSpec.title, body: issueSpec.body, user: { login: issueSpec.author } });

/** 单 issue 完整采集页（含列表页）。 */
function issuePages(issueSpec, overrides = {}) {
  return { [LIST_PATH]: [listItem(issueSpec)], ...detailPages(issueSpec), ...overrides };
}

/** 多 issue 采集页。 */
function collectPages(specs, overrides = {}) {
  const pages = { [LIST_PATH]: specs.map(listItem) };
  for (const spec of specs) Object.assign(pages, detailPages(spec));
  return { ...pages, ...overrides };
}

async function freshOutbox(t, pages, { fingerprint } = {}) {
  const dataDir = tmpDir(t);
  const api = githubApi(pages);
  await feedback.enqueueGithubResolution({
    dataDir, issue: ISSUE, revision: REV, issueFingerprint: fingerprint || issueFp(PENDING_ISSUE),
    capturedAt: NOW, source: 'dual_review', reviewedBy: 'codex',
  }, { config: makeConfig() });
  return { dataDir, api };
}

const drainOptions = (dataDir, api, overrides = {}) => ({
  config: makeConfig(), dataDir, request: api.request,
  publishedCheck: async () => true,
  sendPrivate: async () => {},
  now: () => NOW,
  ...overrides,
});

test('模块加载零副作用：不加载进化器、不在加载期发起网络', () => {
  const loadedEvolver = Object.keys(require.cache)
    .some(file => file.endsWith('activity-evolver.js'));
  assert.equal(loadedEvolver, false, '反馈模块不得在顶层依赖进化器（会形成环并拖入运行时副作用）');
});

test('normalizeGithubResolutions：合法映射保留，任何非法字段整体拒绝（单元层）', () => {
  assert.deepEqual(normalizeGithubResolutions(RESOLUTIONS), RESOLUTIONS);
  assert.deepEqual(normalizeGithubResolutions([]), [], '空数组是合法的「无结论」');
  assert.equal(normalizeGithubResolutions(undefined), null);
  assert.equal(normalizeGithubResolutions(null), null);
  for (const bad of [
    'fixed', 42, {},
    [{ issue: 0, status: 'fixed' }],
    [{ issue: 2, status: 'merged' }],
    [{ issue: 2, status: 'fixed' }], // fixed 必须携带批次报告指纹，不得缺省
    [{ issue: 2, status: 'fixed', fingerprint: 'zzz' }],
    [{ issue: 2, status: 'fixed', fingerprint: FP64.slice(0, 63) }],
    [{ issue: 2, status: 'fixed', revision: REV }], // 旧字段已废弃：映射不认提交哈希
    [{ issue: 2, status: 'fixed', note: 5 }],
    [{ issue: 2.5, status: 'fixed' }],
    [{ status: 'fixed' }],
    Array.from({ length: 9 }, () => ({ issue: 1, status: 'fixed', fingerprint: FP64 })),
    [['fixed']],
  ]) {
    assert.equal(normalizeGithubResolutions(bad), null, JSON.stringify(bad));
  }
  // note 限幅；in_progress 可不带指纹；指纹大小写归一。
  const clipped = normalizeGithubResolutions([{ issue: 2, status: 'fixed', fingerprint: FP64.toUpperCase(), note: 'x'.repeat(400) }]);
  assert.equal(clipped[0].fingerprint, FP64);
  assert.equal(clipped[0].note.length, 300);
});

test('owner 私有配置默认关闭且字段非法一律返回 null', () => {
  assert.equal(feedback.readGithubFeedbackConfig({ config: {} }), null);
  assert.equal(feedback.readGithubFeedbackConfig({ config: { other: true } }), null);
  assert.equal(feedback.readGithubFeedbackConfig({ config: { evolutionGithubFeedback: { enabled: false, repo: REPO } } }), null);
  assert.equal(feedback.readGithubFeedbackConfig({ config: { evolutionGithubFeedback: { enabled: true } } }), null);
  assert.equal(feedback.readGithubFeedbackConfig({ config: makeConfig({ repo: '../etc/passwd' }).evolutionGithubFeedback }), null);
  assert.equal(feedback.readGithubFeedbackConfig({ config: makeConfig({ repo: 'a/b__proto__' }).evolutionGithubFeedback }), null);
  assert.equal(feedback.readGithubFeedbackConfig({ config: makeConfig({ token: 'short' }).evolutionGithubFeedback }), null);
  assert.equal(feedback.readGithubFeedbackConfig({ config: makeConfig({ ownerLogin: '-bad-' }).evolutionGithubFeedback }), null);

  const cfg = feedback.readGithubFeedbackConfig({ config: makeConfig({ pollMinutes: 5, publicActions: ['git_pull', 'docker_compose', 'evil'], readmeAnchors: ['-快速开始', 'bad anchor!'], extraNote: '请看 https://evil.invalid/x' }) });
  assert.equal(cfg.repo, REPO);
  assert.equal(cfg.pollMs, 15 * 60 * 1000, '轮询下限 15 分钟');
  assert.deepEqual(cfg.publicActions, ['git_pull', 'docker_compose'], '未知动作被过滤，合法动作保留');
  assert.deepEqual(cfg.readmeAnchors, ['-快速开始'], '前导 - 的真实 Docker 锚点必须被接受');
  assert.doesNotMatch(cfg.extraNote, /evil\.invalid|https?:/i, '附加说明中的 URL 必须被脱敏/丢弃');

  const upper = feedback.readGithubFeedbackConfig({ config: makeConfig({ pollMinutes: 120 }) });
  assert.equal(upper.pollMs, 30 * 60 * 1000, '轮询上限 30 分钟');

  const defaults = feedback.readGithubFeedbackConfig({ config: { evolutionGithubFeedback: { enabled: true, repo: REPO } } });
  assert.deepEqual(defaults.publicActions, ['git_pull', 'docker_compose'], '未配置时默认给出源码+compose 两条完整更新路径');
});

test('适配器选择：无 token 用本机已认证 gh CLI（可 POST），配置 token 才走 HTTPS', async () => {
  assert.equal(feedback.pickGithubAdapter({ token: 'ghp_testtoken01' }), 'https');
  assert.equal(feedback.pickGithubAdapter({ token: '' }), 'gh_cli');

  const calls = [];
  const fakeExecFile = (bin, args, opts, callback) => {
    calls.push({ bin, args, opts });
    const child = {
      stdin: { on() {}, end(body) { calls[calls.length - 1].stdin = body; } },
      kill(signal) { calls.push({ killed: signal }); callback(Object.assign(new Error('killed'), { killed: true }), '', ''); },
    };
    if (args[1] === '/repos/o/r/issues/2/comments' && args.includes('--input')) {
      callback(null, JSON.stringify({ id: 4242 }), '');
    } else if (args[1] === '/user') {
      callback(null, JSON.stringify({ login: 'owner' }), '');
    } else if (args[1] === '/repos/o/r/missing') {
      callback(Object.assign(new Error('gh: Not Found (HTTP 404)'), { code: 1 }), '', 'gh: Not Found (HTTP 404)');
    } else if (args[1] === '/repos/o/r/slow') {
      // 模拟 execFile 的 timeout：到点杀进程，error.killed=true。
      setTimeout(() => child.kill('SIGTERM'), opts.timeout);
    }
    return child;
  };
  const cfg = { repo: 'o/r', token: '' };
  const request = feedback.createGithubRequest(cfg, { execFile: fakeExecFile });
  const posted = await request('/repos/o/r/issues/2/comments', { method: 'POST', body: { body: 'hi' } });
  assert.equal(posted.statusCode, 200, 'gh api 成功路径返回成功状态');
  assert.equal(posted.body.id, 4242);
  const post = calls[0];
  assert.equal(post.bin, 'gh');
  assert.deepEqual(post.args.slice(0, 4), ['api', '/repos/o/r/issues/2/comments', '--method', 'POST']);
  // --silent 会吞掉响应 JSON（/user、采集、送达回执全部拿不到 body）：绝不携带。
  assert.equal(post.args.includes('--silent'), false, 'gh api 不得使用 --silent');
  assert.ok(post.args.includes('--input'), 'JSON 体只经 stdin 传入');
  assert.ok(post.args.includes('-'), 'stdin 占位符是字面量 "-"');
  assert.equal(JSON.parse(post.stdin).body, 'hi');
  assert.ok(!JSON.stringify(post.args).includes('token'), '绝不把 token 拼进参数');
  assert.ok(post.opts.timeout > 0 && post.opts.timeout <= 30000, '有界超时');

  const user = await request('/user');
  assert.equal(user.body.login, 'owner');
  assert.equal(calls.find(call => call.args[1] === '/user').args.includes('--silent'), false, 'GET 同样不得 --silent');

  const missing = await request('/repos/o/r/missing');
  assert.equal(missing.statusCode, 404, 'HTTP 错误码从 stderr 类别化还原');

  await assert.rejects(() => request('/repos/o/r/slow', { method: 'GET' }), { message: 'timeout' });
});

test('采集：PR 排除、owner issue 保留、评论升序分页取最新、语义指纹含正文与编辑', async (t) => {
  const dataDir = tmpDir(t);
  const spec = { number: 3, title: '好友列表为空', body: 'v2 好友全没了', author: 'reporter', updatedAt: '2026-09-02T00:00:00Z',
    comments: [comment(10, 'someone', '同问', '2026-09-01T00:00:00Z'), comment(11, 'reporter', '补充：重启也没用', '2026-09-02T00:00:00Z')] };
  const api = githubApi(collectPages([spec, { number: 4, title: '无评论问题', body: '描述', author: 'reporter' }], {
    [LIST_PATH]: [
      { number: ISSUE, title: '启动失败', body: 'x', user: { login: 'owner' }, pull_request: {} },
      listItem(spec),
      { number: 4, title: '无评论问题', body: '描述', user: { login: 'reporter' } },
    ],
  }));
  const result = await collectOnce(t, { request: api.request, dataDir });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'complete');
  const store = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-feedback.json'), 'utf8'));
  assert.deepEqual(store.issues.map(issue => issue.number).sort(), [3, 4], 'PR 不进反馈源，owner issue 保留');
  const issue3 = store.issues.find(issue => issue.number === 3);
  assert.deepEqual(issue3.comments.map(item => item.id), [10, 11], '评论升序保留，最新在末尾');
  assert.deepEqual(api.calls.filter(call => call.apiPath.includes('/comments')).map(call => call.apiPath),
    [commentsPath(3, 1)], '总数 ≤30 时只取最后一页');
  const before = issue3.fingerprint;

  // 编辑标题后指纹变化（语义内容变化，非 updated_at 触发）。
  const edited = githubApi(collectPages([{ ...spec, title: '好友列表为空（再编辑）' }, { number: 4, title: '无评论问题', body: '描述', author: 'reporter' }]));
  await collectOnce(t, { request: edited.request, dataDir, now: () => NOW + 1000 });
  const store2 = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-feedback.json'), 'utf8'));
  assert.notEqual(store2.issues.find(issue => issue.number === 3).fingerprint, before, '标题编辑改变语义指纹');
  assert.equal(fs.statSync(path.join(dataDir, 'evolution-github-feedback.json')).mode & 0o777, 0o600, '私有存储 0600');
});

test('评论分页：25 条抓全但只留最新 20 = 不完整证据；35 条两页；超大显式截断；元数据缺失显式降级', async (t) => {
  // 25 条（单页抓全）曾因「先标记后裁剪」冒称 complete 再丢最旧 5 条：截断标记必须
  // 在保留上限裁剪之后落下，且不完整证据整轮降级 partial（后续禁止 fixed 回复）。
  const twentyFive = Array.from({ length: 25 }, (_, index) => comment(index + 1, 'reporter', `c${index + 1}`));
  const dir25 = tmpDir(t);
  const api25 = githubApi(issuePages({ number: 5, title: 't', body: 'b', author: 'reporter', comments: twentyFive }));
  const result25 = await collectOnce(t, { request: api25.request, dataDir: dir25 });
  assert.equal(result25.state, 'partial', '25 条只保留 20 条：抓全≠证据完整');
  assert.equal(result25.reason, 'comments_truncated');
  const store25 = JSON.parse(fs.readFileSync(path.join(dir25, 'evolution-github-feedback.json'), 'utf8'));
  assert.equal(store25.issues[0].commentsTruncated, true, '截断标记在裁剪后落下');
  assert.deepEqual(store25.issues[0].comments.map(item => item.id).slice(-2), [24, 25], '保留的是最新 20 条');
  const batch25 = feedback.captureFeedbackBatch({ config: makeConfig(), dataDir: dir25 });
  assert.equal(batch25.complete, false, '不完整批次不得声称完整');
  const spec25 = { ...PENDING_ISSUE, number: 5, title: 't', body: 'b', comments: twentyFive, updatedAt: '2026-09-01T00:00:00Z' };
  const send25 = issuePages(spec25);
  send25[postPath(5)] = () => ({ statusCode: 201, body: { id: 1 } });
  await feedback.enqueueGithubResolution({
    dataDir: dir25, issue: 5, revision: REV, issueFingerprint: batch25.issues[0].fingerprint,
    capturedAt: batch25.capturedAt, source: 'dual_review', reviewedBy: 'codex',
  }, { config: makeConfig() });
  const apiSend25 = githubApi(send25);
  const held25 = await feedback.handlePublishedEvolution({
    status: 'pending_apply', commit: REV, dualAgentEnabled: true, mainAgent: 'codex',
    batchSummary: feedback.summarizeBatch(batch25),
    journal: { status: 'completed', phase: 'complete', decision: 'approve', head: REV, githubResolutions: [{ issue: 5, status: 'fixed', fingerprint: batch25.issues[0].fingerprint }] },
  }, { config: makeConfig(), dataDir: dir25, request: apiSend25.request, publishedCheck: async () => true, sendPrivate: async () => {}, now: () => NOW });
  assert.equal(held25.reason, 'batch_incomplete', '不完整证据批次绝不进入回复链路');
  assert.equal(apiSend25.calls.filter(call => call.method === 'POST').length, 0, '零公开发送');

  const many = Array.from({ length: 35 }, (_, index) => comment(index + 1, 'reporter', `c${index + 1}`));
  const dataDir = tmpDir(t);
  const api = githubApi(issuePages({ number: 5, title: 't', body: 'b', author: 'reporter', comments: many }));
  const result = await collectOnce(t, { request: api.request, dataDir });
  assert.equal(result.state, 'partial', '35 条抓全但只留 20 条：同样是缺失证据，不冒称完整');
  assert.equal(result.reason, 'comments_truncated');
  let store = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-feedback.json'), 'utf8'));
  assert.deepEqual(store.issues[0].comments.map(item => item.id).slice(-3), [33, 34, 35], '保留的是最新评论');
  assert.equal(store.issues[0].comments.length, 20);
  assert.deepEqual(api.calls.filter(call => call.apiPath.includes('/comments')).map(call => call.apiPath),
    [commentsPath(5, 2), commentsPath(5, 1)], '先取最后一页，再回看前页凑够最新 20 条');

  const huge = Array.from({ length: 95 }, (_, index) => comment(index + 1, 'reporter', `c${index + 1}`));
  const dir2 = tmpDir(t);
  const apiHuge = githubApi(issuePages({ number: 5, title: 't', body: 'b', author: 'reporter', comments: huge }));
  const truncated = await collectOnce(t, { request: apiHuge.request, dataDir: dir2 });
  assert.equal(truncated.state, 'partial');
  assert.equal(truncated.reason, 'comments_truncated', '只覆盖最近两页时显式标记，不宣称完整历史');
  store = JSON.parse(fs.readFileSync(path.join(dir2, 'evolution-github-feedback.json'), 'utf8'));
  assert.equal(store.issues[0].commentsTruncated, true);
  assert.deepEqual(store.issues[0].comments.map(item => item.id).slice(-2), [94, 95]);

  // detail 缺 comments 计数（分页元数据不可用）：显式降级为 partial，绝不猜页。
  const dir3 = tmpDir(t);
  const apiMeta = githubApi({
    [LIST_PATH]: [{ number: 6, title: 't', body: 'b', user: { login: 'reporter' } }],
    [`/repos/${REPO}/issues/6`]: { number: 6, title: 't', body: 'b', state: 'open', user: { login: 'reporter' } },
  });
  const noMeta = await collectOnce(t, { request: apiMeta.request, dataDir: dir3 });
  assert.equal(noMeta.state, 'partial');
  assert.equal(noMeta.reason, 'invalid_response');
});

test('采集不完整显式标记：整页 issue 截断与单轮采集上限溢出都不得宣称完整', async (t) => {
  const dataDir = tmpDir(t);
  const list = Array.from({ length: 30 }, (_, index) => ({
    number: index + 1, title: `t${index}`, body: 'b', user: { login: 'reporter' },
  }));
  const stubs = {};
  for (let number = 1; number <= 12; number += 1) {
    stubs[`/repos/${REPO}/issues/${number}`] = detail({ number, title: `t${number - 1}`, body: 'b', author: 'reporter' });
  }
  const api = githubApi({ [LIST_PATH]: list, ...stubs });
  const result = await collectOnce(t, { request: api.request, dataDir });
  assert.equal(result.state, 'partial');
  assert.equal(result.reason, 'issues_truncated');
  const store = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-feedback.json'), 'utf8'));
  assert.equal(store.collection.issuesTruncated, true);
  assert.equal(store.issues.length, 12, '单轮只采 12 条');
  assert.equal(store.collection.reason, 'issues_truncated', '超出部分显式留待下轮');
});

test('未决记录无限期保留：采集不减少旧记录数量（无静默淘汰）', async (t) => {
  const dataDir = tmpDir(t);
  const seed = {
    version: 1, configFingerprint: '', authLogin: 'owner', updatedAt: 0,
    collection: { state: 'complete', reason: 'none', collectedAt: NOW - 1000, issuesTruncated: false },
    delivered: {},
    issues: Array.from({ length: 40 }, (_, index) => ({
      number: 1000 + index, title: `old${index}`, body: 'b', author: 'reporter', state: 'open',
      comments: [], commentsTruncated: false, commentCount: 0, updatedAt: 0, manualFixedAt: 0,
      fingerprint: crypto.createHash('sha256').update(`old${index}`).digest('hex'), capturedAt: NOW - 1000,
    })),
  };
  fs.writeFileSync(path.join(dataDir, 'evolution-github-feedback.json'), JSON.stringify(seed));
  const api = githubApi(issuePages({ number: 5, title: '新问题', body: 'b', author: 'reporter' }));
  const result = await collectOnce(t, { request: api.request, dataDir });
  assert.equal(result.ok, true);
  const store = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-feedback.json'), 'utf8'));
  assert.equal(store.issues.length, 41, '40 条旧未决 + 1 条新采集全部保留');
  const batch = feedback.captureFeedbackBatch({ config: makeConfig(), dataDir });
  assert.equal(batch.pendingTotal, 41, '全部未决可见');
  assert.equal(batch.issues.length, 12, '批次只带前 12 条');
  assert.match(feedback.buildGithubFeedbackSection(batch), /待处理 issue 共 41 条，本批次只含前 12 条/);
});

test('采集失败保留旧未决记录，单条抓取失败只降级为 partial', async (t) => {
  const dataDir = tmpDir(t);
  await collectOnce(t, { request: githubApi(issuePages(PENDING_ISSUE)).request, dataDir });
  const failAll = githubApi({ [LIST_PATH]: new Error('network') });
  const result = await collectOnce(t, { request: failAll.request, dataDir, now: () => NOW + 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'unavailable');
  assert.equal(result.reason, 'network');
  const store = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-feedback.json'), 'utf8'));
  assert.equal(store.issues.length, 1, '旧未决记录不因采集失败消失');

  const partial = githubApi({
    [LIST_PATH]: [{ number: ISSUE, title: '启动失败', body: 'bot 起不来', user: { login: 'reporter' } }],
    [`/repos/${REPO}/issues/${ISSUE}`]: new Error('timeout'),
  });
  const partialResult = await collectOnce(t, { request: partial.request, dataDir, now: () => NOW + 6000 });
  assert.equal(partialResult.state, 'partial');
  assert.equal(partialResult.reason, 'timeout');
  const kept = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-feedback.json'), 'utf8'));
  assert.equal(kept.issues.length, 1, '未重新抓到的快照保留');
});

test('去重：真实手工「已修复」措辞可采纳；其后报告者评论或正文编辑都会重新打开', async (t) => {
  // 场景 A：bootstrap issue #2 的 owner 手工回复用了真实措辞，且其后无报告者活动 → 采纳。
  const manualData = tmpDir(t);
  const specA = {
    number: ISSUE, title: '引导问题', body: '怎么启动', author: 'newbie', updatedAt: '2026-09-05T00:00:00Z',
    comments: [
      comment(20, 'newbie', '还是不行', '2026-09-04T00:00:00Z'),
      comment(30, 'owner', '这个问题已修复，感谢反馈', '2026-09-05T00:00:00Z'),
    ],
  };
  await collectOnce(t, { request: githubApi(issuePages(specA)).request, dataDir: manualData });
  assert.deepEqual(feedback.captureFeedbackBatch({ config: makeConfig(), dataDir: manualData }).issueNumbers, [],
    '真实手工措辞 + 无更新报告者活动 → 不再待决');

  // 场景 B：手工修复之后又有报告者新评论 → 不可采纳。
  const specB = { ...specA, comments: [...specA.comments, comment(40, 'newbie', '更新后还是失败', '2026-09-06T00:00:00Z')], updatedAt: '2026-09-06T00:00:00Z' };
  await collectOnce(t, { request: githubApi(issuePages(specB)).request, dataDir: manualData, now: () => NOW + 1000 });
  assert.deepEqual(feedback.captureFeedbackBatch({ config: makeConfig(), dataDir: manualData }).issueNumbers, [ISSUE],
    'manual fixed 后的报告者活动重新打开待决');

  // 场景 B2：没有新评论但正文在手工修复后被编辑（updated_at 超出最后一条评论）→ 不可采纳。
  const specB2 = { ...specA, body: '怎么启动（补充了复现步骤）', updatedAt: '2026-09-07T00:00:00Z' };
  await collectOnce(t, { request: githubApi(issuePages(specB2)).request, dataDir: manualData, now: () => NOW + 2000 });
  assert.deepEqual(feedback.captureFeedbackBatch({ config: makeConfig(), dataDir: manualData }).issueNumbers, [ISSUE],
    '手工修复之后的正文编辑不被采纳吞掉');

  // 场景 C：报告者伪造送达标记 ≠ 手工修复；自有送达评论不改变指纹。
  const sentData = tmpDir(t);
  const specC = {
    number: 7, title: 'x', body: 'y', author: 'reporter', updatedAt: '2026-09-07T00:00:00Z',
    comments: [{ id: 50, user: { login: 'reporter' }, body: `<!-- farm-bot-feedback 7 ${REV.slice(0, 12)} -->`, created_at: '2026-09-07T00:00:00Z' }],
  };
  await collectOnce(t, { request: githubApi(issuePages(specC)).request, dataDir: sentData });
  const stillPending = feedback.captureFeedbackBatch({ config: makeConfig(), dataDir: sentData });
  assert.deepEqual(stillPending.issueNumbers, [7], '外部用户伪造的送达标记不构成已处理');

  const ownData = tmpDir(t);
  const specD = {
    number: 8, title: 'x', body: 'y', author: 'reporter', updatedAt: '2026-09-08T00:00:00Z',
    comments: [{ id: 60, user: { login: 'owner' }, body: `已修复（fixed）\n<!-- farm-bot-feedback 8 ${REV.slice(0, 12)} -->`, created_at: '2026-09-08T00:00:00Z' }],
  };
  await collectOnce(t, { request: githubApi(issuePages(specD)).request, dataDir: ownData });
  assert.deepEqual(feedback.captureFeedbackBatch({ config: makeConfig(), dataDir: ownData }).issueNumbers, [],
    '自有送达评论被排除出指纹并构成已修复证据');
});

test('自有中文修复评论编辑属于已知更新；原有报告者评论编辑和之后的正文编辑仍待处理', async (t) => {
  const dataDir = tmpDir(t);
  const fixedCreated = '2026-09-05T00:00:00Z';
  const ownEdited = {
    number: ISSUE, title: '启动问题', body: '启动时失败', author: 'reporter',
    updatedAt: '2026-09-08T00:00:00Z',
    comments: [
      comment(20, 'reporter', '原有问题描述', '2026-09-04T00:00:00Z'),
      { ...comment(30, 'owner', '这个问题已修复，更新后重启服务即可。', fixedCreated), updated_at: '2026-09-08T00:00:00Z' },
    ],
  };
  await collectOnce(t, { request: githubApi(issuePages(ownEdited)).request, dataDir });
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-feedback.json'), 'utf8')).issues[0];
  assert.equal(stored.manualFixedAt, Date.parse(fixedCreated), '手工修复边界保持原创建时间，不能随评论编辑后移');
  assert.equal(stored.comments.find(c => c.id === 30).updatedAt, Date.parse(ownEdited.updatedAt));
  assert.equal(stored.comments.find(c => c.id === 20).updatedAt, Date.parse('2026-09-04T00:00:00Z'), '旧评论没有编辑时间时兼容创建时间');
  assert.deepEqual(feedback.captureFeedbackBatch({ config: makeConfig(), dataDir }).issueNumbers, [],
    '实际中文已修复评论被编辑：读取持久化快照后仍可采纳，不能误判未见报告者活动');

  // 报告者编辑发生在原修复回复之后、owner 最近编辑之前：原修复边界不能被后移吞掉反馈。
  const reporterEdited = { ...ownEdited, comments: [
    { ...ownEdited.comments[0], body: '补充复现：仍然无法启动', updated_at: '2026-09-07T00:00:00Z' },
    ownEdited.comments[1],
  ] };
  await collectOnce(t, { request: githubApi(issuePages(reporterEdited)).request, dataDir, now: () => NOW + 1000 });
  const pending = feedback.captureFeedbackBatch({ config: makeConfig(), dataDir });
  assert.deepEqual(pending.issueNumbers, [ISSUE], '原有报告者评论后编辑也属于尚未处理的报告活动');
  assert.equal(pending.issues[0].comments.find(c => c.id === 20).updatedAt, '2026-09-07T00:00:00.000Z', '报告编辑时间保留到复核快照');

  const bodyEdited = { ...ownEdited, body: '正文新增启动失败复现步骤', updatedAt: '2026-09-09T00:00:00Z' };
  await collectOnce(t, { request: githubApi(issuePages(bodyEdited)).request, dataDir, now: () => NOW + 2000 });
  assert.deepEqual(feedback.captureFeedbackBatch({ config: makeConfig(), dataDir }).issueNumbers, [ISSUE],
    '超出已知评论编辑时间的正文编辑仍待处理');
});

test('送达回执按报告指纹保留：新报告者活动重新打开，自有送达评论不自触发', async (t) => {
  const dataDir = tmpDir(t);
  const spec = { ...PENDING_ISSUE, updatedAt: '2026-09-01T00:00:00Z' };
  await collectOnce(t, { request: githubApi(issuePages(spec)).request, dataDir });
  const pages = issuePages(spec);
  pages[postPath(ISSUE)] = () => ({ statusCode: 201, body: { id: 1 } });
  const api = githubApi(pages);
  await feedback.enqueueGithubResolution({
    dataDir, issue: ISSUE, revision: REV, issueFingerprint: issueFp(spec), capturedAt: NOW, source: 'dual_review', reviewedBy: 'codex',
  }, { config: makeConfig() });
  await feedback.drainGithubFeedbackOutbox(drainOptions(dataDir, api));
  let store = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-feedback.json'), 'utf8'));
  assert.equal(store.delivered[ISSUE].commentId, 1);
  assert.equal(store.delivered[ISSUE].fingerprint, issueFp(spec), '回执记录已处理的报告版本指纹');
  assert.deepEqual(feedback.captureFeedbackBatch({ config: makeConfig(), dataDir }).issueNumbers, [], '同一报告版本不重复待决');

  // 自有送达评论出现在远端：不改变指纹、不自触发新待决。
  const withOwn = { ...spec, comments: [...spec.comments, { id: 90, user: { login: 'owner' }, body: `已修复（fixed）\n<!-- farm-bot-feedback ${ISSUE} ${REV.slice(0, 12)} -->`, created_at: '2026-09-02T00:00:00Z' }], updatedAt: '2026-09-02T00:00:00Z' };
  await collectOnce(t, { request: githubApi(issuePages(withOwn)).request, dataDir, now: () => NOW + 1000 });
  assert.deepEqual(feedback.captureFeedbackBatch({ config: makeConfig(), dataDir }).issueNumbers, [], '自有送达评论不重新打开');

  // 报告者新评论：指纹变化 → 重新进入待决批次。
  const withReporter = { ...withOwn, comments: [...withOwn.comments, comment(91, 'reporter', '更新后还有问题', '2026-09-03T00:00:00Z')], updatedAt: '2026-09-03T00:00:00Z' };
  await collectOnce(t, { request: githubApi(issuePages(withReporter)).request, dataDir, now: () => NOW + 2000 });
  assert.deepEqual(feedback.captureFeedbackBatch({ config: makeConfig(), dataDir }).issueNumbers, [ISSUE],
    '送达后的报告者新评论重新打开待决（不再被永久吞掉）');
  store = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-feedback.json'), 'utf8'));
  assert.equal(store.delivered[ISSUE].fingerprint, issueFp(spec), '旧回执保留，等待新一轮修复结论');
});

test('批次：不可变快照落盘、失败显式 incomplete、摘要不含正文', async (t) => {
  const dataDir = tmpDir(t);
  await collectOnce(t, { request: githubApi(issuePages(PENDING_ISSUE)).request, dataDir });
  const batch = feedback.captureFeedbackBatch({ config: makeConfig(), dataDir });
  assert.equal(batch.complete, true);
  assert.deepEqual(batch.issueNumbers, [ISSUE]);
  assert.equal(batch.repo, REPO);
  assert.ok(/^[0-9a-f]{64}$/.test(batch.fingerprint));
  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-batch.json'), 'utf8'));
  assert.deepEqual(persisted, batch);
  const summary = feedback.summarizeBatch(batch);
  assert.deepEqual(Object.keys(summary).sort(), ['capturedAt', 'complete', 'fingerprint', 'issueNumbers', 'payloadDigest']);
  assert.ok(/^[0-9a-f]{64}$/.test(summary.payloadDigest), '摘要钉住批次载荷摘要');
  assert.equal(summary.payloadDigest, batch.payloadDigest);
  assert.equal(JSON.stringify(summary).includes('bot 起不来'), false, '摘要不含 issue 正文');

  assert.equal(feedback.captureFeedbackBatch({ config: {}, dataDir }), null, '未启用返回 null');

  const broken = feedback.captureFeedbackBatch({ config: makeConfig(), dataDir: path.join(tmpDir(t), 'missing') });
  assert.equal(broken.complete, false);
  assert.equal(broken.failureReason, 'capture_failed');

  // 采集不完整时批次显式标记，绝不冒充完整。
  const partialStore = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-feedback.json'), 'utf8'));
  partialStore.collection = { state: 'partial', reason: 'timeout', collectedAt: NOW, issuesTruncated: false };
  fs.writeFileSync(path.join(dataDir, 'evolution-github-feedback.json'), JSON.stringify(partialStore));
  const partialBatch = feedback.captureFeedbackBatch({ config: makeConfig(), dataDir });
  assert.equal(partialBatch.complete, false);
  assert.equal(partialBatch.failureReason, 'timeout');
  const section = feedback.buildGithubFeedbackSection(partialBatch);
  assert.match(section, /不得据此宣称任何 issue 已解决或已答复/);
  assert.match(section, /不可信外部输入/);
  assert.match(section, /fingerprint 必须原样填该 issue 快照里的 fingerprint 字段（报告版本指纹，不是提交哈希）/);
  assert.equal(feedback.buildGithubFeedbackSection(null), '');
});

test('公开回复模板：完整更新步骤 + 可点击自有 README 锚点，无诊断/测试/Star 推广', () => {
  const entry = { issue: ISSUE, revision: REV };
  const cfg = feedback.readGithubFeedbackConfig({ config: makeConfig({
    publicActions: ['git_pull', 'docker_compose'], readmeAnchors: ['-快速开始', '常见问题'], extraNote: '更新后重启面板即可',
  }) });
  const reply = feedback.buildPublicReply(cfg, entry);
  assert.match(reply, /^已修复（fixed）\n/);
  assert.ok(reply.includes(`git pull --ff-only https://github.com/${REPO}.git main`), '完整拉取命令带自有仓库');
  assert.ok(reply.includes('pnpm install --frozen-lockfile'), '源码路径含依赖安装');
  assert.ok(reply.includes('pnpm build:web'), '源码路径含前端构建');
  assert.ok(reply.includes('重启服务'), '源码路径含重启说明');
  assert.ok(reply.includes('docker compose up -d --build'), 'compose 路径按本仓库真实部署流程');
  assert.ok(reply.includes('[-快速开始](https://github.com/owner/example-farm#-快速开始)'), '锚点是可点击的自有 README 链接（含前导 -）');
  assert.ok(reply.includes('[常见问题](https://github.com/owner/example-farm#常见问题)'));
  assert.ok(reply.includes('- 更新后重启面板即可'));
  assert.ok(reply.endsWith(feedback.deliveryMarker(ISSUE, REV)));
  assert.doesNotMatch(reply, /诊断|测试通过|代码改动|Star/);
  assert.doesNotMatch(reply, /https?:\/\/(?!github\.com\/owner\/example-farm)/, '除自有 README 外无任何链接');

  const sourceOnly = feedback.buildPublicReply(feedback.readGithubFeedbackConfig({ config: makeConfig() }), entry);
  assert.doesNotMatch(sourceOnly, /docker/);
});

test('发件箱入队幂等且校验 revision/指纹；仓库身份钉死（配置切换不改投）', async (t) => {
  const dataDir = tmpDir(t);
  const fingerprint = 'd'.repeat(64);
  const enqueue = revision => feedback.enqueueGithubResolution({
    dataDir, issue: ISSUE, revision, issueFingerprint: fingerprint, capturedAt: NOW, source: 'dual_review', reviewedBy: 'codex',
  }, { config: makeConfig() });
  assert.equal((await enqueue(REV)).ok, true);
  const again = await enqueue(REV);
  assert.equal(again.ok, true);
  assert.equal(again.deduplicated, true);
  assert.equal((await feedback.enqueueGithubResolution({ dataDir, issue: ISSUE, revision: 'zzz', issueFingerprint: fingerprint, capturedAt: NOW }, { config: makeConfig() })).ok, false);
  assert.equal((await feedback.enqueueGithubResolution({ dataDir, issue: ISSUE, revision: REV, issueFingerprint: 'short', capturedAt: NOW }, { config: makeConfig() })).ok, false);
  assert.equal((await feedback.enqueueGithubResolution({ dataDir, issue: ISSUE, revision: REV, issueFingerprint: fingerprint, capturedAt: NOW }, { config: {} })).ok, false);
  let outbox = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-outbox.json'), 'utf8'));
  assert.equal(outbox.entries[`${ISSUE}:${REV}`].repo, REPO, '条目记录采集时的仓库身份');

  // 切换配置仓库：旧条目原样保留、绝不发往新仓库，也不被删除。
  const switched = makeConfig({ repo: 'owner/other-farm' });
  const api = githubApi({});
  const drain = await feedback.drainGithubFeedbackOutbox({
    config: switched, dataDir, request: api.request, publishedCheck: async () => true, sendPrivate: async () => {}, now: () => NOW,
  });
  assert.equal(drain.ok, true);
  assert.equal(api.calls.length, 0, '绝不向切换后的仓库发旧条目');
  outbox = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-outbox.json'), 'utf8'));
  assert.equal(outbox.entries[`${ISSUE}:${REV}`].public.status, 'pending', '旧条目保留待原配置恢复');
  assert.equal(outbox.entries[`${ISSUE}:${REV}`].repo, REPO);
});

test('发布核对：无关后代放行；修复被 revert（仍为祖先）终态取消；元数据缺失不放行', async () => {
  const descendant = 'f'.repeat(40);
  const other = '9'.repeat(40);
  const FIX_PATH = 'core/src/example.js';
  const commitDetail = files => ({ sha: REV, commit: { message: 'fix' }, files });
  const compare = githubApi({
    [`/repos/${REPO}/commits/${REV}`]: commitDetail([{ filename: FIX_PATH, status: 'modified' }, { filename: 'core/test/x.test.js', status: 'added' }]),
    [`/repos/${REPO}/compare/${REV}...${descendant}`]: { status: 'ahead', ahead_by: 2, behind_by: 0, files: [{ filename: 'docs/other.md' }] },
    [`/repos/${REPO}/compare/${REV}...${other}`]: { status: 'diverged', ahead_by: 1, behind_by: 1, files: [] },
    // revert：REV 仍是后代提交的祖先，但修复路径出现在 REV...remote 的净 diff 里。
    [`/repos/${REPO}/compare/${REV}...${'7'.repeat(40)}`]: { status: 'ahead', ahead_by: 1, behind_by: 0, files: [{ filename: FIX_PATH, status: 'modified' }] },
    // 净 diff 文件列表被 GitHub 截断（>=300）：无法证明路径未变，不放行也不终态。
    [`/repos/${REPO}/compare/${REV}...${'5'.repeat(40)}`]: { status: 'ahead', ahead_by: 1, behind_by: 0, files: Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}` })) },
  });
  assert.equal(await feedback.defaultPublishedCheck({ repo: REPO }, REV, { remoteHead: async () => REV, request: compare.request }), true, '精确相等（无需元数据）');
  assert.equal(await feedback.defaultPublishedCheck({ repo: REPO }, REV, { remoteHead: async () => descendant, request: compare.request }), true,
    '无关后代提交：历史包含修复且修复路径未被触及');
  assert.deepEqual(await feedback.defaultPublishedCheck({ repo: REPO }, REV, { remoteHead: async () => '7'.repeat(40), request: compare.request }),
    { ok: false, hold: 'fix_superseded' }, '修复被 revert：绝不补发迟到的已修复');
  assert.equal(await feedback.defaultPublishedCheck({ repo: REPO }, REV, { remoteHead: async () => other, request: compare.request }), false, '无关/改写历史：不放行');
  assert.equal(await feedback.defaultPublishedCheck({ repo: REPO }, REV, { remoteHead: async () => '', request: compare.request }), false, '远端不可用：不放行');
  assert.equal(await feedback.defaultPublishedCheck({ repo: REPO }, REV, { remoteHead: async () => '5'.repeat(40), request: compare.request }), false,
    '净 diff 文件列表截断：无法验证路径未变，保持待发不冒称已发布');

  // 修复提交自身的 files 元数据缺失/截断：同样无法验证 → 不放行。
  const noFiles = githubApi({ [`/repos/${REPO}/commits/${REV}`]: { sha: REV, commit: { message: 'fix' } } });
  assert.equal(await feedback.defaultPublishedCheck({ repo: REPO }, REV, { remoteHead: async () => descendant, request: noFiles.request }), false,
    '修复提交 files 元数据缺失：不放行');
  const truncated = githubApi({ [`/repos/${REPO}/commits/${REV}`]: commitDetail(Array.from({ length: 300 }, (_, i) => ({ filename: `p${i}` }))) });
  assert.equal(await feedback.defaultPublishedCheck({ repo: REPO }, REV, { remoteHead: async () => descendant, request: truncated.request }), false,
    '修复提交 files 截断：不放行');
});

test('发布核对 hold → 发件箱终态取消：不发送、不重试、私有上报取代原因', async (t) => {
  const spec = { ...PENDING_ISSUE, updatedAt: '2026-09-01T00:00:00Z' };
  const pages = issuePages(spec);
  pages[postPath(ISSUE)] = () => ({ statusCode: 201, body: { id: 1 } });
  const { dataDir, api } = await freshOutbox(t, pages, { fingerprint: issueFp(spec) });
  const sent = [];
  const first = await feedback.drainGithubFeedbackOutbox(drainOptions(dataDir, api, {
    publishedCheck: async () => ({ ok: false, hold: 'fix_superseded' }),
    sendPrivate: async (title, content) => { sent.push(content); },
  }));
  assert.equal(first.pending, 0, '终态取消后不再待发');
  assert.equal(api.calls.filter(call => call.method === 'POST').length, 0, '修复被取代：零 POST');
  let outbox = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-outbox.json'), 'utf8'));
  assert.equal(outbox.entries[`${ISSUE}:${REV}`].public.status, 'superseded');
  assert.equal(outbox.entries[`${ISSUE}:${REV}`].public.lastReason, 'fix_superseded');
  assert.match(sent[0], /疑似 revert\/取代/, '私有报告如实说明取消原因');
  const posts = api.calls.length;
  await feedback.drainGithubFeedbackOutbox(drainOptions(dataDir, api, {
    publishedCheck: async () => ({ ok: false, hold: 'fix_superseded' }),
    now: () => NOW + 60 * 60 * 1000,
  }));
  assert.equal(api.calls.length, posts, '终态后不再尝试公开通道');
  outbox = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-outbox.json'), 'utf8'));
  assert.equal(outbox.entries[`${ISSUE}:${REV}`].public.status, 'superseded', '状态持久化，重启后不复活');
});

test('发送链路：发布核对+报告版本复核通过才 POST；201 写带指纹的送达回执', async (t) => {
  const spec = { ...PENDING_ISSUE, updatedAt: '2026-09-01T00:00:00Z' };
  const pages = issuePages(spec);
  pages[postPath(ISSUE)] = (method, body) => {
    assert.equal(method, 'POST');
    assert.ok(String(body.body).includes('git pull --ff-only'));
    return { statusCode: 201, body: { id: 4242 } };
  };
  const { dataDir, api } = await freshOutbox(t, pages, { fingerprint: issueFp(spec) });
  const result = await feedback.drainGithubFeedbackOutbox(drainOptions(dataDir, api));
  assert.equal(result.pending, 0);
  const outbox = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-outbox.json'), 'utf8'));
  const entry = outbox.entries[`${ISSUE}:${REV}`];
  assert.equal(entry.public.status, 'delivered');
  assert.equal(entry.public.commentId, 4242);
  assert.equal(entry.private.status, 'delivered', '私有通道独立送达');
  const store = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-feedback.json'), 'utf8'));
  assert.equal(store.delivered[ISSUE].commentId, 4242, '送达进 store 去重表');
  assert.equal(store.delivered[ISSUE].fingerprint, issueFp(spec), '回执携带报告版本指纹');
  assert.equal(fs.statSync(path.join(dataDir, 'evolution-github-outbox.json')).mode & 0o777, 0o600);

  // 远端未包含该提交：不发送、不烧尝试次数，保持待发。
  const unpublished = await freshOutbox(t, issuePages(spec), { fingerprint: issueFp(spec) });
  const blocked = await feedback.drainGithubFeedbackOutbox(drainOptions(unpublished.dataDir, unpublished.api, { publishedCheck: async () => false }));
  assert.equal(blocked.ok, true);
  assert.equal(unpublished.api.calls.length, 0, '未发布绝不调用 GitHub API');
  const outbox2 = JSON.parse(fs.readFileSync(path.join(unpublished.dataDir, 'evolution-github-outbox.json'), 'utf8'));
  assert.equal(outbox2.entries[`${ISSUE}:${REV}`].public.attempts, 0);
  assert.equal(outbox2.entries[`${ISSUE}:${REV}`].public.lastReason, 'revision_not_published');

  // main 已前进到后代：照常发送（旧修复不被无关后续提交永久阻塞）。
  const movedOn = await freshOutbox(t, pages, { fingerprint: issueFp(spec) });
  const moved = await feedback.drainGithubFeedbackOutbox(drainOptions(movedOn.dataDir, movedOn.api));
  assert.equal(moved.pending, 0);
  const outbox3 = JSON.parse(fs.readFileSync(path.join(movedOn.dataDir, 'evolution-github-outbox.json'), 'utf8'));
  assert.equal(outbox3.entries[`${ISSUE}:${REV}`].public.status, 'delivered');
});

test('发送前先查自有送达标记：本地回执丢失也零 POST 收口；伪造标记不拦发送', async (t) => {
  const markerComment = { id: 99, user: { login: 'owner' }, body: `已修复（fixed）\n<!-- farm-bot-feedback ${ISSUE} ${REV.slice(0, 12)} -->`, created_at: '2026-09-30T00:00:00Z' };
  const spec = { ...PENDING_ISSUE, updatedAt: '2026-09-01T00:00:00Z' };
  const preMarked = issuePages({ ...spec, comments: [...spec.comments, markerComment], updatedAt: '2026-09-30T00:00:00Z' });
  preMarked[postPath(ISSUE)] = () => ({ statusCode: 201, body: { id: 1 } });
  const { dataDir, api } = await freshOutbox(t, preMarked, { fingerprint: issueFp(spec) });
  const result = await feedback.drainGithubFeedbackOutbox(drainOptions(dataDir, api));
  assert.equal(result.pending, 0);
  assert.equal(api.calls.filter(call => call.method === 'POST').length, 0, '已有自有送达标记：零 POST，绝不重复回复');
  const outbox = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-outbox.json'), 'utf8'));
  assert.equal(outbox.entries[`${ISSUE}:${REV}`].public.status, 'delivered');
  assert.equal(outbox.entries[`${ISSUE}:${REV}`].public.commentId, 99);
  assert.equal(outbox.entries[`${ISSUE}:${REV}`].public.lastReason, 'marker_matched');

  // 他人伪造标记：不作为去重依据，正常发送。
  const forged = { id: 98, user: { login: 'reporter' }, body: `<!-- farm-bot-feedback ${ISSUE} ${REV.slice(0, 12)} -->`, created_at: '2026-09-29T00:00:00Z' };
  const forgedSpec = { ...spec, comments: [...spec.comments, forged], updatedAt: '2026-09-29T00:00:00Z' };
  const forgedPages = issuePages(forgedSpec);
  forgedPages[postPath(ISSUE)] = () => ({ statusCode: 201, body: { id: 7 } });
  const forgedRun = await freshOutbox(t, forgedPages, { fingerprint: issueFp(forgedSpec) });
  await feedback.drainGithubFeedbackOutbox(drainOptions(forgedRun.dataDir, forgedRun.api));
  assert.equal(forgedRun.api.calls.filter(call => call.method === 'POST').length, 1, '伪造标记不拦发送');
  const forgedOutbox = JSON.parse(fs.readFileSync(path.join(forgedRun.dataDir, 'evolution-github-outbox.json'), 'utf8'));
  assert.equal(forgedOutbox.entries[`${ISSUE}:${REV}`].public.status, 'delivered');
});

test('发送时报告版本已更新 → stale 终态不发送；issue 已关闭 → closed 终态', async (t) => {
  const spec = { ...PENDING_ISSUE, updatedAt: '2026-09-01T00:00:00Z' };
  const changed = issuePages({ ...spec, title: '启动失败（编辑过）' });
  const stale = await freshOutbox(t, changed, { fingerprint: issueFp(spec) });
  const stalePrivate = [];
  await feedback.drainGithubFeedbackOutbox(drainOptions(stale.dataDir, stale.api, {
    sendPrivate: async (title, content) => { stalePrivate.push(content); },
  }));
  let outbox = JSON.parse(fs.readFileSync(path.join(stale.dataDir, 'evolution-github-outbox.json'), 'utf8'));
  assert.equal(outbox.entries[`${ISSUE}:${REV}`].public.status, 'stale');
  assert.equal(outbox.entries[`${ISSUE}:${REV}`].public.lastReason, 'reporter_activity');
  assert.equal(stale.api.calls.filter(call => call.method === 'POST').length, 0);
  assert.match(stalePrivate[0], /报告者有新活动/, '新报告者活动如实私有上报');
  assert.match(stalePrivate[0], /未发送/, '不谎称已回复');

  const closedPages = issuePages(spec);
  closedPages[`/repos/${REPO}/issues/${ISSUE}`] = detail(spec, { state: 'closed' });
  const closed = await freshOutbox(t, closedPages, { fingerprint: issueFp(spec) });
  await feedback.drainGithubFeedbackOutbox(drainOptions(closed.dataDir, closed.api));
  outbox = JSON.parse(fs.readFileSync(path.join(closed.dataDir, 'evolution-github-outbox.json'), 'utf8'));
  assert.equal(outbox.entries[`${ISSUE}:${REV}`].public.status, 'closed');
  assert.equal(closed.api.calls.filter(call => call.method === 'POST').length, 0);
});

test('POST 超时后先远端去重：找到自有送达标记按已送达收口，不重复回复', async (t) => {  const spec = { ...PENDING_ISSUE, updatedAt: '2026-09-01T00:00:00Z' };
  const markerComment = { id: 99, user: { login: 'owner' }, body: `已修复（fixed）\n<!-- farm-bot-feedback ${ISSUE} ${REV.slice(0, 12)} -->`, created_at: '2026-09-30T00:00:00Z' };
  let posts = 0;
  const pages = issuePages(spec);
  // POST 超时 = 请求已发出但结果未知（评论可能已落远端）：发送前看不到标记，发送后可见。
  pages[postPath(ISSUE)] = () => { posts += 1; return new Error('timeout'); };
  pages[`/repos/${REPO}/issues/${ISSUE}`] = () => detail(posts === 0 ? spec : { ...spec, comments: [...spec.comments, markerComment], updatedAt: '2026-09-30T00:00:00Z' });
  pages[commentsPath(ISSUE, 1)] = () => (posts === 0 ? [...spec.comments] : [...spec.comments, markerComment]);
  const { dataDir, api } = await freshOutbox(t, pages, { fingerprint: issueFp(spec) });
  await feedback.drainGithubFeedbackOutbox(drainOptions(dataDir, api));
  const outbox = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-outbox.json'), 'utf8'));
  const entry = outbox.entries[`${ISSUE}:${REV}`];
  assert.equal(entry.public.status, 'delivered');
  assert.equal(entry.public.commentId, 99);
  assert.equal(entry.public.lastReason, 'marker_matched');
  assert.equal(api.calls.filter(call => call.method === 'POST').length, 1, '只发过一次');
});

test('成功响应必须带有效评论回执 id：未知响应保持待发，重试前先远端去重', async (t) => {
  const spec = { ...PENDING_ISSUE, updatedAt: '2026-09-01T00:00:00Z' };
  const markerComment = { id: 777, user: { login: 'owner' }, body: `已修复（fixed）\n<!-- farm-bot-feedback ${ISSUE} ${REV.slice(0, 12)} -->`, created_at: '2026-09-30T00:00:00Z' };
  let posts = 0;
  const pages = issuePages(spec);
  // 第一轮：POST 实际落了评论但响应体丢失（无 id）；第二轮发送前远端已可见自有标记。
  pages[postPath(ISSUE)] = () => { posts += 1; return { statusCode: 201, body: {} }; };
  pages[`/repos/${REPO}/issues/${ISSUE}`] = () => detail(posts === 0 ? spec : { ...spec, comments: [...spec.comments, markerComment], updatedAt: '2026-09-30T00:00:00Z' });
  pages[commentsPath(ISSUE, 1)] = () => (posts === 0 ? [...spec.comments] : [...spec.comments, markerComment]);
  const { dataDir, api } = await freshOutbox(t, pages, { fingerprint: issueFp(spec) });
  await feedback.drainGithubFeedbackOutbox(drainOptions(dataDir, api));
  let outbox = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-outbox.json'), 'utf8'));
  assert.equal(outbox.entries[`${ISSUE}:${REV}`].public.status, 'pending', '无回执 id 不得记为已送达');
  assert.equal(outbox.entries[`${ISSUE}:${REV}`].public.commentId, 0);
  assert.equal(outbox.entries[`${ISSUE}:${REV}`].public.lastReason, 'invalid_response');
  let store = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-feedback.json'), 'utf8'));
  assert.equal(store.delivered[ISSUE], undefined, '没有回执绝不写送达去重表');

  // 重试前先远端去重：发现自有送达标记 → 零重复 POST 收口。
  await feedback.drainGithubFeedbackOutbox(drainOptions(dataDir, api, { now: () => NOW + 60 * 60 * 1000 }));
  outbox = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-outbox.json'), 'utf8'));
  assert.equal(outbox.entries[`${ISSUE}:${REV}`].public.status, 'delivered');
  assert.equal(outbox.entries[`${ISSUE}:${REV}`].public.commentId, 777, '按远端标记评论 id 收口');
  assert.equal(posts, 1, '绝不重复回复');
  store = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-feedback.json'), 'utf8'));
  assert.equal(store.delivered[ISSUE].commentId, 777);
});

test('issue 正文被清空成空串：不得回退列表页旧正文，指纹随之变化', async (t) => {
  const dataDir = tmpDir(t);
  const spec = { number: 9, title: '启动失败', body: 'bot 起不来', author: 'reporter', comments: [] };
  await collectOnce(t, { request: githubApi(issuePages(spec)).request, dataDir });
  let store = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-feedback.json'), 'utf8'));
  const before = store.issues[0].fingerprint;
  // 报告者把正文清空（GitHub 详情 body=''）：列表页条目仍带旧正文。
  const clearedPages = {
    [LIST_PATH]: [listItem(spec)],
    [`/repos/${REPO}/issues/9`]: detail({ ...spec, body: '' }),
    [commentsPath(9, 1)]: [],
  };
  await collectOnce(t, { request: githubApi(clearedPages).request, dataDir, now: () => NOW + 1000 });
  store = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-feedback.json'), 'utf8'));
  assert.equal(store.issues[0].body, '', '清空的正文是权威值，绝不复活旧正文');
  assert.notEqual(store.issues[0].fingerprint, before, '清空正文改变报告指纹（新报告版本）');
  assert.deepEqual(feedback.captureFeedbackBatch({ config: makeConfig(), dataDir }).issueNumbers, [9], '新版本仍待决');
});

test('反馈小节有界且绝不截断字符串：超预算按整条裁并显式暴露，指令永远完整', () => {
  const bigIssue = (n) => ({
    number: n, title: `问题${n}`, body: 'x'.repeat(4000), author: 'reporter',
    comments: [{ id: n, author: 'reporter', createdAt: 1, body: 'y'.repeat(800) }],
    commentsTruncated: false, omittedComments: 0, fingerprint: `${n}`.padEnd(64, '0'),
  });
  const batch = {
    version: 1, capturedAt: NOW, complete: true, repo: REPO, configFingerprint: '',
    issues: Array.from({ length: 12 }, (_, index) => bigIssue(index + 1)),
    issueNumbers: [], pendingTotal: 12, fingerprint: FP64, failureReason: '',
  };
  const section = feedback.buildGithubFeedbackSection(batch);
  assert.ok(section.length <= 24000, '小节有界');
  const lines = section.split('\n');
  const jsonLine = lines.find(line => line.startsWith('[{'));
  const parsedIssues = JSON.parse(jsonLine);
  assert.ok(Array.isArray(parsedIssues) && parsedIssues.length >= 1 && parsedIssues.length < 12,
    '超预算按整条裁剪（不会塞满也不为空）');
  assert.equal(parsedIssues[0].number, 1, '保留的是前若干条完整记录');
  for (const issue of parsedIssues) {
    assert.equal(issue.body.length, 4000, '每条记录完整（无半条切断）');
  }
  assert.match(section, /体量超出小节预算，\d+ 条整条未注入：未列入不代表已处理，也不得视为已复核/, '省略数显式暴露');
  // 结论映射指令必须原样完整出现在小节末尾（绝不因预算被切掉）。
  const instruction = lines[lines.length - 1];
  assert.match(instruction, /^- 若本轮真实修复了某 issue/);
  assert.match(instruction, /禁止为安抚报告者编造 fixed。$/, '指令以完整句收尾');
  // 极端：单条超预算时宁可为空数组也不截断记录。
  const huge = { ...batch, issues: [{ ...bigIssue(1), body: 'z'.repeat(30000) }], pendingTotal: 1 };
  const empty = feedback.buildGithubFeedbackSection(huge);
  assert.ok(empty.length <= 24000);
  assert.ok(empty.includes('[]') || empty.includes('1 条整条未注入'), '单条过大：整条省略而非切半');
  assert.match(empty, /禁止为安抚报告者编造 fixed。$/);
});

test('defaultSendPrivate：复用飞书 webhook/格式但必须可中止有界（AbortController 真取消）', async (t) => {
  // 模块的超时计时器 unref（不拖住生产进程）：测试侧保持 ref'd 句柄让超时能到达。
  const keepAlive = setTimeout(() => {}, 5000);
  t.after(() => clearTimeout(keepAlive));
  const previousWebhook = process.env.FEISHU_WEBHOOK;
  // 拼接构造（与 privacy-guard.test 同法）：受跟踪文件里不得出现字面 webhook 地址。
  const webhookUrl = ['https:/', '/open.feishu.cn/open-apis/bot/v2/hook/', 'test-hook-token'].join('');
  process.env.FEISHU_WEBHOOK = webhookUrl;
  t.after(() => {
    if (previousWebhook === undefined) delete process.env.FEISHU_WEBHOOK;
    else process.env.FEISHU_WEBHOOK = previousWebhook;
  });

  // 1) 挂死的网络请求：到点必须 abort（请求被真正取消，不是留在后台的 race）。
  let aborted = false;
  const hungFetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
  });
  await assert.rejects(
    () => feedback.defaultSendPrivate('标题', '内容', { timeoutMs: 25, fetchImpl: hungFetch }),
    { message: 'timeout' },
  );
  assert.equal(aborted, true, '超时必须真正中止底层请求');

  // 2) 正常路径：消息格式与 feishu-notify 同口径（text 模板 + 脱敏 + 4000 截断）。
  const calls = [];
  const okFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { json: async () => ({ code: 0 }) };
  };
  await feedback.defaultSendPrivate('农场 bot GitHub 反馈处理收口', `提交：${REV}`, { fetchImpl: okFetch });
  assert.equal(calls[0].url, webhookUrl);
  assert.equal(calls[0].body.msg_type, 'text');
  assert.ok(calls[0].body.content.text.startsWith('农场 bot GitHub 反馈处理收口\n提交：'));

  // 3) 飞书返回错误码：如实抛错（私有通道失败不影响公开回复的重试语义）。
  const errFetch = async () => ({ json: async () => ({ code: 19021, msg: 'sign match fail' }) });
  await assert.rejects(() => feedback.defaultSendPrivate('t', 'c', { fetchImpl: errFetch }), /code=19021/);

  // 4) 未配置 webhook：直接失败，不发任何请求。
  delete process.env.FEISHU_WEBHOOK;
  const previousConfig = process.env.FARM_PRIVATE_CONFIG_FILE;
  fs.writeFileSync(process.env.FARM_PRIVATE_CONFIG_FILE, JSON.stringify({}));
  await assert.rejects(() => feedback.defaultSendPrivate('t', 'c', { fetchImpl: okFetch }), /webhook/);
  process.env.FARM_PRIVATE_CONFIG_FILE = previousConfig;
});

test('公开失败不影响私有通道；私有失败不影响公开回复；尝试次数封顶后 failed；私有内容如实反映公开状态', async (t) => {
  const spec = { ...PENDING_ISSUE, updatedAt: '2026-09-01T00:00:00Z' };
  const pages = issuePages(spec);
  pages[postPath(ISSUE)] = () => ({ statusCode: 500, body: null });
  const { dataDir, api } = await freshOutbox(t, pages, { fingerprint: issueFp(spec) });
  const sent = [];
  const first = await feedback.drainGithubFeedbackOutbox(drainOptions(dataDir, api, {
    sendPrivate: async (title, content) => { sent.push({ title, content }); },
  }));
  assert.equal(first.pending, 1, '公开仍待重试');
  const afterFirst = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-outbox.json'), 'utf8'));
  assert.equal(afterFirst.entries[`${ISSUE}:${REV}`].private.status, 'delivered', '私有通道独立送达');
  assert.match(sent[0].content, new RegExp(`提交：${REV}`));
  assert.match(sent[0].content, /原因/);
  assert.match(sent[0].content, /公开回复：待重试/, '私有内容如实说明公开未送达');
  assert.match(sent[0].content, /（复核未提供验证摘要）/);

  // 反向：公开可送达、私有失败 → 公开照发，私有重试。
  const okPages = issuePages(spec);
  okPages[postPath(ISSUE)] = () => ({ statusCode: 201, body: { id: 7 } });
  const mix = await freshOutbox(t, okPages, { fingerprint: issueFp(spec) });
  await feedback.drainGithubFeedbackOutbox(drainOptions(mix.dataDir, mix.api, {
    sendPrivate: async () => { throw new Error('feishu down'); },
  }));
  let mixed = JSON.parse(fs.readFileSync(path.join(mix.dataDir, 'evolution-github-outbox.json'), 'utf8'));
  assert.equal(mixed.entries[`${ISSUE}:${REV}`].public.status, 'delivered');
  assert.equal(mixed.entries[`${ISSUE}:${REV}`].private.status, 'pending');

  // 尝试上限：公开 6 次失败后 failed 终态，不再请求；私有内容不再谎称待重试。
  const failPages = issuePages(spec);
  failPages[postPath(ISSUE)] = () => ({ statusCode: 500, body: null });
  const capped = await freshOutbox(t, failPages, { fingerprint: issueFp(spec) });
  const failures = [];
  for (let round = 0; round < 7; round++) {
    await feedback.drainGithubFeedbackOutbox(drainOptions(capped.dataDir, capped.api, {
      sendPrivate: async (title, content) => { failures.push(content); },
      now: () => NOW + round * 60 * 60 * 1000,
    }));
  }
  mixed = JSON.parse(fs.readFileSync(path.join(capped.dataDir, 'evolution-github-outbox.json'), 'utf8'));
  assert.equal(mixed.entries[`${ISSUE}:${REV}`].public.status, 'failed');
  assert.equal(mixed.entries[`${ISSUE}:${REV}`].public.attempts, 6);
  const posts = capped.api.calls.filter(call => call.method === 'POST').length;
  await feedback.drainGithubFeedbackOutbox(drainOptions(capped.dataDir, capped.api, { now: () => NOW + 10 * 60 * 60 * 1000 }));
  assert.equal(capped.api.calls.filter(call => call.method === 'POST').length, posts, 'failed 后不再尝试');
});

test('并发互斥：drain 进行中入队不丢条目；collect 重采不抹掉送达回执', async (t) => {
  const spec = { ...PENDING_ISSUE, updatedAt: '2026-09-01T00:00:00Z' };
  const pages = issuePages(spec);
  let releasePost;
  const gate = new Promise(resolve => { releasePost = resolve; });
  pages[postPath(ISSUE)] = async () => { await gate; return { statusCode: 201, body: { id: 909 } }; };
  const { dataDir, api } = await freshOutbox(t, pages, { fingerprint: issueFp(spec) });
  const drainPromise = feedback.drainGithubFeedbackOutbox(drainOptions(dataDir, api));
  await new Promise(resolve => setImmediate(resolve));
  const enqueuePromise = feedback.enqueueGithubResolution({
    dataDir, issue: 3, revision: REV2, issueFingerprint: 'b'.repeat(64), capturedAt: NOW, source: 'dual_review', reviewedBy: 'codex',
  }, { config: makeConfig() });
  releasePost();
  const [drained, enqueued] = await Promise.all([drainPromise, enqueuePromise]);
  assert.equal(drained.ok, true);
  assert.equal(enqueued.ok, true, '与 drain 并发的入队不丢');
  const outbox = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-outbox.json'), 'utf8'));
  assert.equal(outbox.entries[`${ISSUE}:${REV}`].public.status, 'delivered');
  assert.ok(outbox.entries[`3:${REV2}`], '并发入队的新条目保留');

  // 采集与送达交错：collect 的锁内合并保留 delivered。
  await collectOnce(t, { request: githubApi(issuePages(spec)).request, dataDir, now: () => NOW + 5000 });
  const store = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-feedback.json'), 'utf8'));
  assert.equal(store.delivered[ISSUE].commentId, 909, 'collect 不抹掉送达回执');
});

test('单飞锁：存活属主不抢、已死属主回收、损坏锁不抢；锁外进程不发送', async (t) => {
  const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise(resolve => dead.once('exit', resolve));
  const spec = { ...PENDING_ISSUE, updatedAt: '2026-09-01T00:00:00Z' };
  const pages = issuePages(spec);
  pages[postPath(ISSUE)] = () => ({ statusCode: 201, body: { id: 1 } });
  const { dataDir } = await freshOutbox(t, pages, { fingerprint: issueFp(spec) });
  const lockPath = path.join(dataDir, 'evolution-github-outbox.lock');
  fs.writeFileSync(lockPath, `${JSON.stringify({ pid: dead.pid, token: 'gone', at: NOW })}\n`);
  const result = await feedback.drainGithubFeedbackOutbox(drainOptions(dataDir, githubApi(pages)));
  assert.equal(result.ok, true, '死锁回收后正常执行');

  const alive = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  t.after(() => alive.kill('SIGKILL'));
  await new Promise(resolve => alive.once('spawn', resolve));
  const blocked = await freshOutbox(t, pages, { fingerprint: issueFp(spec) });
  fs.writeFileSync(path.join(blocked.dataDir, 'evolution-github-outbox.lock'), `${JSON.stringify({ pid: alive.pid, token: 'live', at: NOW })}\n`);
  const liveApi = githubApi(pages);
  const locked = await feedback.drainGithubFeedbackOutbox(drainOptions(blocked.dataDir, liveApi));
  assert.equal(locked.reason, 'locked');
  assert.equal(liveApi.calls.length, 0, '锁被存活属主持有时绝不发送');

  const corrupt = await freshOutbox(t, pages, { fingerprint: issueFp(spec) });
  fs.writeFileSync(path.join(corrupt.dataDir, 'evolution-github-outbox.lock'), 'not-json{{{');
  const corruptApi = githubApi(pages);
  const refused = await feedback.drainGithubFeedbackOutbox(drainOptions(corrupt.dataDir, corruptApi));
  assert.equal(refused.reason, 'locked', '损坏锁无法证明属主死亡：不抢');
  assert.equal(corruptApi.calls.length, 0);
  assert.equal(fs.readFileSync(path.join(corrupt.dataDir, 'evolution-github-outbox.lock'), 'utf8'), 'not-json{{{', '损坏锁原样保留给属主');
});

test('双 Agent 收口：fixed 映射必须携带与批次一致的报告指纹；批次身份不只看时间戳', async (t) => {
  const dataDir = tmpDir(t);
  const spec = { ...PENDING_ISSUE, updatedAt: '2026-09-01T00:00:00Z' };
  await collectOnce(t, { request: githubApi(issuePages(spec)).request, dataDir });
  const batch = feedback.captureFeedbackBatch({ config: makeConfig(), dataDir });
  const summary = feedback.summarizeBatch(batch);
  const fingerprint = batch.issues.find(item => item.number === ISSUE).fingerprint;
  assert.equal(fingerprint, issueFp(spec), '批次内指纹与语义指纹一致');
  const journal = (resolutions, patch = {}) => ({
    status: 'completed', phase: 'complete', decision: 'approve', head: REV,
    reviewFeedback: '复核通过：回归全绿', githubResolutions: resolutions, ...patch,
  });
  const pages = issuePages(spec);
  pages[postPath(ISSUE)] = () => ({ statusCode: 201, body: { id: 555 } });
  const sentPrivate = [];
  const run = async (apiPages, payload, overrides = {}) => {
    const api = githubApi(apiPages);
    const result = await feedback.handlePublishedEvolution(payload, {
      config: makeConfig(), dataDir, request: api.request,
      publishedCheck: async () => true,
      sendPrivate: async (title, content) => { sentPrivate.push(content); },
      now: () => NOW, ...overrides,
    });
    return { result, api };
  };
  const base = { status: 'pending_apply', commit: REV, dualAgentEnabled: true, mainAgent: 'codex', batchSummary: summary,
    journal: journal([{ issue: ISSUE, status: 'fixed', fingerprint }]), changeSummary: '修复启动崩溃' };

  const approved = await run(pages, base);
  assert.equal(approved.result.ok, true);
  assert.equal(approved.result.enqueued, 1);
  assert.equal(approved.api.calls.filter(call => call.method === 'POST').length, 1, '发布核对通过后立即排空发件箱');
  assert.match(sentPrivate[0], /验证：复核通过：回归全绿/, '私有报告带主复核的验证结论');
  assert.match(sentPrivate[0], /公开回复：已发送/);

  // 重复收口幂等。
  const repeat = await run(pages, base);
  assert.equal(repeat.result.enqueued, 0);
  assert.equal(repeat.api.calls.filter(call => call.method === 'POST').length, 0);

  const cases = [
    [{ status: 'push_failed' }, 'not_published'],
    [{ commit: 'not-a-sha' }, 'invalid_revision'],
    [{ batchSummary: null }, 'no_batch'],
    [{ batchSummary: { ...summary, capturedAt: summary.capturedAt - 1 } }, 'batch_mismatch'],
    [{ batchSummary: { ...summary, fingerprint: 'e'.repeat(64) } }, 'batch_mismatch'],
    [{ journal: journal([{ issue: ISSUE, status: 'fixed' }]) }, undefined], // 缺指纹
    [{ journal: journal([{ issue: ISSUE, status: 'fixed', fingerprint: 'f'.repeat(64) }]) }, undefined], // 指纹不符
    [{ journal: journal([{ issue: ISSUE, status: 'in_progress', fingerprint }]) }, undefined],
    [{ journal: journal([{ issue: 999, status: 'fixed', fingerprint }]) }, undefined],
    [{ journal: journal(null, { decision: 'no_change' }) }, 'journal_not_approved'],
    [{ journal: journal(null, { status: 'failed' }) }, 'journal_not_approved'],
    [{ journal: journal(null, { head: 'f'.repeat(40) }) }, 'journal_not_approved'],
    [{ journal: journal(null, { repairOnly: true }) }, 'journal_not_approved'],
  ];
  for (const [patch, reason] of cases) {
    const freshData = tmpDir(t);
    await collectOnce(t, { request: githubApi(issuePages(spec)).request, dataDir: freshData });
    // 每个用例用自己的不可变批次（同一报告快照 → 同一指纹），patch 覆盖被测字段。
    const payload = { ...base, batchSummary: feedback.summarizeBatch(feedback.captureFeedbackBatch({ config: makeConfig(), dataDir: freshData })), ...patch };
    const api = githubApi(pages);
    const result = await feedback.handlePublishedEvolution(payload, {
      config: makeConfig(), dataDir: freshData, request: api.request,
      publishedCheck: async () => true, sendPrivate: async () => {}, now: () => NOW,
    });
    if (reason) assert.equal(result.reason, reason, JSON.stringify(payload.journal?.githubResolutions));
    else assert.equal(result.enqueued, 0, '无有效 fixed 指纹映射不入队');
    assert.equal(api.calls.filter(call => call.method === 'POST').length, 0);
  }

  // 配置身份变化（同仓库不同 owner/token）：批次不属于当前配置。
  const otherConfig = makeConfig({ token: 'ghp_othertoken99' });
  const apiOther = githubApi(pages);
  const mismatched = await feedback.handlePublishedEvolution(base, {
    config: otherConfig, dataDir, request: apiOther.request, publishedCheck: async () => true, sendPrivate: async () => {}, now: () => NOW,
  });
  assert.equal(mismatched.reason, 'batch_mismatch');

  // 批次采集不完整时即使有 approve 映射也不得声称修复。
  const incompleteData = tmpDir(t);
  await collectOnce(t, { request: githubApi(issuePages(spec)).request, dataDir: incompleteData });
  const store = JSON.parse(fs.readFileSync(path.join(incompleteData, 'evolution-github-feedback.json'), 'utf8'));
  store.collection = { state: 'partial', reason: 'timeout', collectedAt: NOW, issuesTruncated: false };
  fs.writeFileSync(path.join(incompleteData, 'evolution-github-feedback.json'), JSON.stringify(store));
  const incompleteBatch = feedback.captureFeedbackBatch({ config: makeConfig(), dataDir: incompleteData });
  const apiIncomplete = githubApi(pages);
  const blockedResult = await feedback.handlePublishedEvolution({ ...base, batchSummary: feedback.summarizeBatch(incompleteBatch) }, {
    config: makeConfig(), dataDir: incompleteData, request: apiIncomplete.request,
    publishedCheck: async () => true, sendPrivate: async () => {}, now: () => NOW,
  });
  assert.equal(blockedResult.reason, 'batch_incomplete');
  assert.equal(apiIncomplete.calls.length, 0);
});

test('单 Agent 收口：回执四元组（issue+指纹+仓库+提交）全对齐才入队；错位回执一律拒绝', async (t) => {
  const spec = { ...PENDING_ISSUE, updatedAt: '2026-09-01T00:00:00Z' };
  // 真实助手签名：runGithubFixReview(args, options)——options 是第二个参数（依赖注入）。
  const reviewStub = {
    runGithubFixReview: async (args, options) => {
      reviewStub.calls.push({ args, options });
      if (reviewStub.fail) return { ok: false, reason: 'agent_failed' };
      return {
        ok: true,
        receipts: (reviewStub.receipts || [{
          approved: true, issue: args.issues[0].number, status: 'fixed',
          revision: args.revision, repo: args.repo, fingerprint: args.issues[0].fingerprint,
          cause: '配置解析崩溃', change: '修复解析', verification: '回归通过', reviewedBy: 'claude',
        }]).map(receipt => ({ reviewedBy: 'claude', ...receipt })),
      };
    },
    calls: [],
    fail: false,
    receipts: null,
  };
  const stubPath = require.resolve('../src/services/evolution-github-review');
  const previousStub = require.cache[stubPath];
  require.cache[stubPath] = { id: stubPath, loaded: true, exports: reviewStub };
  t.after(() => {
    if (previousStub) require.cache[stubPath] = previousStub;
    else delete require.cache[stubPath];
  });

  const dataDir = tmpDir(t);
  await collectOnce(t, { request: githubApi(issuePages(spec)).request, dataDir });
  const batch = feedback.captureFeedbackBatch({ config: makeConfig(), dataDir });
  const pages = issuePages(spec);
  pages[postPath(ISSUE)] = () => ({ statusCode: 201, body: { id: 777 } });
  const api = githubApi(pages);
  const reviewOptions = { remoteHead: async () => REV }; // 注入依赖经第二参数，不在 args 里
  const result = await feedback.handlePublishedEvolution({
    status: 'pending_apply', commit: REV, dualAgentEnabled: false, mainAgent: 'claude',
    batchSummary: feedback.summarizeBatch(batch), journal: null, changeSummary: '修复配置解析',
  }, { config: makeConfig(), dataDir, request: api.request, publishedCheck: async () => true, sendPrivate: async () => {}, now: () => NOW, reviewOptions });
  assert.equal(result.ok, true);
  assert.equal(result.enqueued, 1, '四元组对齐的 approved+fixed 才入队');
  assert.equal(reviewStub.calls[0].args.revision, REV);
  assert.equal(reviewStub.calls[0].args.repo, REPO, '复核上下文显式带仓库');
  assert.deepEqual(reviewStub.calls[0].options, reviewOptions, '依赖注入走第二参数');
  assert.deepEqual(reviewStub.calls[0].args.issues.map(issue => issue.number), [ISSUE]);
  assert.equal(reviewStub.calls[0].args.changeSummary, '修复配置解析');
  const outbox = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-outbox.json'), 'utf8'));
  assert.equal(outbox.entries[`${ISSUE}:${REV}`].source, 'single_review');
  assert.equal(outbox.entries[`${ISSUE}:${REV}`].issueFingerprint, batch.issues[0].fingerprint, '入队钉批次报告指纹');
  assert.match(outbox.entries[`${ISSUE}:${REV}`].detail.cause, /配置解析崩溃/);

  // 错位回执：别的 issue / 别的指纹 / 别的仓库 / 别的提交——即使 approved+fixed 也绝不入队。
  for (const [name, receipt] of [
    ['别的 issue', { issue: 3, revision: REV, repo: REPO, fingerprint: batch.issues[0].fingerprint }],
    ['别的报告指纹', { issue: ISSUE, revision: REV, repo: REPO, fingerprint: 'f'.repeat(64) }],
    ['别的仓库', { issue: ISSUE, revision: REV, repo: 'owner/other-farm', fingerprint: batch.issues[0].fingerprint }],
    ['别的提交', { issue: ISSUE, revision: '9'.repeat(40), repo: REPO, fingerprint: batch.issues[0].fingerprint }],
  ]) {
    const wrongData = tmpDir(t);
    await collectOnce(t, { request: githubApi(issuePages(spec)).request, dataDir: wrongData });
    const wrongBatch = feedback.captureFeedbackBatch({ config: makeConfig(), dataDir: wrongData });
    reviewStub.receipts = [{ approved: true, status: 'fixed', cause: 'c', change: 'ch', verification: 'v', ...receipt }];
    const wrongApi = githubApi(issuePages(spec));
    const wrong = await feedback.handlePublishedEvolution({
      status: 'pending_apply', commit: REV, dualAgentEnabled: false, mainAgent: 'claude',
      batchSummary: feedback.summarizeBatch(wrongBatch), journal: null,
    }, { config: makeConfig(), dataDir: wrongData, request: wrongApi.request, publishedCheck: async () => true, sendPrivate: async () => {}, now: () => NOW });
    assert.equal(wrong.ok, true, name);
    assert.equal(wrong.enqueued, 0, `${name}：错位回执不入队`);
    assert.equal(wrongApi.calls.filter(call => call.method === 'POST').length, 0, `${name}：零公开发送`);
  }
  reviewStub.receipts = null;

  reviewStub.fail = true;
  const failData = tmpDir(t);
  await collectOnce(t, { request: githubApi(issuePages(spec)).request, dataDir: failData });
  const failBatch = feedback.captureFeedbackBatch({ config: makeConfig(), dataDir: failData });
  const failApi = githubApi(issuePages(spec));
  const failed = await feedback.handlePublishedEvolution({
    status: 'pending_apply', commit: REV, dualAgentEnabled: false, mainAgent: 'claude',
    batchSummary: feedback.summarizeBatch(failBatch), journal: null,
  }, { config: makeConfig(), dataDir: failData, request: failApi.request, publishedCheck: async () => true, sendPrivate: async () => {}, now: () => NOW });
  assert.equal(failed.reason, 'agent_failed');
  assert.equal(failApi.calls.filter(call => call.method === 'POST').length, 0);
  assert.equal(fs.existsSync(path.join(failData, 'evolution-github-outbox.json')), false);
});

test('收集器：立即采集 + 有界轮询；未启用零定时器；单飞不重入', async (t) => {
  assert.equal(feedback.startGithubFeedbackCollector({ config: {} }).reason, 'disabled');
  const dataDir = tmpDir(t);
  const api = githubApi(issuePages(PENDING_ISSUE));
  const started = feedback.startGithubFeedbackCollector({ config: makeConfig(), dataDir, request: api.request, now: () => NOW });
  assert.equal(started.ok, true);
  assert.ok(started.pollMs >= 15 * 60 * 1000 && started.pollMs <= 30 * 60 * 1000);
  assert.equal(feedback.startGithubFeedbackCollector({ config: makeConfig(), dataDir }).alreadyStarted, true);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(fs.existsSync(path.join(dataDir, 'evolution-github-feedback.json')), true, '启动后立即采集一次');
  feedback.stopGithubFeedbackCollector();
  feedback.stopGithubFeedbackCollector();
  const calls = api.calls.length;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(api.calls.length, calls, '停止后不再轮询');
});

test('批次载荷摘要：改 issue 正文/评论但保留旧顶层元数据 = 整批拒用，绝不发送', async (t) => {
  const spec = { ...PENDING_ISSUE, updatedAt: '2026-09-01T00:00:00Z' };
  const run = async (mutate) => {
    const dataDir = tmpDir(t);
    await collectOnce(t, { request: githubApi(issuePages(spec)).request, dataDir });
    const batch = feedback.captureFeedbackBatch({ config: makeConfig(), dataDir });
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-batch.json'), 'utf8'));
    mutate(stored);
    // 顶层元数据（时间戳/报告指纹）原样保留——只有载荷摘要能发现内容被换。
    fs.writeFileSync(path.join(dataDir, 'evolution-github-batch.json'), JSON.stringify(stored));
    const pages = issuePages(spec);
    pages[postPath(ISSUE)] = () => ({ statusCode: 201, body: { id: 1 } });
    const api = githubApi(pages);
    const result = await feedback.handlePublishedEvolution({
      status: 'pending_apply', commit: REV, dualAgentEnabled: true, mainAgent: 'codex',
      batchSummary: feedback.summarizeBatch(batch),
      journal: { status: 'completed', phase: 'complete', decision: 'approve', head: REV,
        githubResolutions: [{ issue: ISSUE, status: 'fixed', fingerprint: batch.issues[0].fingerprint }] },
    }, { config: makeConfig(), dataDir, request: api.request, publishedCheck: async () => true, sendPrivate: async () => {}, now: () => NOW });
    return { result, api };
  };

  // 篡改正文（新报告内容顶替旧快照，顶层 fingerprint 不变）。
  const body = await run(stored => { stored.issues[0].body = '被替换的正文'; });
  assert.equal(body.result.reason, 'batch_mismatch', '正文被改：载荷摘要失配');
  assert.equal(body.api.calls.filter(call => call.method === 'POST').length, 0);

  // 篡改评论（追加一条没采集过的评论）。
  const comment = await run(stored => {
    stored.issues[0].comments.push({ id: 999, author: 'someone', createdAt: '2026-09-02T00:00:00.000Z', body: '注入的评论' });
  });
  assert.equal(comment.result.reason, 'batch_mismatch', '评论被改：载荷摘要失配');
  assert.equal(comment.api.calls.filter(call => call.method === 'POST').length, 0);

  // 摘要侧同步改了载荷摘要字段（伪造成「看起来一致」）也不行：重算必须对上落盘值。
  const forged = await run(stored => {
    stored.issues[0].body = '被替换的正文';
    stored.payloadDigest = crypto.createHash('sha256').update(' forged').digest('hex');
  });
  assert.equal(forged.result.reason, 'batch_mismatch');

  // 未篡改的对照组：正常入队发送。
  const clean = await run(() => {});
  assert.equal(clean.result.enqueued, 1, '未篡改批次照常收口');
});

test('预算裁剪钉住复核者实际看到的条目：被裁掉的 issue 不得凭完整批次授权 fixed', async (t) => {
  const dataDir = tmpDir(t);
  // 12 条大正文 issue：小节预算只装得下前若干条，尾部整条被裁。
  const specs = Array.from({ length: 12 }, (_, index) => ({
    number: index + 1, title: `问题${index + 1}`, body: 'x'.repeat(4000), author: 'reporter', comments: [],
    updatedAt: '2026-09-01T00:00:00Z',
  }));
  await collectOnce(t, { request: githubApi(collectPages(specs)).request, dataDir });
  const batch = feedback.captureFeedbackBatch({ config: makeConfig(), dataDir });
  assert.ok(batch.issues.length > 1);
  const jsonLine = feedback.buildGithubFeedbackSection(batch).split('\n').find(line => line.startsWith('[{'));
  const injected = new Set(JSON.parse(jsonLine).map(issue => issue.number));
  const droppedIssue = batch.issues.find(issue => !injected.has(issue.number));
  assert.ok(droppedIssue, '必须有被预算裁掉的条目');
  // 复核者没看到 droppedIssue：即使 journal 带正确指纹的 fixed 映射也不得入队。
  const visibleIssue = batch.issues.find(issue => injected.has(issue.number));
  const pages = collectPages(specs);
  pages[postPath(visibleIssue.number)] = () => ({ statusCode: 201, body: { id: 1 } });
  const api = githubApi(pages);
  const result = await feedback.handlePublishedEvolution({
    status: 'pending_apply', commit: REV, dualAgentEnabled: true, mainAgent: 'codex',
    batchSummary: feedback.summarizeBatch(batch),
    journal: { status: 'completed', phase: 'complete', decision: 'approve', head: REV,
      githubResolutions: [
        { issue: droppedIssue.number, status: 'fixed', fingerprint: droppedIssue.fingerprint },
        { issue: visibleIssue.number, status: 'fixed', fingerprint: visibleIssue.fingerprint },
      ] },
  }, { config: makeConfig(), dataDir, request: api.request, publishedCheck: async () => true, sendPrivate: async () => {}, now: () => NOW });
  assert.equal(result.enqueued, 1, '只有复核者实际看到的条目可入队');
  const outbox = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-outbox.json'), 'utf8'));
  assert.ok(outbox.entries[`${visibleIssue.number}:${REV}`], '可见条目入队');
  assert.equal(outbox.entries[`${droppedIssue.number}:${REV}`], undefined, '被裁条目绝不入队');
});

test('owner 拒绝边界扣留：被拒提交的未发送条目终态取消，其他条目不受牵连', async (t) => {
  const spec = { ...PENDING_ISSUE, updatedAt: '2026-09-01T00:00:00Z' };
  const spec3 = { number: 3, title: 't', body: 'b', author: 'reporter', comments: [], updatedAt: '2026-09-01T00:00:00Z' };
  const dataDir = tmpDir(t);
  await feedback.enqueueGithubResolution({
    dataDir, issue: ISSUE, revision: REV, issueFingerprint: issueFp(spec), capturedAt: NOW, source: 'dual_review', reviewedBy: 'codex',
  }, { config: makeConfig() });
  await feedback.enqueueGithubResolution({
    dataDir, issue: 3, revision: REV2, issueFingerprint: issueFp(spec3), capturedAt: NOW, source: 'dual_review', reviewedBy: 'codex',
  }, { config: makeConfig() });
  const held = await feedback.holdGithubFeedbackForRevision({ commit: REV }, { config: makeConfig(), dataDir, now: () => NOW });
  assert.equal(held.ok, true);
  assert.equal(held.heldCount, 1);
  assert.deepEqual(held.held, [{ issue: ISSUE, revision: REV }]);
  let outbox = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-outbox.json'), 'utf8'));
  assert.equal(outbox.entries[`${ISSUE}:${REV}`].public.status, 'superseded');
  assert.equal(outbox.entries[`${ISSUE}:${REV}`].public.lastReason, 'owner_reverting');
  assert.equal(outbox.entries[`3:${REV2}`].public.status, 'pending', '其他提交的条目不受牵连');
  // 幂等：重复扣留不报错不改状态。
  await feedback.holdGithubFeedbackForRevision({ commit: REV }, { config: makeConfig(), dataDir });
  outbox = JSON.parse(fs.readFileSync(path.join(dataDir, 'evolution-github-outbox.json'), 'utf8'));
  assert.equal(outbox.entries[`${ISSUE}:${REV}`].public.status, 'superseded');

  // 排空：被扣条目零 POST、私有报告如实说明 owner 拒绝；无关条目照常发送。
  const pages = issuePages(spec);
  Object.assign(pages, detailPages(spec3));
  pages[LIST_PATH] = [listItem(spec), listItem(spec3)];
  pages[postPath(3)] = () => ({ statusCode: 201, body: { id: 31 } });
  const api = githubApi(pages);
  const sent = [];
  await feedback.drainGithubFeedbackOutbox(drainOptions(dataDir, api, {
    sendPrivate: async (title, content) => { sent.push(content); },
  }));
  assert.equal(api.calls.filter(call => call.method === 'POST' && call.apiPath === postPath(ISSUE)).length, 0,
    '被拒提交的条目绝不公开回复');
  assert.equal(api.calls.filter(call => call.method === 'POST' && call.apiPath === postPath(3)).length, 1,
    '其他提交的条目照常发送');
  assert.match(sent.join('\n'), /owner 已拒绝该提交并正在回退/, '私有报告如实说明扣留原因');

  // 已送达条目不回撤：先送达再拒绝，送达事实保留。
  const doneDir = tmpDir(t);
  const donePages = issuePages(spec);
  donePages[postPath(ISSUE)] = () => ({ statusCode: 201, body: { id: 9 } });
  const doneApi = githubApi(donePages);
  await feedback.enqueueGithubResolution({
    dataDir: doneDir, issue: ISSUE, revision: REV, issueFingerprint: issueFp(spec), capturedAt: NOW, source: 'dual_review', reviewedBy: 'codex',
  }, { config: makeConfig() });
  await feedback.drainGithubFeedbackOutbox(drainOptions(doneDir, doneApi));
  await feedback.holdGithubFeedbackForRevision({ commit: REV }, { config: makeConfig(), dataDir: doneDir });
  const doneOutbox = JSON.parse(fs.readFileSync(path.join(doneDir, 'evolution-github-outbox.json'), 'utf8'));
  assert.equal(doneOutbox.entries[`${ISSUE}:${REV}`].public.status, 'delivered', '已送达不撤回（不否认已发布事实）');
});

test('空发件箱先拒绝：永久仓库+提交墓碑阻止迟到入队和批准 hook，双通道均无成功声明', async (t) => {
  const dataDir = tmpDir(t);
  const spec = { ...PENDING_ISSUE, updatedAt: '2026-09-01T00:00:00Z' };
  await collectOnce(t, { request: githubApi(issuePages(spec)).request, dataDir });
  const batch = feedback.captureFeedbackBatch({ config: makeConfig(), dataDir });
  const capturedIssue = batch.issues[0];
  const held = await feedback.holdGithubFeedbackForRevision({ commit: REV }, { config: makeConfig(), dataDir, now: () => NOW });
  assert.equal(held.ok, true);
  assert.equal(held.heldCount, 0, '还没有任何可取消的条目');
  const file = path.join(dataDir, 'evolution-github-outbox.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.entries, {});
  assert.deepEqual(saved.heldRevisions[`${REPO}:${REV}`], { repo: REPO, revision: REV, reason: 'owner_reverting', at: NOW });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, '空发件箱拒绝事实也私有持久化');

  const late = await feedback.enqueueGithubResolution({
    dataDir, issue: ISSUE, revision: REV, issueFingerprint: capturedIssue.fingerprint,
    capturedAt: batch.capturedAt, source: 'dual_review', reviewedBy: 'claude',
  }, { config: makeConfig() });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'revision_held', '重新读取持久化拒绝墓碑后，晚到的直接入队被挡住');

  const api = githubApi(issuePages(spec));
  let publicationChecks = 0;
  const privateReports = [];
  const lateApproved = await feedback.handlePublishedEvolution({
    status: 'pending_apply', commit: REV, dualAgentEnabled: true, mainAgent: 'claude',
    batchSummary: feedback.summarizeBatch(batch),
    journal: { status: 'completed', decision: 'approve', head: REV,
      githubResolutions: [{ issue: ISSUE, status: 'fixed', fingerprint: capturedIssue.fingerprint }] },
  }, { config: makeConfig(), dataDir, request: api.request,
    publishedCheck: async () => { publicationChecks += 1; return true; }, // revert/push 仍未结束，远端仍是旧提交
    sendPrivate: async (_title, content) => { privateReports.push(content); }, now: () => NOW });
  assert.equal(lateApproved.ok, true);
  assert.equal(lateApproved.enqueued, 0, '有效批准回执晚于拒绝也不能复活旧提交');
  assert.equal(publicationChecks, 0, '拒绝墓碑先于所有发送发布核对');
  assert.equal(api.calls.length, 0, '拒绝期间零公开读写请求');
  assert.deepEqual(privateReports, [], '没有条目就没有私有成功声明');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).entries, {});

  // 墓碑只作用于被拒的仓库+提交：新提交和其他仓库仍可入队，写回时保留原拒绝事实。
  assert.equal((await feedback.enqueueGithubResolution({
    dataDir, issue: ISSUE, revision: REV2, issueFingerprint: capturedIssue.fingerprint,
  }, { config: makeConfig() })).ok, true);
  assert.equal((await feedback.enqueueGithubResolution({
    dataDir, issue: 3, revision: REV, issueFingerprint: capturedIssue.fingerprint,
  }, { config: makeConfig({ repo: 'owner/another-farm' }) })).ok, true);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).heldRevisions[`${REPO}:${REV}`], '后续条目写回不能覆盖拒绝墓碑');
});

test('发送前重读拒绝墓碑：恢复出的旧 pending 条目零公开请求，私有只报告取消原因', async (t) => {
  const spec = { ...PENDING_ISSUE, updatedAt: '2026-09-01T00:00:00Z' };
  const { dataDir, api } = await freshOutbox(t, issuePages(spec), { fingerprint: issueFp(spec) });
  const file = path.join(dataDir, 'evolution-github-outbox.json');
  const beforeHold = JSON.parse(fs.readFileSync(file, 'utf8'));
  await feedback.holdGithubFeedbackForRevision({ commit: REV }, { config: makeConfig(), dataDir, now: () => NOW });
  const heldOutbox = JSON.parse(fs.readFileSync(file, 'utf8'));
  // 模拟恢复系统带回旧 pending 条目；拒绝墓碑仍在，发送门不能依赖条目状态已被取消。
  heldOutbox.entries = beforeHold.entries;
  fs.writeFileSync(file, JSON.stringify(heldOutbox));
  const privateReports = [];
  let publicationChecks = 0;
  const result = await feedback.drainGithubFeedbackOutbox(drainOptions(dataDir, api, {
    publishedCheck: async () => { publicationChecks += 1; return true; },
    sendPrivate: async (_title, content) => { privateReports.push(content); },
  }));
  assert.equal(result.ok, true);
  assert.equal(publicationChecks, 0);
  assert.equal(api.calls.length, 0, '迟到 pending 条目在所有 GitHub 请求之前被扣留');
  assert.equal(privateReports.length, 1);
  assert.match(privateReports[0], /owner 已拒绝该提交并正在回退/);
  assert.doesNotMatch(privateReports[0], /公开回复：已发送|已修复（fixed）/);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.entries[`${ISSUE}:${REV}`].public.status, 'superseded');
  assert.equal(saved.entries[`${ISSUE}:${REV}`].public.lastReason, 'owner_reverting');
  assert.ok(saved.heldRevisions[`${REPO}:${REV}`]);
});

test('死锁回收互斥：他人在回收/墓碑状态不明时保守放弃，绝不误删新属主的锁', async (t) => {
  const spec = { ...PENDING_ISSUE, updatedAt: '2026-09-01T00:00:00Z' };
  const pages = issuePages(spec);
  pages[postPath(ISSUE)] = () => ({ statusCode: 201, body: { id: 1 } });

  // 场景 A：回收互斥墓碑被存活进程持有——即使主锁是死锁，本轮也不回收（pending）。
  const alive = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  t.after(() => alive.kill('SIGKILL'));
  await new Promise(resolve => alive.once('spawn', resolve));
  const mutexData = tmpDir(t);
  const mutexRun = await freshOutbox(t, pages, { fingerprint: issueFp(spec) });
  fs.writeFileSync(path.join(mutexRun.dataDir, 'evolution-github-outbox.lock.reclaim'),
    `${JSON.stringify({ pid: alive.pid, token: 'busy', at: Date.now() })}\n`);
  const deadA = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise(resolve => deadA.once('exit', resolve));
  fs.writeFileSync(path.join(mutexRun.dataDir, 'evolution-github-outbox.lock'),
    `${JSON.stringify({ pid: deadA.pid, token: 'gone', at: NOW })}\n`);
  const mutexApi = githubApi(pages);
  const refused = await feedback.drainGithubFeedbackOutbox(drainOptions(mutexRun.dataDir, mutexApi));
  assert.equal(refused.reason, 'locked', '回收互斥被占用：本轮保守放弃');
  assert.equal(mutexApi.calls.length, 0, '零外呼');
  assert.equal(JSON.parse(fs.readFileSync(path.join(mutexRun.dataDir, 'evolution-github-outbox.lock'), 'utf8')).token, 'gone',
    '死锁原样保留给互斥属主处理');
  void mutexData;

  // 场景 B：孤儿墓碑（属主已死且超龄）+ 死主锁：正常回收后发送。
  const orphanRun = await freshOutbox(t, pages, { fingerprint: issueFp(spec) });
  const deadB = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise(resolve => deadB.once('exit', resolve));
  fs.writeFileSync(path.join(orphanRun.dataDir, 'evolution-github-outbox.lock.reclaim'),
    `${JSON.stringify({ pid: deadB.pid, token: 'orphan', at: Date.now() - 60 * 1000 })}\n`);
  fs.writeFileSync(path.join(orphanRun.dataDir, 'evolution-github-outbox.lock'),
    `${JSON.stringify({ pid: deadB.pid, token: 'gone', at: NOW })}\n`);
  const orphanApi = githubApi(pages);
  const recovered = await feedback.drainGithubFeedbackOutbox(drainOptions(orphanRun.dataDir, orphanApi));
  assert.equal(recovered.ok, true, '孤儿墓碑超龄清理后死锁回收照常工作');
  assert.equal(orphanApi.calls.filter(call => call.method === 'POST').length, 1);

  // 场景 C：存活属主/损坏锁语义不变（回归保护）。
  const liveRun = await freshOutbox(t, pages, { fingerprint: issueFp(spec) });
  fs.writeFileSync(path.join(liveRun.dataDir, 'evolution-github-outbox.lock'),
    `${JSON.stringify({ pid: alive.pid, token: 'live', at: NOW })}\n`);
  const liveApi = githubApi(pages);
  const liveBlocked = await feedback.drainGithubFeedbackOutbox(drainOptions(liveRun.dataDir, liveApi));
  assert.equal(liveBlocked.reason, 'locked');
  assert.equal(liveApi.calls.length, 0);
});

test('跨进程死锁竞争：多进程同时认定同一把死锁，公开回复仍恰好一次', async (t) => {
  const spec = { ...PENDING_ISSUE, updatedAt: '2026-09-01T00:00:00Z' };
  const { dataDir } = await freshOutbox(t, issuePages(spec), { fingerprint: issueFp(spec) });
  const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise(resolve => dead.once('exit', resolve));
  fs.writeFileSync(path.join(dataDir, 'evolution-github-outbox.lock'),
    `${JSON.stringify({ pid: dead.pid, token: 'gone', at: Date.now() })}\n`);
  const postLog = path.join(dataDir, 'posts.log');
  // 子进程内的 issue 详情必须逐字等于入队指纹对应的报告内容：新鲜度核对会重算指纹，
  // 内容不一致会把条目标 stale，竞争场景就测不到真正的 POST 恰好一次。
  const detailBody = {
    number: spec.number, title: spec.title, body: spec.body, state: 'open',
    user: { login: spec.author }, comments: 0, updated_at: spec.updatedAt,
  };
  const childScript = `
    const fs = require('node:fs');
    const feedback = require(${JSON.stringify(require.resolve('../src/services/evolution-github-feedback'))});
    const REPO = ${JSON.stringify(REPO)};
    const request = async (apiPath, opts = {}) => {
      if (opts.method === 'POST') { fs.appendFileSync(${JSON.stringify(postLog)}, apiPath + '\\n'); return { statusCode: 201, body: { id: 555 } }; }
      if (apiPath === '/user') return { statusCode: 200, body: { login: 'owner' } };
      if (apiPath === '/repos/' + REPO + '/issues/2') return { statusCode: 200, body: ${JSON.stringify(detailBody)} };
      if (apiPath.startsWith('/repos/' + REPO + '/issues/2/comments')) return { statusCode: 200, body: [] };
      return { statusCode: 404, body: null };
    };
    feedback.drainGithubFeedbackOutbox({
      config: { evolutionGithubFeedback: { enabled: true, repo: REPO, ownerLogin: 'owner', token: 'ghp_testtoken01', publicActions: ['git_pull'] } },
      dataDir: ${JSON.stringify(dataDir)}, request, publishedCheck: async () => true,
      sendPrivate: async () => {}, now: () => Date.parse('2026-10-01T08:00:00Z'),
    }).then(result => fs.writeFileSync(process.env.OUT, JSON.stringify(result)))
      .catch(error => fs.writeFileSync(process.env.OUT, JSON.stringify({ ok: false, error: String(error) })));
  `;
  const children = Array.from({ length: 8 }, (_, index) => {
    const out = path.join(dataDir, `child-${index}.json`);
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', childScript], {
        env: { ...process.env, OUT: out, FARM_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'farm-race-child-')), FARM_PRIVATE_CONFIG_FILE: path.join(dataDir, 'none.json') },
        stdio: 'ignore',
      });
      child.once('exit', () => resolve(out));
    });
  });
  const outs = await Promise.all(children);
  const posts = fs.existsSync(postLog) ? fs.readFileSync(postLog, 'utf8').split('\n').filter(Boolean) : [];
  assert.equal(posts.length, 1, `8 个进程竞争同一把死锁：公开回复恰好一次（实际 ${posts.length}）`);
  const results = outs.map(out => JSON.parse(fs.readFileSync(out, 'utf8')));
  assert.ok(results.some(result => result.ok === true), '至少一个进程完成排空');
  for (const result of results) {
    if (result.ok !== true) assert.equal(result.reason, 'locked', `未完成进程只能因锁让位：${JSON.stringify(result)}`);
  }
});
