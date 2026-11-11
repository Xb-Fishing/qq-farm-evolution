'use strict';
// 回复后一周无跟进的自动关闭：仅使用合成 GitHub API、可控时间和独立临时数据。
// 导入前即隔离全部业务持久化；不联网、不启动 Agent、不修改真实配置或 issue。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEMP_ROOT = fs.realpathSync(os.tmpdir());
const ownedDirs = new Set();

function inside(dir, ...segments) {
  const root = path.resolve(dir);
  const target = path.resolve(root, ...segments);
  assert.ok(target === root || target.startsWith(`${root}${path.sep}`), 'fixture 路径必须留在已登记目录内');
  return target;
}

function makeTempDir(label) {
  const prefix = inside(TEMP_ROOT, `farm-github-followup-${label}-`);
  const dir = fs.mkdtempSync(prefix);
  ownedDirs.add(dir);
  return dir;
}

function cleanTempDir(dir) {
  assert.ok(ownedDirs.has(dir), '只清理本测试创建的目录');
  inside(TEMP_ROOT, path.relative(TEMP_ROOT, dir));
  fs.rmSync(dir, { recursive: true, force: true });
  ownedDirs.delete(dir);
}

const importDataDir = makeTempDir('import');
const previousDataDir = process.env.FARM_DATA_DIR;
const previousPrivateConfig = process.env.FARM_PRIVATE_CONFIG_FILE;
process.env.FARM_DATA_DIR = importDataDir;
process.env.FARM_PRIVATE_CONFIG_FILE = inside(importDataDir, 'missing-private-config.json');
test.after(() => {
  if (previousDataDir === undefined) delete process.env.FARM_DATA_DIR;
  else process.env.FARM_DATA_DIR = previousDataDir;
  if (previousPrivateConfig === undefined) delete process.env.FARM_PRIVATE_CONFIG_FILE;
  else process.env.FARM_PRIVATE_CONFIG_FILE = previousPrivateConfig;
  for (const dir of [...ownedDirs]) cleanTempDir(dir);
});

const feedback = require('../src/services/evolution-github-feedback');
const REPO = 'owner/example-farm';
const ISSUE = 4;
const REVISION = 'c'.repeat(40);
const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
const REPLIED_AT = Date.parse('2026-10-01T08:00:00Z');
const LIST_PATH = `/repos/${REPO}/issues?state=open&sort=updated&direction=desc&per_page=30`;
const issuePath = number => `/repos/${REPO}/issues/${number}`;
const iso = time => new Date(time).toISOString();
const clone = value => JSON.parse(JSON.stringify(value));

function makeConfig(overrides = {}) {
  return {
    evolutionGithubFeedback: {
      enabled: true,
      repo: REPO,
      ownerLogin: 'owner',
      autoCloseAfterReply: true,
      publicActions: ['git_pull'],
      ...overrides,
    },
  };
}

function comment(id, author, time, body = '合成评论', editedAt = time) {
  return { id, user: { login: author }, body, created_at: iso(time), updated_at: iso(editedAt) };
}

function repliedIssue(overrides = {}) {
  return {
    number: ISSUE,
    title: '合成部署反馈',
    body: '测试环境的合成反馈正文',
    user: { login: 'reporter' },
    state: 'open',
    locked: false,
    updated_at: iso(REPLIED_AT),
    comments: [comment(100, 'owner', REPLIED_AT, '请更新后重试，欢迎继续反馈。')],
    ...overrides,
  };
}

function mockGithub(specs) {
  const issues = new Map(specs.map(spec => [spec.number, clone(spec)]));
  const calls = [];
  const getCounts = new Map();
  const api = {
    issues,
    calls,
    listError: null,
    commentsError: null,
    onDetail: null,
    onPatch: null,
    resetCalls() { calls.length = 0; getCounts.clear(); },
    patches() { return calls.filter(call => call.method === 'PATCH'); },
    async request(apiPath, { method = 'GET', body } = {}) {
      calls.push({ apiPath, method, body: body === undefined ? undefined : clone(body) });
      if (method === 'GET' && apiPath === '/user') return { statusCode: 200, body: { login: 'owner' } };
      if (method === 'GET' && apiPath === LIST_PATH) {
        if (api.listError) return api.listError;
        return { statusCode: 200, body: [...issues.values()].filter(issue => issue.state === 'open').map(issue => {
          const { comments, ...raw } = issue;
          return { ...clone(raw), comments: comments.length };
        }) };
      }
      const match = apiPath.match(new RegExp(`^/repos/${REPO}/issues/(\\d+)(/comments\\?per_page=30&page=(\\d+))?$`));
      assert.ok(match, `不允许未登记的 GitHub API：${method} ${apiPath}`);
      const number = Number(match[1]);
      const issue = issues.get(number);
      if (!issue) return { statusCode: 404, body: null };
      if (match[2]) {
        assert.equal(method, 'GET', '测试禁止发送公开评论');
        if (api.commentsError) return api.commentsError;
        const page = Number(match[3]);
        return { statusCode: 200, body: clone(issue.comments.slice((page - 1) * 30, page * 30)) };
      }
      if (method === 'PATCH') {
        assert.equal(body.state, 'closed', '只允许本轮授权的关闭操作');
        if (api.onPatch) return api.onPatch(issue, body);
        issue.state = 'closed';
        return { statusCode: 200, body: { number, state: 'closed' } };
      }
      assert.equal(method, 'GET', '测试禁止未登记的写请求');
      const count = (getCounts.get(number) || 0) + 1;
      getCounts.set(number, count);
      const { comments, ...raw } = issue;
      const response = { ...clone(raw), comments: comments.length };
      if (api.onDetail) return api.onDetail(response, count, issue);
      return { statusCode: 200, body: response };
    },
  };
  return api;
}

async function fixture(t, { specs = [repliedIssue()], now = REPLIED_AT + WEEK, config = makeConfig(), verified = true } = {}) {
  const dataDir = makeTempDir('case');
  t.after(() => cleanTempDir(dataDir));
  const api = mockGithub(specs);
  if (verified) {
    for (const issue of api.issues.values()) {
      const reply = issue.comments.filter(row => row.user.login === 'owner').at(-1);
      if (reply) reply.body += `\n${feedback.deliveryMarker(issue.number, REVISION)}`;
    }
  }
  const clock = { now };
  const options = { config, dataDir, request: api.request, now: () => clock.now, publishedCheck: async () => true };
  const collected = await feedback.collectGithubFeedback(options);
  assert.equal(collected.ok, true, '必须通过真实采集生成隔离 store');
  if (verified) {
    const store = JSON.parse(fs.readFileSync(inside(dataDir, 'evolution-github-feedback.json'), 'utf8'));
    for (const issue of store.issues) {
      const reply = api.issues.get(issue.number).comments.filter(row => row.user.login === 'owner').at(-1);
      if (!reply) continue;
      const queued = await feedback.enqueueGithubResolution({ dataDir, issue: issue.number, revision: REVISION,
        issueFingerprint: issue.fingerprint, source: 'dual_review', reviewedBy: 'codex', capturedAt: now,
        detail: { cause: 'Synthetic confirmed defect', change: 'Published fix', verification: 'Isolated behavior regression' } }, options);
      assert.equal(queued.ok, true);
      const file = inside(dataDir, 'evolution-github-outbox.json');
      const outbox = JSON.parse(fs.readFileSync(file, 'utf8'));
      outbox.entries[queued.key].public = { status: 'delivered', commentId: reply.id, deliveredAt: REPLIED_AT };
      outbox.entries[queued.key].private = { status: 'delivered' };
      fs.writeFileSync(file, JSON.stringify(outbox), { mode: 0o600 });
    }
  }
  api.resetCalls();
  return { api, options, clock, dataDir, close: patch => feedback.closeInactiveRepliedIssues({ ...options, ...patch }) };
}

test('实际后台采集循环在完整采集后自动执行七天关闭，随后继续原轮询', async (t) => {
  const f = await fixture(t);
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    timers.push({ callback, delay });
    return { unref() {} };
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  t.after(() => feedback.stopGithubFeedbackCollector());
  assert.equal(feedback.startGithubFeedbackCollector(f.options).started, true);
  assert.equal(timers[0].delay, 0);
  await timers[0].callback();
  assert.equal(f.api.patches().length, 1);
  assert.equal(timers.at(-1).delay, 25 * 60 * 1000);
  feedback.stopGithubFeedbackCollector();
});

test('实际后台循环本轮采集失败时，不用旧完整快照自动关闭', async (t) => {
  const f = await fixture(t);
  f.api.listError = { statusCode: 503, body: null };
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', (callback) => {
    timers.push(callback);
    return { unref() {} };
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  t.after(() => feedback.stopGithubFeedbackCollector());
  feedback.startGithubFeedbackCollector(f.options);
  await timers[0]();
  assert.equal(f.api.patches().length, 0);
  feedback.stopGithubFeedbackCollector();
});

test('默认关闭：未显式启用 autoCloseAfterReply 时不访问网络也不关闭', async (t) => {
  const f = await fixture(t);
  for (const autoCloseAfterReply of [undefined, false, 'true']) {
    f.api.resetCalls();
    await f.close({ config: makeConfig({ autoCloseAfterReply }) });
    assert.equal(f.api.calls.length, 0);
  }
});

test('经主审确认发布的修复回复后一周前最后 1ms 不关闭', async (t) => {
  const f = await fixture(t, { now: REPLIED_AT + WEEK - 1 });
  assert.deepEqual((await f.close()).closed, []);
  assert.equal(f.api.patches().length, 0);
});

test('经主审确认发布的修复回复恰好满七天即关闭，重复运行不重复 PATCH', async (t) => {
  const f = await fixture(t);
  const result = await f.close();
  assert.equal(result.ok, true);
  assert.deepEqual(result.closed, [ISSUE]);
  assert.equal(f.api.patches().length, 1);
  assert.equal(f.api.patches()[0].apiPath, issuePath(ISSUE));
  await f.close();
  assert.equal(f.api.patches().length, 1, '关闭回执或最新远端状态必须阻止重复关闭');
});

test('带自有送达标记的自动回复同样按真实评论时间计时', async (t) => {
  const body = `这个问题已修复，感谢反馈。\n<!-- farm-bot-feedback ${ISSUE} ${'c'.repeat(12)} -->`;
  const f = await fixture(t, { specs: [repliedIssue({ comments: [comment(101, 'owner', REPLIED_AT, body)] })] });
  assert.deepEqual((await f.close()).closed, [ISSUE]);
  assert.equal(f.api.patches().length, 1);
});

test('从未回复的 issue 即使很久没有活动也不关闭', async (t) => {
  const f = await fixture(t, { specs: [repliedIssue({ comments: [] })], now: REPLIED_AT + 30 * DAY });
  assert.deepEqual((await f.close()).closed, []);
  assert.equal(f.api.patches().length, 0);
});

test('外部用户伪造自有送达标记不能启动一周关闭计时', async (t) => {
  const body = `已修复\n<!-- farm-bot-feedback ${ISSUE} ${'c'.repeat(12)} -->`;
  const f = await fixture(t, { specs: [repliedIssue({ comments: [comment(102, 'imposter', REPLIED_AT, body)] })] });
  assert.deepEqual((await f.close()).closed, []);
  assert.equal(f.api.patches().length, 0);
});

test('回复后用户追加问题：即使追加留言本身已超过一周也不能关闭', async (t) => {
  const followupAt = REPLIED_AT + DAY;
  const f = await fixture(t, { specs: [repliedIssue({
    comments: [comment(100, 'owner', REPLIED_AT), comment(103, 'reporter', followupAt, '更新后仍然失败')],
    updated_at: iso(followupAt),
  })], now: REPLIED_AT + 30 * DAY });
  assert.deepEqual((await f.close()).closed, []);
  assert.equal(f.api.patches().length, 0);
});

test('回复后第三方用户追加留言也保持待跟进', async (t) => {
  const followupAt = REPLIED_AT + DAY;
  const f = await fixture(t, { specs: [repliedIssue({
    comments: [comment(100, 'owner', REPLIED_AT), comment(103, 'another-user', followupAt)],
    updated_at: iso(followupAt),
  })] });
  assert.deepEqual((await f.close()).closed, []);
  assert.equal(f.api.patches().length, 0);
});

test('回复后编辑更早的用户评论同样视为新跟进', async (t) => {
  const editedAt = REPLIED_AT + DAY;
  const f = await fixture(t, { specs: [repliedIssue({
    comments: [comment(99, 'reporter', REPLIED_AT - DAY, '补充新的失败信息', editedAt), comment(100, 'owner', REPLIED_AT)],
    updated_at: iso(editedAt),
  })] });
  assert.deepEqual((await f.close()).closed, []);
  assert.equal(f.api.patches().length, 0);
});

test('issue 更新晚于全部已知评论时不自动关闭', async (t) => {
  const f = await fixture(t, { specs: [repliedIssue({ body: '报告者新增的失败说明', updated_at: iso(REPLIED_AT + DAY) })] });
  assert.deepEqual((await f.close()).closed, []);
  assert.equal(f.api.patches().length, 0);
});

test('维护者再次回复后从新回复重新计满七天', async (t) => {
  const secondReplyAt = REPLIED_AT + 6 * DAY;
  const f = await fixture(t, { specs: [repliedIssue({
    comments: [comment(100, 'owner', REPLIED_AT), comment(103, 'reporter', REPLIED_AT + DAY), comment(104, 'owner', secondReplyAt)],
    updated_at: iso(secondReplyAt),
  })] });
  assert.deepEqual((await f.close()).closed, []);
  assert.equal(f.api.patches().length, 0);
  f.clock.now = secondReplyAt + WEEK;
  assert.deepEqual((await f.close()).closed, [ISSUE]);
  assert.equal(f.api.patches().length, 1);
});

test('维护者编辑回复后从编辑时间重新计满七天', async (t) => {
  const editedAt = REPLIED_AT + 6 * DAY;
  const f = await fixture(t, { specs: [repliedIssue({
    comments: [comment(100, 'owner', REPLIED_AT, '更新后的回复', editedAt)], updated_at: iso(editedAt),
  })] });
  assert.deepEqual((await f.close()).closed, []);
  assert.equal(f.api.patches().length, 0);
  f.clock.now = editedAt + WEEK;
  assert.deepEqual((await f.close()).closed, [ISSUE]);
});

test('最新远端已关闭、已锁定或实际为 PR 时均不 PATCH', async (t) => {
  for (const patch of [{ state: 'closed' }, { locked: true }, { pull_request: {} }]) {
    const f = await fixture(t);
    Object.assign(f.api.issues.get(ISSUE), patch);
    assert.deepEqual((await f.close()).closed, []);
    assert.equal(f.api.patches().length, 0);
  }
});

test('采集失败覆盖旧 complete 状态后拒绝关闭，保留旧反馈', async (t) => {
  const f = await fixture(t);
  f.api.listError = { statusCode: 503, body: null };
  assert.equal((await feedback.collectGithubFeedback(f.options)).ok, false);
  f.api.resetCalls();
  const result = await f.close();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'collection_incomplete');
  assert.equal(f.api.patches().length, 0);
});

test('历史评论超出保留上限使采集 partial 时拒绝关闭', async (t) => {
  const comments = Array.from({ length: 25 }, (_, index) => comment(index + 1, 'reporter', REPLIED_AT - DAY + index));
  comments.push(comment(100, 'owner', REPLIED_AT));
  const f = await fixture(t, { specs: [repliedIssue({ comments })] });
  const result = await f.close();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'collection_incomplete');
  assert.equal(f.api.patches().length, 0);
});

test('完整缓存之后远端评论变成截断历史时也不能关闭', async (t) => {
  const f = await fixture(t);
  const issue = f.api.issues.get(ISSUE);
  issue.comments = Array.from({ length: 25 }, (_, index) => comment(index + 1, 'reporter', REPLIED_AT - DAY + index));
  issue.comments.push(comment(100, 'owner', REPLIED_AT));
  assert.deepEqual((await f.close()).closed, []);
  assert.equal(f.api.patches().length, 0);
});

test('关闭前详情或评论请求失败时不执行写请求', async (t) => {
  const f = await fixture(t);
  f.api.onDetail = () => ({ statusCode: 500, body: null });
  assert.deepEqual((await f.close()).closed, []);
  assert.equal(f.api.patches().length, 0);
  f.api.onDetail = null;
  f.api.commentsError = { statusCode: 403, body: null };
  assert.deepEqual((await f.close()).closed, []);
  assert.equal(f.api.patches().length, 0);
});

test('PATCH 前第二次详情读取发现活动水位变化则停止关闭', async (t) => {
  const f = await fixture(t);
  let detailReads = 0;
  f.api.onDetail = (raw, count) => {
    detailReads += 1;
    if (count >= 2) return { statusCode: 200, body: { ...raw, comments: raw.comments + 1, updated_at: iso(f.clock.now) } };
    return { statusCode: 200, body: raw };
  };
  assert.deepEqual((await f.close()).closed, []);
  assert.ok(detailReads >= 2, '候选关闭前必须二次核对远端详情');
  assert.equal(f.api.patches().length, 0);
});

test('二次详情读取即使水位不变，正文、标题或锁状态变化也阻止关闭', async (t) => {
  for (const patch of [{ body: '并发更新后的正文' }, { title: '并发更新后的标题' }, { locked: true }]) {
    const f = await fixture(t);
    f.api.onDetail = (raw, count) => ({ statusCode: 200, body: count >= 2 ? { ...raw, ...patch } : raw });
    assert.deepEqual((await f.close()).closed, []);
    assert.equal(f.api.patches().length, 0);
  }
});

test('PATCH 必须收到 issue 编号匹配且 state=closed 的有效回执才算关闭成功', async (t) => {
  for (const body of [{}, { number: ISSUE, state: 'open' }, { number: ISSUE + 1, state: 'closed' }]) {
    const f = await fixture(t);
    f.api.onPatch = () => ({ statusCode: 200, body });
    assert.deepEqual((await f.close()).closed, []);
    assert.equal(f.api.patches().length, 1);
  }
});

test('PATCH 超时但远端实际已关闭时，下轮读取 closed 状态后不重复关闭', async (t) => {
  const f = await fixture(t);
  f.api.onPatch = issue => {
    issue.state = 'closed';
    throw new Error('timeout');
  };
  assert.deepEqual((await f.close()).closed, [], '未知回执不能宣称成功');
  assert.equal(f.api.patches().length, 1);
  await f.close();
  assert.equal(f.api.patches().length, 1);
});

test('任意维护者回复即使超过七天也不能代替已验证修复', async (t) => {
  const f = await fixture(t, { verified: false, now: REPLIED_AT + 30 * DAY });
  assert.deepEqual((await f.close()).closed, []);
  assert.equal(f.api.patches().length, 0);
});

test('已验证修复也必须等待完整七天，两个自动关闭开关都不能缩短等待', async (t) => {
  for (const autoCloseAfterReply of [true, false]) {
    const f = await fixture(t, { now: REPLIED_AT + 1, config: makeConfig({ autoCloseFixed: true, autoCloseAfterReply }) });
    assert.deepEqual((await f.close()).closed, []);
    assert.equal(f.api.patches().length, 0);
    f.clock.now = REPLIED_AT + WEEK - 1;
    assert.deepEqual((await f.close()).closed, []);
    assert.equal(f.api.patches().length, 0);
    f.clock.now = REPLIED_AT + WEEK;
    assert.deepEqual((await f.close()).closed, [ISSUE]);
    const patchIndex = f.api.calls.findIndex(call => call.method === 'PATCH');
    assert.ok(f.api.calls.slice(patchIndex + 1).some(call => call.method === 'GET' && call.apiPath === issuePath(ISSUE)));
  }
});

test('旧投递回执对应的远端评论已删除时不关闭', async (t) => {
  const f = await fixture(t);
  f.api.issues.get(ISSUE).comments[0].body = '仍需补充信息';
  assert.deepEqual((await f.close()).closed, []);
  assert.equal(f.api.patches().length, 0);
});

test('坏回执 commentId=0 不能与未找到远端标记的零值匹配', async (t) => {
  const f = await fixture(t);
  const file = inside(f.dataDir, 'evolution-github-outbox.json');
  const outbox = JSON.parse(fs.readFileSync(file, 'utf8'));
  outbox.entries[`${ISSUE}:${REVISION}`].public.commentId = 0;
  // An unrelated maintainer reply remains, but there is no actual delivery marker.
  f.api.issues.get(ISSUE).comments[0].body = '请提供更多信息';
  const storeFile = inside(f.dataDir, 'evolution-github-feedback.json');
  await feedback.collectGithubFeedback(f.options);
  outbox.entries[`${ISSUE}:${REVISION}`].issueFingerprint = JSON.parse(fs.readFileSync(storeFile, 'utf8')).issues[0].fingerprint;
  fs.writeFileSync(file, JSON.stringify(outbox), { mode: 0o600 });
  assert.deepEqual((await f.close()).closed, []);
  assert.equal(f.api.patches().length, 0);
});

test('未发布或修复被撤回时不关闭，缺失读回不宣称关闭成功', async (t) => {
  const f = await fixture(t);
  for (const result of [false, { ok: false, hold: 'owner_reverting' }]) {
    assert.deepEqual((await f.close({ publishedCheck: async () => result })).closed, []);
  }
  assert.equal(f.api.patches().length, 0);
  f.api.resetCalls();
  f.api.onDetail = (raw, count) => count >= 3 ? { statusCode: 503, body: null } : { statusCode: 200, body: raw };
  assert.deepEqual((await f.close()).closed, []);
  assert.equal(f.api.patches().length, 1);
});
