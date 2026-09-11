const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createResourceUrlRecorder,
  isResourcePath,
  normalizeResourceUrl,
} = require('../src/capture/resource-url-recorder');

test('isResourcePath recognizes official resource request shapes', () => {
  assert.equal(isResourcePath('/plant/config.abc123.json'), true);
  assert.equal(isResourcePath('/plant/import/aa/uuid.hash.json'), true);
  assert.equal(isResourcePath('/plant/native/aa/uuid.hash.astc'), true);
  assert.equal(isResourcePath('/texture/icon.png'), true);
  assert.equal(isResourcePath('/texture/icon.png?v=123'), true);
  assert.equal(isResourcePath('/api/gateway/ws'), false);
  assert.equal(isResourcePath(''), false);
});

test('normalizeResourceUrl strips query and forces https host form', () => {
  assert.equal(
    normalizeResourceUrl('cdn.example.qq.com', '/plant/native/aa/uuid.hash.astc?ts=1'),
    'https://cdn.example.qq.com/plant/native/aa/uuid.hash.astc',
  );
  assert.equal(normalizeResourceUrl('', '/a.png'), null);
  assert.equal(normalizeResourceUrl('host.com', 'not-a-path'), null);
  assert.equal(normalizeResourceUrl('host.com', 'http://insecure/a.png'), null);
});

test('recorder dedupes, persists with 0600, and reloads existing urls', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-recorder.'));
  const filePath = path.join(dir, 'resource-urls.json');
  const logs = [];
  const recorder = createResourceUrlRecorder({
    filePath,
    maxUrls: 3,
    flushDelayMs: 10,
    log: (level, message) => logs.push(message),
  });

  assert.equal(recorder.record('a.qq.com', '/plant/native/aa/1.hash.astc'), true);
  assert.equal(recorder.record('a.qq.com', '/plant/native/aa/1.hash.astc'), false); // 重复
  assert.equal(recorder.record('a.qq.com', '/api/not-resource'), false); // 非资源
  assert.equal(recorder.record('b.qq.com', '/x/config.1.json'), true);
  assert.equal(recorder.record('c.qq.com', '/y.png'), true);
  assert.equal(recorder.record('d.qq.com', '/z.png'), false); // 超上限

  recorder.stop(); // 同步 flush

  const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(saved.count, 3);
  assert.ok(saved.urls.includes('https://a.qq.com/plant/native/aa/1.hash.astc'));
  const stat = fs.statSync(filePath);
  assert.equal(stat.mode & 0o077, 0); // 0600

  // 重启后从文件恢复，去重继续
  const reopened = createResourceUrlRecorder({ filePath, flushDelayMs: 10 });
  assert.equal(reopened.size(), 3);
  assert.equal(reopened.record('a.qq.com', '/plant/native/aa/1.hash.astc'), false);
  reopened.stop();

  fs.rmSync(dir, { recursive: true, force: true });
});

test('recorder never throws on unwritable path', () => {
  // 写入目标本身是目录 → EISDIR，任何权限下都不可写
  const recorder = createResourceUrlRecorder({
    filePath: os.tmpdir(),
    flushDelayMs: 5,
    log: () => {},
  });
  assert.equal(recorder.record('a.qq.com', '/x.png'), true);
  recorder.stop(); // 落盘失败只 warn，不抛
});
