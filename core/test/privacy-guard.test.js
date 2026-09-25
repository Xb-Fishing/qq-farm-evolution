const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  redactSensitiveText,
  redactExternalText,
  scanTextForPrivacy,
  parseAddedDiff,
  auditGitRange,
} = require('../src/services/privacy-guard');
const { getPrivateValue } = require('../src/services/private-config');
const { sendFeishuText } = require('../src/services/feishu-notify');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function buildUrl(...parts) {
  return parts.join('');
}

test('外发文本删除完整 URL、Webhook、查询凭据和机器路径', () => {
  const publicUrl = buildUrl('https:/', '/example.invalid/path');
  const webhook = buildUrl('https:/', '/open.feishu.cn/open-apis/bot/v2/hook/', 'example-secret-value');
  const query = buildUrl('https:/', '/example.invalid/callback?api_key=', 'example-secret-value');
  const raw = `${publicUrl} ${webhook} ${query} /home/example-user/project`;
  const external = redactExternalText(raw);
  assert.doesNotMatch(external, /example\.invalid|example-secret-value|example-user/);
  assert.match(external, /URL_REDACTED/);

  const local = redactSensitiveText(webhook);
  assert.doesNotMatch(local, /example-secret-value/);
  assert.match(local, /REDACTED/);
});

test('隐私扫描只返回规则和位置，不返回命中的秘密值', () => {
  const url = buildUrl('https:/', '/private.invalid/api');
  const text = `safe\n${url}\npassword = '${'example-secret-value'}'`;
  const findings = scanTextForPrivacy(text, { blockUrls: true });
  assert.ok(findings.some(item => item.rule === 'new-url' && item.line === 2));
  assert.ok(findings.some(item => item.rule === 'hardcoded-secret' && item.line === 3));
  assert.doesNotMatch(JSON.stringify(findings), /example-secret-value|private\.invalid/);
});

test('新增行解析保留文件和新文件行号', () => {
  const rows = parseAddedDiff([
    'diff --git a/docs/example.md b/docs/example.md',
    '--- a/docs/example.md',
    '+++ b/docs/example.md',
    '@@ -1,0 +2,2 @@',
    '+first',
    '+second',
  ].join('\n'));
  assert.deepEqual(rows, [
    { file: 'docs/example.md', line: 2, text: 'first' },
    { file: 'docs/example.md', line: 3, text: 'second' },
  ]);
});

test('Git 范围隐私闸门允许普通代码并阻断新增 URL', () => {
  const repo = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'farm-privacy-git-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'privacy-test'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'privacy-test@users.noreply.github.com'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'example.js'), 'module.exports = 1;\n');
    execFileSync('git', ['add', 'example.js'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repo });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

    fs.writeFileSync(path.join(repo, 'example.js'), 'module.exports = 2;\n');
    execFileSync('git', ['commit', '-qam', 'safe change'], { cwd: repo });
    const safeHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(auditGitRange(repo, base, safeHead, { dataDir: path.join(repo, 'data') }).ok, true);

    const unsafeUrl = buildUrl('https:/', '/private.invalid/api');
    fs.writeFileSync(path.join(repo, 'example.js'), `module.exports = '${unsafeUrl}';\n`);
    execFileSync('git', ['commit', '-qam', 'unsafe change'], { cwd: repo });
    const unsafeHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const result = auditGitRange(repo, safeHead, unsafeHead, { dataDir: path.join(repo, 'data') });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some(item => item.rule === 'new-url'));
    assert.doesNotMatch(JSON.stringify(result.findings), /private\.invalid/);

    fs.writeFileSync(path.join(repo, 'asset.bin'), Buffer.from([0, 1, 2, 3]));
    execFileSync('git', ['add', 'asset.bin'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'binary change'], { cwd: repo });
    const binaryHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const binaryResult = auditGitRange(repo, unsafeHead, binaryHead, { dataDir: path.join(repo, 'data') });
    assert.equal(binaryResult.ok, false);
    assert.ok(binaryResult.findings.some(item => item.rule === 'binary-change'));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('本地私密配置优先使用显式环境且不需要源码默认值', () => {
  assert.equal(getPrivateValue('example', 'EXAMPLE_PRIVATE', {
    env: { EXAMPLE_PRIVATE: 'from-env' },
    config: { example: 'from-file' },
  }), 'from-env');
  assert.equal(getPrivateValue('example', 'EXAMPLE_PRIVATE', {
    env: {},
    config: { example: 'from-file' },
  }), 'from-file');
});

test('飞书发送使用私密地址但正文不会携带 URL', async () => {
  const originalFetch = globalThis.fetch;
  const webhook = buildUrl('https:/', '/open.feishu.cn/open-apis/bot/v2/hook/', 'example-secret-value');
  let request = null;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { json: async () => ({ code: 0 }) };
  };
  try {
    await sendFeishuText('privacy test', buildUrl('changed ', 'https:/', '/private.invalid/path'), webhook);
    assert.equal(request.url, webhook);
    assert.doesNotMatch(request.options.body, /private\.invalid|example-secret-value/);
    assert.match(request.options.body, /URL_REDACTED/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('受跟踪内容不含机器用户路径、真实 Webhook 或隐藏管理员凭据', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const violations = [];
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'); } catch { continue; }
    if (/\/data\/[^\s'"]*\/users\/[^/<\s'"]+/.test(text)) violations.push(`${file}:machine-user-path`);
    if (/https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[\w-]{12,}/.test(text)) violations.push(`${file}:webhook`);
    if (/const\s+SUPER_ADMIN_(?:USERNAME|PASSWORD_HASH)\b/.test(text)) violations.push(`${file}:static-super-admin`);
    if (/const\s+LICENSE_SECRET\s*=\s*['"][^'"]+['"]/.test(text)) violations.push(`${file}:license-secret`);
  }
  assert.deepEqual(violations, []);
});

test('机器尾注域不触发 personal-email,真实邮箱仍拦截', () => {
  const { scanTextForPrivacy } = require('../src/services/privacy-guard');

  // Claude Code Co-Authored-By 尾注与 GitHub 匿名邮箱是机器域,不是个人信息
  for (const text of [
    'Co-Authored-By: Claude <noreply@anthropic.com>',
    'Author: Xb-Fishing <Xb-Fishing@users.noreply.github.com>',
  ]) {
    const findings = scanTextForPrivacy(text, {});
    assert.equal(
      findings.some(f => f.rule === 'personal-email'),
      false,
      `机器尾注不应命中 personal-email: ${text}`,
    );
  }

  // 真实个人/公司邮箱必须继续拦截
  for (const text of [
    `联系人 ${['someone', 'qq.com'].join('@')}`,
    ['admin', 'example-corp.com.cn'].join('@'),
    ['privacy-fixture', 'example.invalid'].join('@'),
  ]) {
    const findings = scanTextForPrivacy(text, {});
    assert.equal(
      findings.some(f => f.rule === 'personal-email'),
      true,
      `真实邮箱应命中 personal-email: ${text}`,
    );
  }
});

test('privately configured and discovered reference identities cannot enter public changes; code locations remain usable', (t) => {
  const dataDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'reference-privacy-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'evolution-references.json'), JSON.stringify({
    candidates: [{ ownerRepo: 'sample-new/qq-farm' }, { ownerRepo: 'core/src' }],
  }));
  const { collectRuntimePrivacyTerms } = require('../src/services/privacy-guard');
  const runtimeTerms = collectRuntimePrivacyTerms({ dataDir, homeDir: dataDir, env: {},
    privateConfig: { evolutionReferenceRepositories: ['sample-fixed/qq-farm'], evolutionReferenceAliases: { old: 'sample-old/qq-farm' } } });
  for (const name of ['sample-fixed/qq-farm', 'sample-old/qq-farm', 'sample-new/qq-farm']) {
    assert.ok(scanTextForPrivacy(name, { runtimeTerms }).some(f => f.rule === 'runtime-personal-data'));
  }
  assert.ok(scanTextForPrivacy('source author sample-fixed', { runtimeTerms }).some(f => f.rule === 'runtime-personal-data'));
  assert.equal(scanTextForPrivacy('core/src/services/friend-orchestrator.js:100 @ abcdef1234', { runtimeTerms }).length, 0);
});
