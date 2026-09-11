const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseResourcePath,
  decodeUuid,
  findPathIndex,
  parseSpriteFrame,
  outputFileName,
  buildBundleIndexes,
  collectWantedFromReport,
} = require('../scripts/fetch-official-icons');

test('parseResourcePath extracts the logical path from extra.res', () => {
  assert.equal(
    parseResourcePath('{"res":"gui/texture/activity/yuanqigao/img_exchange_item1/spriteFrame"}'),
    'gui/texture/activity/yuanqigao/img_exchange_item1',
  );
  assert.equal(parseResourcePath('{"res":""}'), '');
  assert.equal(parseResourcePath('not json'), '');
  // 含查询参数或非法字符的不接受
  assert.equal(parseResourcePath('{"res":"a b c"}'), '');
});

test('decodeUuid restores the standard uuid from compact form', () => {
  // 已知样例：plant config 里的 22 字符压缩 uuid 解码后是 36 位标准形式
  const decoded = decodeUuid('2f5b1d69-1d61-4a63-8fbd-a37fb3a1a2f3');
  assert.equal(decoded, '2f5b1d69-1d61-4a63-8fbd-a37fb3a1a2f3');
  // 22 位压缩形式（前 2 位直保留 + 10 对 base64 → 30 位 hex = 32 位 hex）
  const compact = decodeUuid('abcdefcdefabcdefcdefab');
  assert.match(compact, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(compact.startsWith('ab'), true);
});

test('findPathIndex resolves a logical path to its uuid index in the bundle config', () => {
  const config = {
    paths: {
      10: ['gui/texture/activity/yuanqigao/img_exchange_item1', 0],
      11: ['gui/texture/activity/yuanqigao/img_exchange_item2', 0],
    },
    uuids: ['aaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbb'],
  };
  assert.equal(findPathIndex(config, 'gui/texture/activity/yuanqigao/img_exchange_item2'), 11);
  assert.equal(findPathIndex(config, 'gui/texture/unknown'), -1);
});

test('parseSpriteFrame extracts texture ref and rect from cocos import json', () => {
  const frame = parseSpriteFrame([null, null, {
    name: 'img_exchange_item1',
    texture: 'e69d4OKpRJYPDG1aGuO+zBVi',
    rect: { x: 0, y: 0, width: 64, height: 64 },
    offset: { x: 0, y: 0 },
    originalSize: { width: 64, height: 64 },
  }]);
  assert.equal(frame.textureRef, 'e69d4OKpRJYPDG1aGuO+zBVi');
  assert.deepEqual(frame.rect, { x: 0, y: 0, width: 64, height: 64 });

  assert.equal(parseSpriteFrame([1, 2, 3]), null);
});

test('outputFileName follows the itemId_name convention', () => {
  assert.equal(outputFileName(201010, '比熊乐园小屋'), '201010_比熊乐园小屋.png');
  assert.equal(outputFileName(2161, 'a/b:c?d'), '2161_abcd.png');
  assert.equal(outputFileName(0, ''), '0_item.png');
});

test('buildBundleIndexes groups config urls by bundle base', () => {
  const bundles = buildBundleIndexes(new Set([
    'https://cdn.example.qq.com/abc/plant/config.123.json',
    'https://cdn.example.qq.com/abc/plant/native/aa/uuid.hash.astc',
    'https://other.example.qq.com/xyz/mainscene/config.456.json',
    'https://cdn.example.qq.com/no-config/file.png',
  ]));
  assert.equal(bundles.size, 2);
  assert.ok(bundles.has('https://cdn.example.qq.com/abc/plant'));
  assert.ok(bundles.has('https://other.example.qq.com/xyz/mainscene'));
});

test('collectWantedFromReport gathers items that carry extra.res evidence', () => {
  const report = {
    online: {
      activities: [
        {
          id: 2026090103,
          details: {
            exchangeShop: {
              items: [
                { itemId: 201010, name: '比熊乐园小屋', extra: '{"res":"gui/texture/activity/yuanqigao/img_exchange_item1/spriteFrame"}' },
                { itemId: 2161, name: '比熊乐园头像框', extra: '' },
                { itemId: 20522, name: '金币果种子' },
              ],
            },
          },
        },
        { id: 2026090102, details: {} },
      ],
    },
  };
  const wanted = collectWantedFromReport(report);
  assert.equal(wanted.length, 1);
  assert.deepEqual(wanted[0], {
    itemId: 201010,
    name: '比熊乐园小屋',
    resourcePath: 'gui/texture/activity/yuanqigao/img_exchange_item1',
  });
});

test('collectWantedFromReport tolerates missing report', () => {
  assert.deepEqual(collectWantedFromReport(null), []);
  assert.deepEqual(collectWantedFromReport({ online: { activities: [] } }), []);
});

test('cli reports missing url evidence and exits cleanly when no capture data exists', () => {
  const { spawnSync } = require('node:child_process');
  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-icons-cli.'));
  // 活动：真报告里有 1 个带 extra.res 的道具，但没有抓包 URL 证据
  fs.writeFileSync(path.join(tmpDataDir, 'activity-update-report.json'), JSON.stringify({
    online: {
      activities: [{
        id: 2026090103,
        details: {
          exchangeShop: {
            items: [
              { itemId: 201010, name: '比熊乐园小屋', extra: '{"res":"gui/texture/activity/yuanqigao/img_exchange_item1/spriteFrame"}' },
            ],
          },
        },
      }],
    },
  }));
  const coreRoot = path.resolve(__dirname, '..');
  const script = path.join(coreRoot, 'scripts', 'fetch-official-icons.js');
  const result = spawnSync(process.execPath, [script, '--report', path.join(tmpDataDir, 'activity-update-report.json')], {
    encoding: 'utf8',
    // 在干净 HOME 下运行，避免读到本机真实 gamecaches/private-config
    env: {
      ...process.env,
      HOME: tmpDataDir,
      FARM_RESOURCE_CDN_BASE: '',
      ASTCENC_BIN: '',
    },
    // 脚本 URL 池读取 core/data/（真实路径）：需要允许它读，但真实抓包文件不存在，
    // 真实 gamecaches 在 Linux 上也不存在 —— 输出应为"缺证据"且退出码 0。
  });
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout + result.stderr, /缺少官方资源 URL 证据/);
  assert.match(result.stdout + result.stderr, /201010/);
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});
