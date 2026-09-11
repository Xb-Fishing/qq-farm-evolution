#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { getDataFile } = require('../src/config/runtime-paths');
const { compareClientSeedCatalog } = require('../src/services/seed-catalog-audit');

// 只解析 JSON / Cocos JsonAsset，不执行 game.js 或任何外部脚本。
function readTable(file, name) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(data) && data.every(row => row && Number.isSafeInteger(row.id))) return data;
  const matches = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value) && value[1] === name && Array.isArray(value[2])) matches.push(value[2]);
    if (!Array.isArray(value) && value._name === name && Array.isArray(value.json)) matches.push(value.json);
    for (const child of Object.values(value)) visit(child);
  };
  visit(data);
  if (matches.length !== 1) throw new Error(`${name}: 必须提供已解出的表或唯一同名 JsonAsset`);
  return matches[0];
}

function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--items', '--plants', '--ids'].includes(argv[i]) || !argv[i + 1]) throw new Error('参数: --items <ItemInfo JSON> --plants <Plant JSON> [--ids <逗号分隔物品 ID>]');
    options[argv[i].slice(2)] = argv[i + 1];
  }
  const itemFile = options.items || getDataFile('client-config-evidence/ItemInfo.json');
  const plantFile = options.plants || getDataFile('client-config-evidence/Plant.json');
  if (!fs.existsSync(itemFile) || !fs.existsSync(plantFile)) {
    console.log(JSON.stringify({ status: 'evidence_missing', message: '需取得当前官方客户端 ItemInfo/Plant 配置快照；缺证据不等于已检查通过' }));
    return;
  }
  const items = readTable(path.resolve(itemFile), 'ItemInfo');
  const plants = readTable(path.resolve(plantFile), 'Plant');
  const ids = options.ids ? new Set(options.ids.split(',').map(Number)) : null;
  const differences = compareClientSeedCatalog(ids ? items.filter(item => ids.has(item.id)) : items, plants);
  console.log(JSON.stringify({ status: differences.length ? 'gaps_found' : 'aligned', differences }, null, 2));
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { readTable, main };
