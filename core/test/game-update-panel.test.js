const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./activity-availability.test');
const { mountActivityPage, apiMock, buttonsOf, textOf, click, flush, findAll, vue, render, deferred } = h;
const catalog = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../src/gameConfig/UpdateCatalog.json')));
const button = (root, text) => buttonsOf(root).find(node => textOf(node).trim() === text);
function fixture(options = {}) {
  const api = apiMock();
  api.setGet(async url => {
    if (url === '/api/activity/game-update-catalog') return { data: { ok: true, catalog } };
    if (url === '/api/activity/emails') return { data: { ok: true, snapshot: { boxes: { 1: { ok: true, total: 3, claimable: 1, fetchedAt: Date.now() }, 2: { ok: false } } } } };
    if (url === '/api/activity/game-update-evidence') {
      if (options.gate) await options.gate.promise;
      return { data: options.fail ? { ok: false, error: '模拟普通失败' } : { ok: true, evidence: { collectedAt: Date.now(), sources: { tasks: { status: 'error' } } } } };
    }
    return { data: { ok: true, activity: h.snapshot() } };
  });
  return { api, page: mountActivityPage(api) };
}
test('actual page opens read-only mail and searchable collection catalog; star selection changes materials with zero writes', async () => {
  const { api, page } = fixture(); await flush();
  assert.equal(api.calls.get.some(row => row.url === '/api/activity/emails'), false);
  click(button(page.root, '查看更新与邮箱')); await flush();
  assert.match(textOf(page.root), /系统邮箱/); assert.match(textOf(page.root), /本箱读取失败/);
  const search = findAll(page.root, n => n.props['aria-label'] === '搜索藏品')[0];
  search.props['onUpdate:modelValue']('棉芽'); await vue.nextTick();
  const item = buttonsOf(page.root).find(node => textOf(node).includes('棉芽 ·'));
  assert.ok(item); click(item); await vue.nextTick();
  const select = findAll(page.root, n => n.props['aria-label'] === '查看星级')[0];
  select.props['onUpdate:modelValue'](2); await vue.nextTick();
  assert.match(textOf(page.root), /同款藏品 × 2/); assert.match(textOf(page.root), /金币 × 3,000,000/);
  assert.equal(api.calls.post.length, 0);
  search.props['onUpdate:modelValue']('不存在的合成名称'); await vue.nextTick(); assert.match(textOf(page.root), /没有匹配/);
  render(null, page.root);
});
test('ordinary read failure releases loading and unmount/account switch discard late snapshots', async () => {
  const { page } = fixture({ fail: true }); await flush(); click(button(page.root, '查看更新与邮箱')); await flush();
  assert.match(textOf(page.root), /模拟普通失败/); assert.notEqual(button(page.root, '刷新今日动态').props.disabled, true);
  render(null, page.root);
  const gate = deferred(); const pending = fixture({ gate }); await flush(); click(button(pending.page.root, '查看更新与邮箱')); await flush();
  pending.page.accountRef.value = 'synthetic-second'; await flush(); gate.resolve(); await flush();
  assert.doesNotMatch(textOf(pending.page.root), /模拟普通失败/); render(null, pending.page.root);
});
test('reviewed config keeps previous levels and mappings, excludes invalid test seeds and provides twenty actual new crops', () => {
  const role = require('../src/gameConfig/RoleLevel.json'); assert.equal(role.length, 240); assert.equal(role.at(-1).level, 240);
  const { getPlantBySeedId, getItemById, getAllSeeds } = require('../src/config/gameConfig');
  assert.equal(catalog.crops.length, 20); assert.equal(catalog.series.flatMap(row => row.items).length, 30);
  for (const crop of catalog.crops) {
    const plant = getPlantBySeedId(crop.seedId); assert.ok(plant); assert.equal(plant.id, crop.plantId); assert.equal(plant.size, 1);
    assert.equal(plant.fruit.id, crop.fruitId); assert.equal(plant.land_level_need, 1); assert.ok(getItemById(crop.seedId).name.includes(crop.name));
  }
  assert.equal(getAllSeeds().some(seed => seed.seedId === 29999), false);
});


test('fulfilled malformed catalog data preserves the previous usable catalog and reports failure without a render exception', async () => {
  const { api, page } = fixture(); await flush(); click(button(page.root, '查看更新与邮箱')); await flush();
  api.setGet(async () => ({ data: { ok: true, catalog: { series: {}, scores: [], milestones: [] } } }));
  click(button(page.root, '刷新本地目录')); await flush();
  assert.match(textOf(page.root), /目录状态不完整/);
  assert.ok(buttonsOf(page.root).some(node => textOf(node).includes('棉芽 ·')));
  assert.equal(api.calls.post.length, 0); render(null, page.root);
});

test('dog and collections require explicit clicks and render selected-account state with exact counts and zero writes', async () => {
  const { api, page } = fixture(); await flush(); click(button(page.root, '查看更新与邮箱')); await flush();
  assert.equal(api.calls.get.some(row => /dog-state|collection-state/.test(row.url)), false);
  api.setGet(async url => ({ data: { ok: true, state: url.endsWith('dog-state')
    ? { fetchedAt: 1, dogs: [], currentDogName: '合成守卫犬', pendingGiftCountDec: '0', foods: [{ id: 90004, name: '狗粮', countDec: '9007199254740993' }], foodInventoryKnown: true, feedingEnabled: false, feedingReason: '请在游戏内喂食' }
    : { fetchedAt: 1, currentScore: 400, claimedScore: 0, items: [{ id: 710001, name: '菇菇氧', star: 2, ownedCountDec: '3' }], displays: [{ slotType: 1, name: '菇菇氧' }], writesEnabled: false } } }));
  click(button(page.root, '读取守卫犬状态')); await flush(); assert.match(textOf(page.root), /合成守卫犬/); assert.match(textOf(page.root), /9,007,199,254,740,993/);
  click(button(page.root, '读取珍藏室状态')); await flush(); assert.match(textOf(page.root), /当前评分 400/); assert.match(textOf(page.root), /2 星/); assert.match(textOf(page.root), /展台 1：菇菇氧/);
  assert.equal(api.calls.post.length, 0); render(null, page.root);
});
test('read-only panel errors retain success and an account switch drops late ownership results', async () => {
  const { api, page } = fixture(); await flush(); click(button(page.root, '查看更新与邮箱')); await flush();
  const state = { fetchedAt: 1, currentScore: 400, claimedScore: 0, items: [{ id: 710001, name: '合成持有藏品', star: 2, ownedCountDec: '3' }], displays: [], writesEnabled: false };
  api.setGet(async () => ({ data: { ok: true, state } })); click(button(page.root, '读取珍藏室状态')); await flush(); assert.match(textOf(page.root), /合成持有藏品/);
  api.setGet(async () => ({ data: { ok: true, state: { ...state, items: [null] } } })); click(button(page.root, '读取珍藏室状态')); await flush(); assert.match(textOf(page.root), /珍藏室状态不完整/); assert.match(textOf(page.root), /合成持有藏品/);
  const gate = deferred(); api.setGet(async () => { await gate.promise; return { data: { ok: true, state } }; }); click(button(page.root, '读取珍藏室状态')); await flush(); page.accountRef.value = 'synthetic-second'; await flush(); gate.resolve(); await flush(); assert.doesNotMatch(textOf(page.root), /合成持有藏品/); assert.equal(api.calls.post.length, 0); render(null, page.root);
});
