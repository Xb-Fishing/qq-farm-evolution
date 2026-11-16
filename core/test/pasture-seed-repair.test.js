'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const temp = fs.realpathSync(os.tmpdir());
const data = fs.mkdtempSync(path.join(temp, 'pasture-seed-'));
assert.equal(path.dirname(data), temp);
process.env.FARM_DATA_DIR = data;
process.env.FARM_PRIVATE_CONFIG_FILE = path.join(data, 'none.json');
const config = require('../src/config/gameConfig');
const { loadProto, types } = require('../src/utils/proto');
const base = path.resolve(__dirname, '../src/gameConfig');
const sources = JSON.parse(fs.readFileSync(path.join(base, 'seed_images_named/event-seed-sources.json')));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const files = ['EventItems.json', 'EventPlants.json', 'seed_images_named/event-seed-sources.json', 'seed_images_named/20040_Crop_40_Seed.png', 'seed_images_named/7001_Crop_40_Fruit.png'];
const snapshot = () => files.map(file => [file, sha(fs.readFileSync(path.join(base, file))), fs.statSync(path.join(base, file)).mode & 0o777]);
const before = snapshot();
test.before(loadProto);
test.after(() => { try { assert.deepEqual(snapshot(), before); } finally { fs.rmSync(data, { recursive: true, force: true }); } });
function warehouse(t, items, sale = false) {
  const saved = []; const calls = []; const sold = [];
  const inject = (name, value) => { const id = require.resolve(name); saved.push([id, require.cache[id]]); if (value) require.cache[id] = { exports: value }; else delete require.cache[id]; };
  const store = require('../src/models/store'); const utils = require('../src/utils/utils');
  inject('../src/utils/network', { networkEvents: new EventEmitter(), getUserState: () => ({ accountId: 'synthetic-pasture', level: 200, gold: 0 }), getWsErrorState: () => null,
    sendMsgAsync: async (_service, method, bytes) => {
      calls.push(method);
      if (method === 'Bag') return { body: types.BagReply.encode({ item_bag: { items } }).finish() };
      assert.equal(method, 'Sell', 'only isolated Bag/Sell codec fixtures are permitted');
      const request = types.SellRequest.decode(bytes); sold.push(...request.items.map(item => Number(item.id)));
      return { body: types.SellReply.encode({ sell_items: request.items, get_items: [{ id: 1001, count: 10 }] }).finish() };
    } });
  inject('../src/utils/utils', { ...utils, log() {}, logWarn() {} });
  inject('../src/models/store', { ...store, isAutomationOn: () => sale });
  inject('../src/services/warehouse', null);
  t.after(() => { for (const [id, old] of saved.reverse()) { if (old) require.cache[id] = old; else delete require.cache[id]; } });
  return { service: require('../src/services/warehouse'), calls, sold };
}
test('exact reviewed pasture row resolves seed/plant/fruit and explicit single plot', () => {
  const plant = config.getPlantBySeedId(20040);
  assert.ok(plant, 'the verified pasture seed must resolve to its actual Plant row');
  assert.deepEqual([plant.id, plant.size, plant.seed_id, plant.land_level_need, plant.seasons, plant.exp], [1020040, 1, 20040, 1, 1, 10]);
  assert.deepEqual(plant.fruit, { id: 7001, count: 20 });
  assert.equal(plant.grow_phases, '种子:300;大叶子:300;成熟:0;');
  assert.equal(config.getPlantByFruitId(7001).id, plant.id);
  assert.equal(config.getItemById(7001).official_type, 6);
  assert.equal(config.getItemById(7001).sells, '1001:5');
  assert.equal(config.getItemById(7001).auto_sell, false);
  assert.equal(config.isSeedItem(7001), false);
  assert.equal(config.getPlantBySeedId(29005).size, 2);
  const proof = sources.reviewedPasturePlantMapping;
  assert.equal(proof.sourceGrade, 'reviewed_public_client_snapshot');
  assert.equal(proof.sourceCommit, '545bbcfd209546ffc1594e65cd6d32d30137cddd');
  assert.deepEqual(proof.mapping, { seedId: 20040, plantId: 1020040, fruitId: 7001, fruitCount: 20, size: 1, sourceSize: null });
});
test('dedicated seed and feed item icons match exact reviewed source bytes and lookup', () => {
  for (const id of [20040, 7001]) {
    const record = sources.reviewedResources.find(item => item.itemId === id);
    assert.ok(record); assert.equal(record.assetName, 'Crop_40');
    const bytes = fs.readFileSync(path.join(base, 'seed_images_named', record.file));
    assert.equal(sha(bytes), '501456ce9d53293847e9277f598a7c10585f1568d5ae469cfe1d08ae50bd7a5f');
    assert.equal(sha(bytes), record.sha256);
    assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [100, 100]);
    assert.ok(config.getItemImageById(id).endsWith(record.file));
  }
  assert.ok(config.getSeedImageBySeedId(20040).endsWith('20040_Crop_40_Seed.png'));
  assert.deepEqual(config.getGenericFallbackItemIds(), []);
});
test('real Bag reply clears pasture footprint/icon gaps and preserves four-plot metadata', async t => {
  const f = warehouse(t, [{ id: 20040, count: 2, uid: 9001 }, { id: 7001, count: 40, uid: 9002 }, { id: 29005, count: 1, uid: 9003 }]);
  const detail = await f.service.getBagDetail();
  assert.equal(detail.items.find(item => item.id === 20040).plantSize, 1);
  assert.equal(detail.items.find(item => item.id === 29005).plantSize, 2);
  assert.equal(detail.seedRecognition.issues.some(item => [20040, 7001].includes(item.itemId)), false);
  const seeds = f.service.getBagSeedsFromItems([{ id: 20040, count: 2 }, { id: 7001, count: 40 }]);
  assert.equal(seeds.length, 1); assert.equal(seeds[0].plantSize, 1); assert.equal(seeds[0].mappingStatus, 'mapped');
  assert.deepEqual(f.calls, ['Bag']);
});
test('automatic selling retains pasture feed, including in a mixed ordinary fruit bag', async t => {
  for (const mixed of [false, true]) await t.test(mixed ? 'mixed' : 'feed only', async t => {
    const items = [{ id: 7001, count: 40, uid: 9101 }, ...(mixed ? [{ id: 40002, count: 2, uid: 9102 }] : [])];
    const f = warehouse(t, items, true);
    await f.service.sellAllFruits();
    assert.deepEqual(f.sold, mixed ? [40002] : []);
    assert.deepEqual(f.calls, mixed ? ['Bag', 'Sell'] : ['Bag']);
  });
});
test('actual seed-priority card consumes the real DTO: pasture loses unknown-footprint badge while genuine unknowns and four-plot crops stay distinct', t => {
  config.registerRuntimeItem(940041, { name: '合成缺映射种子', type: 5, evidence: 'isolated synthetic item fixture' });
  const f = warehouse(t, []);
  const seeds = f.service.getBagSeedsFromItems([{ id: 20040, count: 2 }, { id: 29005, count: 1 }, { id: 940041, count: 1 }]);
  const web = path.resolve(__dirname, '../../web'); const vue = require(path.join(web, 'node_modules/vue'));
  const compiler = require(path.join(web, 'node_modules/vue/compiler-sfc')); const ts = require(path.join(web, 'node_modules/typescript'));
  const source = path.join(web, 'src/components/settings/BagSeedPriorityPanel.vue');
  const parsed = compiler.parse(fs.readFileSync(source, 'utf8'), { filename: source }); assert.deepEqual(parsed.errors, []);
  const script = compiler.compileScript(parsed.descriptor, { id: 'pasture-priority', inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false } } });
  const code = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
  const mod = { exports: {} };
  vm.compileFunction(code, ['require', 'module', 'exports'])(name => { assert.equal(name, 'vue'); return vue; }, mod, mod.exports);
  const node = tag => ({ tag, text: '', props: {}, children: [], parent: null });
  const { render } = vue.createRenderer({
    createElement: node, createText: text => ({ ...node('text'), text }), createComment: () => node('comment'),
    setText: (el, text) => { el.text = text; }, setElementText: (el, text) => { el.text = text; el.children.length = 0; },
    parentNode: el => el.parent, nextSibling: el => { const rows = el.parent?.children || []; return rows[rows.indexOf(el) + 1] || null; },
    insert: (el, parent, anchor) => { const at = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(at < 0 ? parent.children.length : at, 0, el); el.parent = parent; },
    remove: el => { if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1); el.parent = null; },
    patchProp: (el, key, _old, value) => { el.props[key] = value; },
  });
  const textOf = el => String(el.text || '') + el.children.map(textOf).join('');
  const find = (el, predicate) => [ ...(predicate(el) ? [el] : []), ...el.children.flatMap(child => find(child, predicate)) ];
  const root = node('root'); const removed = [];
  try {
    render(vue.h(mod.exports.default, { seeds, sortedSeeds: seeds, unplannedSeeds: [], loading: false, error: null, onRemove: id => removed.push(id) }), root);
    const rows = find(root, el => el.props.draggable === 'true' || el.props.draggable === true);
    assert.equal(rows.length, 3);
    const pasture = rows.find(el => textOf(el).includes('牧草种子'));
    assert.ok(pasture); assert.doesNotMatch(textOf(pasture), /占地待确认|2×2/);
    assert.equal(find(pasture, el => el.tag === 'img')[0].props.src, config.getSeedImageBySeedId(20040));
    assert.match(textOf(rows.find(el => textOf(el).includes('合成缺映射种子'))), /占地待确认/);
    assert.match(textOf(rows.find(el => textOf(el).includes(config.getItemById(29005).name))), /2×2/);
    find(pasture, el => el.tag === 'button' && el.props['aria-label'] === '移出优先列表')[0].props.onClick();
    assert.deepEqual(removed, [20040]); assert.deepEqual(f.calls, []);
  } finally { render(null, root); }
});
