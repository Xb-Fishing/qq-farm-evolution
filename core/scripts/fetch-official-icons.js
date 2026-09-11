#!/usr/bin/env node

/**
 * 官方活动图标抓取脚本
 *
 * 目标：为活动商城/奖励中带 `extra.res`（官方 Cocos 资源逻辑路径，如
 * `gui/texture/activity/yuanqigao/img_exchange_item1/spriteFrame`）的道具，
 * 从官方 CDN 下载真实专属图标，输出到
 * `core/src/gameConfig/seed_images_named/{itemId}_{name}.png`。
 *
 * URL 证据来源（按优先级）：
 *  1. `core/data/capture/resource-urls.json` —— 本机 MITM 抓包会话被动记录的
 *     官方资源 URL（开着游戏进活动页即可收集）；
 *  2. macOS `gamecaches/cacheList.json`（本机不存在则跳过）；
 *  3. `--cdn-base` / 环境变量 `FARM_RESOURCE_CDN_BASE` / ignored 的
 *     `core/data/private-config.json` 中 `resourceCdnBase` 人工提供的基址。
 *
 * 解析流程（与 extract-plant-phase-images.js 相同的官方模式）：
 *   bundle `config.*.json` → decodeUuid → `extra.res` 逻辑路径匹配
 *   config.paths → spriteFrame JSON（import/）拿 texture uuid + rect →
 *   texture（native/ 的 .astc/.png）→ astcenc 解码（如需）→ ffmpeg 按
 *   rect 裁剪 → 输出 PNG。
 *
 * 安全边界：
 *  - 只下载官方 URL 池中出现过的路径模式（import/native/config），
 *    不猜 CDN 地址、不探测未下发资源；
 *  - 输出的 PNG 是新增二进制：**禁止 git add**（自动进化的隐私扫描会对
 *    新增二进制硬阻断）。脚本只落盘到工作区，由人工审查提交；
 *  - 没有证据时打印缺口报告并以 0 退出（不视为错误）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const APP_ID = '1112386029';
const BASE64_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const HEX = '0123456789abcdef';
const coreRoot = path.resolve(__dirname, '..');
const defaultOutput = path.join(coreRoot, 'src', 'gameConfig', 'seed_images_named');
const dataDir = path.join(coreRoot, 'data');

/** 解析 extra.res 中的逻辑路径（支持 `{"res":"gui/..."}` 或纯字符串）。 */
function parseResourcePath(extra) {
  let value = '';
  try {
    const parsed = JSON.parse(String(extra || ''));
    value = String(parsed && parsed.res || '');
  } catch {
    value = String(extra || '');
  }
  value = value.trim();
  if (!value || !/^[\w./-]+$/.test(value)) return '';
  return value.replace(/\/spriteFrame$/, '');
}

/** 从 Cocos 压缩 UUID 还原标准 UUID。 */
function decodeUuid(value) {
  const compact = String(value || '').split('@')[0];
  if (compact.length !== 22) return compact;
  let result = compact.slice(0, 2);
  for (let index = 2; index < 22; index += 2) {
    const left = BASE64_KEYS.indexOf(compact[index]);
    const right = BASE64_KEYS.indexOf(compact[index + 1]);
    result += HEX[left >> 2];
    result += HEX[((left & 3) << 2) | (right >> 4)];
    result += HEX[right & 15];
  }
  return `${result.slice(0, 8)}-${result.slice(8, 12)}-${result.slice(12, 16)}-${result.slice(16, 20)}-${result.slice(20)}`;
}

function versionMap(config, kind) {
  const result = new Map();
  const versions = (config.versions && config.versions[kind]) || [];
  for (let index = 0; index < versions.length; index += 2) {
    result.set(Number(versions[index]), versions[index + 1]);
  }
  return result;
}

/** 在 bundle config.paths 中查找逻辑路径的 uuid 索引。 */
function findPathIndex(config, resourcePath) {
  for (const [indexText, pathInfo] of Object.entries(config.paths || {})) {
    if (pathInfo && pathInfo[0] === resourcePath) return Number(indexText);
  }
  return -1;
}

/** 从 spriteFrame import JSON 提取 texture uuid 和裁剪矩形。 */
function parseSpriteFrame(data) {
  // Cocos import JSON: [uuid-refs...]，spriteFrame 结构在 data[1][0] 附近，
  // 字段布局为 { name, texture: uuidRef, rect: { x, y, width, height } }。
  const stack = [data];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (typeof value.texture === 'string' && value.rect
      && Number.isFinite(Number(value.rect.width)) && Number(value.rect.width) > 0) {
      return { textureRef: value.texture, rect: value.rect };
    }
    stack.push(...Object.values(value));
  }
  return null;
}

function downloadFile(url, target) {
  const result = spawnSync('curl', ['-L', '--fail', '--silent', '--show-error', '--output', target, url], { encoding: 'utf8' });
  return result.status === 0 && fs.existsSync(target) && fs.statSync(target).size > 0;
}

function cropPng(texturePath, rect, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', texturePath,
    '-vf', `crop=${Number(rect.width)}:${Number(rect.height)}:${Number(rect.x)}:${Number(rect.y)}`,
    '-frames:v', '1', '-y', outputPath,
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`裁剪失败: ${result.stderr || outputPath}`);
}

function decodeAstc(astcenc, source, output) {
  const result = spawnSync(astcenc, ['-dl', source, output], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ASTC 解码失败: ${result.stderr || result.stdout || source}`);
  return fs.existsSync(output);
}

/** 输出文件名：沿用 seed_images_named 的 `{itemId}_{名称}.png` 约定。 */
function outputFileName(itemId, name) {
  const safeName = String(name || '').replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 40) || 'item';
  return `${Number(itemId)}_${safeName}.png`;
}

/**
 * 把 URL 池归一成 { configUrl, importBase, nativeBase, urls:Set } 形态。
 * URL 池里只要出现过 `.../<bundle>/config.<hash>.json`，同 bundle 的
 * import/native 路径就能推导（官方 Cocos 固定布局）。
 */
function buildBundleIndexes(urls) {
  const bundles = new Map();
  for (const url of urls) {
    const match = /^(https:\/\/[^/]+\/.*)\/config\.[^/]+\.json$/.exec(url);
    if (!match) continue;
    const base = match[1];
    if (!bundles.has(base)) bundles.set(base, new Set([url]));
    else bundles.get(base).add(url);
  }
  return bundles;
}

/** 搜集 wanted 列表：活动报告里带 extra.res 的道具。 */
function collectWantedFromReport(report) {
  const wanted = [];
  const activities = (report && report.online && report.online.activities) || [];
  for (const activity of activities) {
    const details = (activity && activity.details) || {};
    for (const feature of Object.values(details)) {
      const items = feature && Array.isArray(feature.items) ? feature.items : [];
      for (const item of items) {
        const resourcePath = parseResourcePath(item && item.extra);
        const itemId = Number(item && item.itemId) || Number(item && item.id) || 0;
        const name = String(item && (item.name || item.itemName) || '').trim();
        if (resourcePath && itemId > 0 && name) {
          wanted.push({ itemId, name, resourcePath });
        }
      }
    }
  }
  return wanted;
}

module.exports = {
  parseResourcePath,
  decodeUuid,
  versionMap,
  findPathIndex,
  parseSpriteFrame,
  outputFileName,
  buildBundleIndexes,
  collectWantedFromReport,
  downloadFile,
  cropPng,
  decodeAstc,
};

// ---- CLI ----
function usage() {
  return [
    '为活动道具抓取官方专属图标（输入：extra.res 逻辑路径；输出：seed_images_named/{itemId}_{name}.png）。',
    '',
    '用法：',
    '  npm run fetch:official-icons',
    '  npm run fetch:official-icons -- --cdn-base https://<官方资源基址>',
    '',
    '选项：',
    '  --report <路径>   活动报告（默认 core/data/activity-update-report.json）',
    '  --cdn-base <url>  官方 bundle 基址（也可用环境变量 FARM_RESOURCE_CDN_BASE）',
    '  --astcenc <路径>  显式指定 astcenc',
    '  --output <目录>   输出目录（默认 core/src/gameConfig/seed_images_named）',
    '  --dry-run         只打印将抓取的清单，不落盘',
    '',
    'URL 证据：core/data/capture/resource-urls.json（抓包会话被动记录）。',
    '注意：输出的 PNG 是新增二进制，必须人工审查后手动 git add，禁止夹带进自动进化提交。',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    report: path.join(dataDir, 'activity-update-report.json'),
    output: defaultOutput,
    cdnBase: process.env.FARM_RESOURCE_CDN_BASE || '',
    astcenc: process.env.ASTCENC_BIN || '',
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--report') args.report = path.resolve(argv[++index]);
    else if (value === '--output') args.output = path.resolve(argv[++index]);
    else if (value === '--cdn-base') args.cdnBase = argv[++index];
    else if (value === '--astcenc') args.astcenc = path.resolve(argv[++index]);
    else if (value === '--dry-run') args.dryRun = true;
    else if (value === '--help' || value === '-h') args.help = true;
    else throw new Error(`未知参数：${value}`);
  }
  return args;
}

function loadUrlPool(args) {
  const urls = new Set();

  // 1. 本机抓包记录
  const recorded = path.join(dataDir, 'capture', 'resource-urls.json');
  try {
    const saved = JSON.parse(fs.readFileSync(recorded, 'utf8'));
    for (const url of Array.isArray(saved.urls) ? saved.urls : []) {
      if (typeof url === 'string' && url.startsWith('https://')) urls.add(url);
    }
  } catch {
    // 文件不存在/损坏 = 没有抓包证据
  }

  // 2. macOS gamecaches（本机不存在则跳过）
  const fsRoot = path.join(
    os.homedir(),
    'Library/Containers/com.tencent.qqexminiprogram/Data/Library/Application Support/QQEX/miniapp/fs',
  );
  try {
    if (fs.existsSync(fsRoot)) {
      for (const entry of fs.readdirSync(fsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const cacheList = path.join(fsRoot, entry.name, APP_ID, 'usr', 'gamecaches', 'cacheList.json');
        if (!fs.existsSync(cacheList)) continue;
        const list = JSON.parse(fs.readFileSync(cacheList, 'utf8'));
        for (const url of Object.keys(list.files || {})) {
          if (url.startsWith('https://')) urls.add(url.split('?')[0]);
        }
      }
    }
  } catch {
    // 缓存读取失败忽略
  }

  // 3. 人工提供的 CDN 基址（--cdn-base / env / private-config.json）
  let cdnBase = String(args.cdnBase || '').trim();
  if (!cdnBase) {
    try {
      const privateConfig = JSON.parse(fs.readFileSync(path.join(dataDir, 'private-config.json'), 'utf8'));
      cdnBase = String(privateConfig.resourceCdnBase || '').trim();
    } catch {
      // 无人工配置
    }
  }
  if (cdnBase) {
    urls.add(`${cdnBase.replace(/\/+$/, '')}/config.index.json`);
  }

  return urls;
}

function resolveAstcenc(args) {
  const candidates = [
    args.astcenc,
    process.env.ASTCENC_BIN,
  ].filter(Boolean);
  const existing = candidates.find(candidate => fs.existsSync(candidate));
  if (existing) return existing;
  const toolPath = path.join(dataDir, 'tools', 'astcenc-5.5.0', 'bin', 'astcenc');
  if (fs.existsSync(toolPath)) return toolPath;
  const which = spawnSync('sh', ['-c', 'command -v astcenc'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const report = fs.existsSync(args.report)
    ? JSON.parse(fs.readFileSync(args.report, 'utf8'))
    : null;
  const wanted = report ? collectWantedFromReport(report) : [];
  if (wanted.length === 0) {
    console.log('活动报告中没有带 extra.res 资源路径的道具，无需抓取。');
    return;
  }

  const urls = loadUrlPool(args);
  const bundles = buildBundleIndexes(urls);
  if (bundles.size === 0) {
    console.warn('缺少官方资源 URL 证据（core/data/capture/resource-urls.json 为空或不存在，也没有 --cdn-base）。');
    console.warn(`待抓取清单（${wanted.length} 项）：`);
    for (const item of wanted) console.warn(`  - ${item.itemId} ${item.name} -> ${item.resourcePath}`);
    console.warn('下次抓包登录时开着游戏进入活动页，官方资源 URL 会自动被记录，之后重跑本脚本即可。');
    return;
  }

  // 逐 bundle 尝试：下载 config，匹配逻辑路径
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-icons.'));
  const astcenc = resolveAstcenc(args);
  const results = { ok: [], missing: [], failed: [] };
  let configCache = new Map();

  for (const item of wanted) {
    const target = path.join(args.output, outputFileName(item.itemId, item.name));
    if (fs.existsSync(target)) {
      results.ok.push({ ...item, target, skipped: true });
      continue;
    }
    let resolved = false;
    for (const [base, configUrls] of bundles) {
      let config = configCache.get(base);
      if (config === undefined) {
        const configUrl = [...configUrls][0];
        const configPath = path.join(downloadDir, `config-${base.replace(/\W+/g, '_')}.json`);
        if (!downloadFile(configUrl, configPath)) {
          configCache.set(base, null);
          continue;
        }
        try {
          config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch {
          config = null;
        }
        configCache.set(base, config);
      }
      if (!config) continue;

      const index = findPathIndex(config, item.resourcePath);
      if (index < 0) continue;
      const compactUuid = (config.uuids || [])[index];
      const uuid = decodeUuid(compactUuid);
      const importVersions = versionMap(config, 'import');
      const nativeVersions = versionMap(config, 'native');
      const importHash = importVersions.get(index);
      if (!uuid || !importHash) continue;

      const importUrl = `${base}/import/${uuid.slice(0, 2)}/${uuid}.${importHash}.json`;
      const importPath = path.join(downloadDir, `${item.itemId}-sprite.json`);
      if (!downloadFile(importUrl, importPath)) continue;
      let frame = null;
      try {
        frame = parseSpriteFrame(JSON.parse(fs.readFileSync(importPath, 'utf8')));
      } catch {
        continue;
      }
      if (!frame) continue;

      const textureUuid = decodeUuid(frame.textureRef);
      let textureIndex = (config.uuids || []).findIndex(u => decodeUuid(u) === textureUuid);
      if (textureIndex < 0) {
        // textureRef 可能直接是完整 UUID 字符串（非压缩形式）
        textureIndex = (config.uuids || []).indexOf(frame.textureRef);
      }
      const nativeHash = nativeVersions.get(textureIndex);
      if (!textureUuid || !nativeHash) continue;

      for (const ext of ['.png', '.astc']) {
        const textureUrl = `${base}/native/${textureUuid.slice(0, 2)}/${textureUuid}.${nativeHash}${ext}`;
        const texturePath = path.join(downloadDir, `${item.itemId}-texture${ext}`);
        if (!downloadFile(textureUrl, texturePath)) continue;
        try {
          if (args.dryRun) {
            console.log(`[dry-run] ${item.itemId} ${item.name} <- ${textureUrl}`);
            results.ok.push({ ...item, target, dryRun: true });
            resolved = true;
            break;
          }
          let sourcePng = texturePath;
          if (ext === '.astc') {
            if (!astcenc) throw new Error('需要 astcenc 解码 ASTC 纹理（--astcenc 或 ASTCENC_BIN）');
            const decoded = path.join(downloadDir, `${item.itemId}-decoded.png`);
            if (!decodeAstc(astcenc, texturePath, decoded)) throw new Error('ASTC 解码未产出文件');
            sourcePng = decoded;
          }
          cropPng(sourcePng, frame.rect, target);
          console.log(`已抓取：${item.itemId} ${item.name} -> ${path.relative(coreRoot, target)}`);
          results.ok.push({ ...item, target });
          resolved = true;
          break;
        } catch (error) {
          console.warn(`失败：${item.itemId} ${item.name}: ${error.message}`);
        }
      }
      if (resolved) break;
    }
    if (!resolved) {
      if (results.ok.some(entry => entry.itemId === item.itemId)) continue;
      results.missing.push(item);
    }
  }

  console.log('');
  console.log(`完成：成功 ${results.ok.length}（含已存在 ${results.ok.filter(e => e.skipped).length}），缺证据 ${results.missing.length}，失败 ${results.failed.length}`);
  if (results.missing.length > 0) {
    console.warn('缺证据（URL 池里没有匹配的资源路径）：');
    for (const item of results.missing) console.warn(`  - ${item.itemId} ${item.name} -> ${item.resourcePath}`);
  }
  const newFiles = results.ok.filter(entry => !entry.skipped && !entry.dryRun);
  if (newFiles.length > 0) {
    console.warn('');
    console.warn(`新增 ${newFiles.length} 个 PNG（未跟踪二进制）：必须人工审查后手动 git add；`);
    console.warn('自动进化提交严禁携带新增二进制，父进程隐私扫描会整笔阻断。');
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  }
}
