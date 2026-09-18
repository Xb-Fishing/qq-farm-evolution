const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 只用于本机精确比对；不返回配置原文，不写日志，不发送到 Agent 或外部服务。
function collectLocalPrivacyTerms(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const terms = new Set();
  const sensitiveKey = /api[_-]?key|private[_-]?key|token|secret|password|credential|webhook|cookie|authorization|base[_-]?url|endpoint|proxy|email|account[_-]?id|user[_-]?id/i;
  const add = (value) => {
    if (typeof value !== 'string') return;
    const text = value.trim();
    if (text.length < 8 || /^(?:\[(?:redacted|private)[^\]]*\]|change[-_]?me|example|placeholder)$/i.test(text)) return;
    // 代理软件的通用 loopback 地址不代表个人服务地址。
    if (/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/i.test(text)) return;
    terms.add(text);
  };
  const collect = (value, key = '', depth = 0) => {
    if (depth > 12 || value == null) return;
    if (typeof value === 'string') {
      if (sensitiveKey.test(key)) add(value);
    } else if (Array.isArray(value)) {
      for (const item of value) collect(item, key, depth + 1);
    } else if (typeof value === 'object') {
      for (const [name, item] of Object.entries(value)) collect(item, name, depth + 1);
    }
  };
  collect(env);
  collect(options.privateConfig);
  const codexDirs = new Set([path.join(homeDir, '.codex'), env.CODEX_HOME].filter(Boolean));
  const claudeDirs = new Set([path.join(homeDir, '.claude'), env.CLAUDE_CONFIG_DIR].filter(Boolean));
  const files = [path.join(homeDir, '.claude.json')];
  for (const dir of codexDirs) files.push(path.join(dir, 'auth.json'), path.join(dir, 'config.toml'));
  for (const dir of claudeDirs) files.push(path.join(dir, 'settings.json'), path.join(dir, 'settings.local.json'), path.join(dir, '.credentials.json'));
  if (options.dataDir) {
    for (const name of ['private-config.json', 'accounts.json', 'users.json', 'store.json', 'admin-sessions.json']) {
      files.push(path.join(options.dataDir, name));
    }
  }
  for (const file of new Set(files)) {
    try {
      if (fs.statSync(file).size > 8 * 1024 * 1024) throw new Error('Privacy configuration exceeds size limit');
      const text = fs.readFileSync(file, 'utf8');
      if (file.endsWith('.toml')) {
        // 只提取敏感键的字面量，不执行配置、命令或 apiKeyHelper。
        for (const match of text.matchAll(/^\s*([\w-]+)\s*=\s*["']([^"'\r\n]+)["']/gm)) collect(match[2], match[1]);
      } else collect(JSON.parse(text));
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        // 不可读配置不是“没有凭据”；调用方必须停止审计，而不是静默放行。
        throw new Error('Local privacy configuration could not be inspected');
      }
    }
  }
  return terms;
}

module.exports = { collectLocalPrivacyTerms };
