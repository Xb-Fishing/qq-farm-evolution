const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { auditGitRange, scanTextForPrivacy } = require('../src/services/privacy-guard');
const { collectLocalPrivacyTerms } = require('../src/services/local-privacy-terms');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  const commit = (message = 'fixture change') => {
    git(['add', '-A']);
    git(['commit', '-qm', message]);
    return git(['rev-parse', 'HEAD']);
  };
  git(['init', '-q']);
  git(['config', 'user.name', 'Privacy Fixture']);
  git(['config', 'user.email', ['privacy-test', 'users.noreply.github.com'].join('@')]);
  write('sample.js', 'module.exports = 1;\n');
  const base = commit('initial');
  const audit = head => auditGitRange(root, base, head, { runtimeTerms: new Set() });
  return { root, git, write, commit, base, audit };
}

test('中间提交出现密钥后删除，净 diff 干净仍禁止上传', (t) => {
  const f = fixture(t);
  const secret = ['sk', 'a'.repeat(32)].join('-');
  f.write('sample.js', `module.exports = '${secret}';\n`);
  const leaked = f.commit();
  f.write('sample.js', 'module.exports = 1;\n');
  const head = f.commit();
  assert.equal(f.git(['diff', f.base, head]), '');
  const result = f.audit(head);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(item => item.commit === leaked && item.rule === 'provider-token'));
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('审计前面的提交说明与作者邮箱，不只检查最后一笔', (t) => {
  const f = fixture(t);
  const email = ['private-person', 'example.invalid'].join('@');
  f.write('sample.js', 'module.exports = 2;\n');
  f.git(['add', '.']);
  f.git(['-c', `user.email=${email}`, 'commit', '-qm', `temporary note ${email}`]);
  const leaked = f.git(['rev-parse', 'HEAD']);
  f.write('sample.js', 'module.exports = 3;\n');
  const result = f.audit(f.commit());
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(item => item.commit === leaked && item.file === '(commit-message)' && item.rule === 'personal-email'));
  assert.ok(!JSON.stringify(result).includes(email));
});

test('被强制跟踪的私有文件即使没有秘密值、随后又删除，也阻止上传', (t) => {
  const f = fixture(t);
  f.write('.gitignore', 'core/data/\n.codex/\n');
  f.commit();
  for (const file of ['core/data/example.json', '.codex/auth.json']) {
    f.write(file, '{}\n');
    f.git(['add', '-f', '--', file]);
  }
  f.git(['commit', '-qm', 'force added private files']);
  f.git(['rm', 'core/data/example.json', '.codex/auth.json']);
  const result = f.audit(f.commit());
  assert.ok(result.findings.some(item => item.rule === 'private-file-tracked' && item.file === 'core/data/example.json'));
  assert.ok(result.findings.some(item => item.rule === 'private-file-tracked' && item.file === '.codex/auth.json'));
});

test('合并分支中已删除的泄露仍在待上传历史内', (t) => {
  const f = fixture(t);
  const mainBranch = f.git(['branch', '--show-current']);
  f.git(['checkout', '-qb', 'feature']);
  const secret = ['sk', 'b'.repeat(32)].join('-');
  f.write('sample.js', `module.exports = '${secret}';\n`);
  const leaked = f.commit();
  f.write('sample.js', 'module.exports = 1;\n');
  f.commit();
  f.git(['checkout', mainBranch]);
  f.git(['merge', '--no-ff', 'feature', '-m', 'merge reviewed feature']);
  const result = f.audit(f.git(['rev-parse', 'HEAD']));
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(item => item.commit === leaked));
});

test('本机前缀未知的模型密钥和网关地址按实际值比对，支持配置目录覆盖', (t) => {
  const f = fixture(t);
  const gatewayKey = ['gateway', 'opaque', 'credential', 'fixture'].join('-');
  const claudeKey = ['claude', 'opaque', 'credential', 'fixture'].join('-');
  const address = ['https:/', '/gateway.example.invalid/v1'].join('');
  f.write('agent-home/auth.json', JSON.stringify({ OPENAI_API_KEY: gatewayKey }));
  f.write('agent-home/config.toml', `base_url = '${address}'\n`);
  f.write('claude-home/settings.json', JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: claudeKey } }));
  const terms = collectLocalPrivacyTerms({
    homeDir: path.join(f.root, 'empty-home'),
    env: { CODEX_HOME: path.join(f.root, 'agent-home'), CLAUDE_CONFIG_DIR: path.join(f.root, 'claude-home') },
  });
  assert.ok(terms.has(gatewayKey));
  assert.ok(terms.has(claudeKey));
  assert.ok(terms.has(address));
  assert.ok(scanTextForPrivacy(`const arbitrary = '${gatewayKey}'`, { runtimeTerms: terms }).some(item => item.rule === 'runtime-personal-data'));
  f.write('agent-home/auth.json', '{invalid');
  assert.throws(() => collectLocalPrivacyTerms({ homeDir: f.root, env: { CODEX_HOME: path.join(f.root, 'agent-home') } }), /could not be inspected/);
});

test('模型环境密钥、JWT 和 Agent 会话导出会被识别，变量引用可以提交', () => {
  const secret = ['opaque', 'a'.repeat(24)].join('-');
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
    assert.ok(scanTextForPrivacy(`${key}=${secret}`).some(item => item.rule === 'provider-config-secret'));
    assert.deepEqual(scanTextForPrivacy(`const key = process.env.${key};`), []);
  }
  const jwt = [`eyJ${  'a'.repeat(24)}`, 'b'.repeat(24), 'c'.repeat(24)].join('.');
  assert.ok(scanTextForPrivacy(jwt).some(item => item.rule === 'jwt-token'));
  const sessionPath = ['~', '.codex', 'sessions', 'local-export.jsonl'].join('/');
  assert.ok(scanTextForPrivacy(sessionPath).some(item => item.rule === 'agent-session-data'));
  const staffEmail = ['person', 'anthropic.com'].join('@');
  assert.ok(scanTextForPrivacy(staffEmail).some(item => item.rule === 'personal-email'));
});

test('包含秘密值的文件名只返回脱敏位置', (t) => {
  const f = fixture(t);
  const secret = ['opaque', 'filename', 'credential'].join('-');
  f.write(`${secret}.txt`, 'normal content');
  const head = f.commit();
  const result = auditGitRange(f.root, f.base, head, { runtimeTerms: new Set([secret]) });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(item => item.file === '(sensitive-file)'));
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('公共管理接口名称不会被当成机器目录，真实用户目录仍拦截', () => {
  assert.deepEqual(scanTextForPrivacy("app.get('/api/admin/users/example', handler);"), []);
  for (const parts of [['', 'Users', 'sample-person', 'project'], ['', 'home', 'sample-person', 'project']]) {
    assert.ok(scanTextForPrivacy(parts.join('/')).some(item => item.rule === 'machine-user-path'));
  }
});
