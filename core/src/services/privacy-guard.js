const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getDataDir } = require('../config/runtime-paths');
const { readPrivateConfig } = require('./private-config');
const { collectLocalPrivacyTerms } = require('./local-privacy-terms');

/* Security signatures intentionally spell out alphabets and network ranges. */
/* eslint-disable regexp/prefer-w, regexp/no-dupe-characters-character-class, regexp/no-useless-assertions, regexp/no-useless-non-capturing-group */

const URL_RE = /https?:\/\/[^\s'"`<>]+/gi;
const SAFE_PLACEHOLDER_RE = /^(?:\[?(?:redacted|masked|example|placeholder|hidden|private)[^\]]*\]?|change[-_]?me)$/i;
const COMMON_RUNTIME_TERMS = new Set([
  'admin', 'user', 'default', 'unknown', 'online', 'qq', 'wx', 'wechat', 'farm', 'bot',
  'abc', 'test', 'example',
]);

const PRIVACY_RULES = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
  ['provider-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/i],
  ['webhook-secret', /https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]{12,}/i],
  ['authorization-secret', /\bBearer\s+[A-Za-z0-9._~-]{12,}/i],
  ['provider-config-secret', /\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|GITHUB_TOKEN|FEISHU_WEBHOOK)["']?\s*[:=]\s*["']?[A-Za-z0-9_.:-]{16,}/i],
  ['jwt-token', /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{10,}\b/],
  ['agent-session-data', /(?:rollout-\d{4}-\d{2}-\d{2}|[~\\/]\.(?:codex|claude)[\\/](?:sessions|projects)[\\/][^\s`"']+|[~\\/]\.codex[\\/]history\.jsonl)/i],
  ['url-credentials', /https?:\/\/[^\s/@:]+:[^\s/@]+@/i],
  ['url-secret-query', /[?&](?:api[_-]?key|access[_-]?token|auth|code|credential|password|secret|ticket|token)=[^&\s'"<>]+/i],
  ['hardcoded-secret', /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|credential|license[_-]?secret|password|passwd|private[_-]?key|secret|token|webhook)\b\s*[:=]\s*['"][^'"]{6,}['"]/i],
  ['machine-user-path', /(?:\/data\/[^\s'"]*\/users\/[^/\s'"]+|\/home\/[^/\s'"]+|\/Users\/[^/\s'"]+|\/root\/\.nvm\/versions\/node\/[^/\s'"]+)/],
  ['private-network', /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.(?:\d{1,3}\.)\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3})\b/],
  // 只放行 GitHub 匿名邮箱和 Claude 的固定机器尾注，不放行整家公司的个人邮箱。
  ['personal-email', /\b(?!noreply@anthropic\.com\b)[A-Z0-9._%+-]+@(?!users\.noreply\.github\.com\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
];

function redactSensitiveText(raw, options = {}) {
  let result = String(raw || '');
  result = result
    .replace(/(https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/)[A-Za-z0-9_-]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|auth|code|credential|password|secret|ticket|token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, '[REDACTED]')
    .replace(/(\/data\/[^\s'"]*\/users\/)[^/\s'"]+/g, '$1[USER]')
    .replace(/(\/home\/)[^/\s'"]+/g, '$1[USER]')
    .replace(/(\/Users\/)[^/\s'"]+/g, '$1[USER]')
    .replace(/(\/root\/\.nvm\/versions\/node\/)[^/\s'"]+/g, '$1[VERSION]');
  if (options.redactUrls) result = result.replace(URL_RE, '[URL_REDACTED]');
  return result;
}

function redactExternalText(raw) {
  return redactSensitiveText(raw, { redactUrls: true })
    .replace(/\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.(?:\d{1,3}\.)\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3})\b/g, '[PRIVATE-IP]');
}

function normalizePrivacyTerm(value) {
  const term = String(value || '').trim();
  if (!term || SAFE_PLACEHOLDER_RE.test(term) || COMMON_RUNTIME_TERMS.has(term.toLowerCase())) return '';
  if (/^\d+$/.test(term)) return term.length >= 8 ? term : '';
  return term.length >= 3 ? term : '';
}

function addPrivacyTerm(terms, value) {
  const normalized = normalizePrivacyTerm(value);
  if (normalized) terms.add(normalized);
}

function collectObjectTerms(value, terms, depth = 0) {
  if (!value || depth > 5) return;
  if (Array.isArray(value)) {
    for (const item of value) collectObjectTerms(item, terms, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:accountName|displayName|friendName|gid|name|nick|openId|qq|uin|username|wxid)$/i.test(key)) {
      addPrivacyTerm(terms, item);
    } else if (typeof item === 'object') {
      collectObjectTerms(item, terms, depth + 1);
    }
  }
}

function collectScalarTerms(value, terms, depth = 0) {
  if (value === null || value === undefined || depth > 5) return;
  if (Array.isArray(value)) {
    for (const item of value) collectScalarTerms(item, terms, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectScalarTerms(item, terms, depth + 1);
    return;
  }
  addPrivacyTerm(terms, value);
}

function collectRuntimePrivacyTerms(options = {}) {
  const dataDir = options.dataDir || getDataDir();
  const terms = new Set();
  const jsonFiles = [
    path.join(dataDir, 'accounts.json'),
    path.join(dataDir, 'users.json'),
  ];
  const knownFriendFiles = [];
  const knownFriendDir = path.join(dataDir, 'known_friend_gids');
  try {
    for (const entry of fs.readdirSync(knownFriendDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json')) knownFriendFiles.push(path.join(knownFriendDir, entry.name));
    }
  } catch {}
  for (const file of jsonFiles) {
    try {
      collectObjectTerms(JSON.parse(fs.readFileSync(file, 'utf8')), terms);
    } catch {}
  }
  for (const file of knownFriendFiles) {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      collectObjectTerms(value, terms);
      collectScalarTerms(value, terms);
    } catch {}
  }
  const privateConfig = options.privateConfig || readPrivateConfig();
  for (const item of Array.isArray(privateConfig.privacyDenylist) ? privateConfig.privacyDenylist : []) {
    addPrivacyTerm(terms, item);
  }
  for (const term of collectLocalPrivacyTerms({ ...options, dataDir, privateConfig })) terms.add(term);
  return terms;
}

function scanTextForPrivacy(text, options = {}) {
  const findings = [];
  const lines = String(text || '').split(/\r?\n/);
  const runtimeTerms = options.runtimeTerms || new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (options.blockUrls && URL_RE.test(line)) findings.push({ rule: 'new-url', line: index + 1 });
    URL_RE.lastIndex = 0;
    for (const [rule, pattern] of PRIVACY_RULES) {
      if (pattern.test(line) && !SAFE_PLACEHOLDER_RE.test(line.trim())) {
        findings.push({ rule, line: index + 1 });
      }
    }
    for (const term of runtimeTerms) {
      if (line.includes(term)) {
        findings.push({ rule: 'runtime-personal-data', line: index + 1 });
        break;
      }
    }
  }
  return findings;
}

function parseAddedDiff(diff) {
  const rows = [];
  let file = '';
  let line = 0;
  for (const raw of String(diff || '').split(/\r?\n/)) {
    if (raw.startsWith('+++ b/')) {
      file = raw.slice(6);
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      rows.push({ file, line, text: raw.slice(1) });
      line += 1;
    } else if (!raw.startsWith('-')) {
      line += 1;
    }
  }
  return rows;
}

function auditGitRange(repoRoot, base, head, options = {}) {
  // 仅父进程持有已完成双 Agent 验收凭据时传入；隐私文件不在这个例外集合中。
  const orchestrationFiles = new Set([
    'core/scripts/run-evolution-team.js', 'core/src/services/evolution-team.js',
  ]);
  const reviewedOrchestrationFiles = new Set((Array.isArray(options.reviewedOrchestrationFiles)
    ? options.reviewedOrchestrationFiles : []).filter(file => orchestrationFiles.has(file)));
  const protectedFiles = new Set([
    '.gitignore',
    'core/src/services/privacy-guard.js',
    'core/src/services/local-privacy-terms.js',
    'core/src/services/private-config.js',
    'core/src/services/feishu-notify.js',
    'core/src/services/activity-evolver.js',
    'core/src/services/evolution-validation.js', 'core/src/services/evolution-references.js',
    'core/src/services/daily-feedback.js', 'core/src/controllers/admin-feedback-routes.js',
    'web/src/utils/daily-feedback.ts',
    'core/src/services/evolution-team.js',
    'core/scripts/run-evolution-team.js',
    'scripts/evolution-hooks/pre-push',
  ]);
  const privatePath = /(?:^|\/)(?:core\/data|logs?|tmp|temp|\.tmp|\.codex|\.claude)(?:\/|$)|(?:^|\/)(?:\.env(?:\.|$)|\.claude\.json$|auth\.json$|\.?credentials\.json$|private-config\.json$)|\.(?:log|pem|key|p12|pfx)$/i;
  const git = args => execFileSync('git', args, {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    git(['merge-base', '--is-ancestor', base, head]);
    const commits = git(['rev-list', '--reverse', `${base}..${head}`]).trim().split('\n').filter(Boolean);
    const runtimeTerms = options.runtimeTerms || collectRuntimePrivacyTerms(options);
    const findings = [];
    const safeFile = file => scanTextForPrivacy(file, { blockUrls: true, runtimeTerms }).length ? '(sensitive-file)' : file;
    const add = (finding, commit) => findings.push({ ...finding, file: safeFile(finding.file), commit });
    const scan = (text, file, commit, line) => {
      for (const finding of scanTextForPrivacy(text, { blockUrls: true, runtimeTerms })) {
        add({ ...finding, file, ...(line !== undefined ? { line } : {}) }, commit);
      }
    };
    // 审完整新增历史：先写入秘密再删除、前一笔提交的作者/标题，均不能被净 diff 掩盖。
    for (const commit of commits) {
      const args = ['show', '--format=', '-m', '--root', '--no-renames'];
      const diff = git([...args, '--no-ext-diff', '--unified=0', '--no-color', commit]);
      for (const row of parseAddedDiff(diff)) scan(row.text, row.file, commit, row.line);
      const names = git([...args, '--name-only', '-z', commit]).split('\0').filter(Boolean);
      for (const file of names) {
        scan(file, file, commit, 0);
        if (protectedFiles.has(file) && !reviewedOrchestrationFiles.has(file)) add({ rule: 'privacy-control-changed', file, line: 0 }, commit);
      }
      const numstat = git([...args, '--numstat', commit]);
      for (const line of numstat.trim().split('\n').filter(Boolean)) {
        const [added, deleted, ...fileParts] = line.split('\t');
        if (added === '-' || deleted === '-') add({ rule: 'binary-change', file: fileParts.join('\t'), line: 0 }, commit);
      }
      for (const row of git(['ls-tree', '-r', '-z', commit]).split('\0').filter(Boolean)) {
        const tab = row.indexOf('\t');
        const file = row.slice(tab + 1);
        // 即使被强制 add，私有运行文件也不能进入任一待上传提交的树。
        if (privatePath.test(file)) add({ rule: 'private-file-tracked', file, line: 0 }, commit);
        if (row.startsWith('120000 ') && names.includes(file)) add({ rule: 'symlink-change', file, line: 0 }, commit);
      }
      scan(git(['show', '-s', '--format=%an%n%ae%n%cn%n%ce%n%s%n%b', commit]), '(commit-message)', commit);
    }
    const unique = [];
    const seen = new Set();
    for (const finding of findings) {
      const key = `${finding.commit}:${finding.rule}:${finding.file}:${finding.line}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(finding);
      }
    }
    return { ok: unique.length === 0, findings: unique };
  } catch {
    return { ok: false, findings: [{ rule: 'privacy-scan-failed', file: '(git)', line: 0 }] };
  }
}

function formatPrivacyFindings(findings, limit = 12) {
  return (findings || []).slice(0, limit).map(item => {
    const location = item.file ? `${item.file}${item.line ? `:${item.line}` : ''}` : '未知位置';
    return `${item.rule} @ ${location}${item.commit ? ` (commit ${item.commit.slice(0, 8)})` : ''}`;
  });
}

module.exports = {
  PRIVACY_RULES,
  redactSensitiveText,
  redactExternalText,
  collectRuntimePrivacyTerms,
  scanTextForPrivacy,
  parseAddedDiff,
  auditGitRange,
  formatPrivacyFindings,
};
