const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const base = fs.realpathSync(os.tmpdir());
const prefix = path.resolve(base, 'farm-owner-update-');
assert.equal(path.dirname(prefix), base);
const root = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = root;
process.env.FARM_PRIVATE_CONFIG_FILE = path.join(root, 'private-config.json');
const landTypes = require('../src/config/land-types');
const digest = require('../src/services/game-update-digest');
const context = require('../src/services/evolution-announcement-context');
const hash = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
const report = (sources, time = Date.now()) => ({ scannedAt: time, online: { available: true, activities: [], unknownActivityIds: [], gameUpdateEvidence: { sources } }, endedActivityIds: [] });
const source = (value, status = 'ok') => ({ status, factsHash: hash(value) });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
function dir() { const value = path.resolve(root, require('node:crypto').randomUUID()); assert.ok(value.startsWith(root + path.sep)); fs.mkdirSync(value, { mode: 0o700 }); return value; }
function fertilizerHarness(selected, readFails = false) {
  const file = path.resolve(__dirname, '../src/services/farm-fertilizer.js');
  const calls = [];
  const mocks = {
    '../utils/network': { sendMsgAsync() { throw new Error('unexpected network request'); } },
    '../utils/proto': { types: {} }, '../config/config': { PlantPhase: {} },
    '../utils/utils': { toNum: Number, log() {}, logWarn() {}, getServerTimeSec: () => 1800000000 },
    '../models/store': { getAutomation: () => ({ fertilizer: 'normal', fertilizer_land_types: selected }) },
    './stats': { recordOperation() {} }, './farm-land-analyzer': { getCurrentPhase() {} },
    '../config/land-types': landTypes,
    './farm-api': { NORMAL_FERTILIZER_ID: 101, ORGANIC_FERTILIZER_ID: 102,
      getAllLands: async () => { if (readFails) throw new Error('synthetic offline'); return { lands: [1, 6, 7].map(level => ({ id: 91000 + level, level })) }; },
      fertilize: async ids => { calls.push(Array.from(ids)); return ids.length; } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, require: name => {
    if (!Object.hasOwn(mocks, name)) throw new Error(`unexpected dependency: ${  name}`);
    return mocks[name];
  }, console }, { filename: file });
  return { calls, run: () => module.exports.runFertilizerByConfig([91001, 91006, 91007]) };
}

test('real fertilizer entry respects ordinary/blue scopes and legacy five selections without selecting unknown levels', async () => {
  for (const [selected, expected] of [[['normal'], [91001]], [['blue'], [91006]], [landTypes.DEFAULT_FERTILIZER_LAND_TYPES, [91001]], [landTypes.SUPPORTED_FERTILIZER_LAND_TYPES, [91001, 91006]]]) {
    const h = fertilizerHarness(selected); await h.run(); assert.deepEqual(h.calls, [expected]);
  }
  const missing = fertilizerHarness(landTypes.SUPPORTED_FERTILIZER_LAND_TYPES, true); await missing.run(); assert.equal(missing.calls.length, 0);
});
test('store preserves old saved choices, supports explicit blue and never adds blue to defaults', () => {
  const store = require('../src/models/store');
  assert.ok(!store.getAutomation('synthetic-default').fertilizer_land_types.includes('blue'));
  store.setAutomation('fertilizer_land_types', ['normal'], 'synthetic-scope');
  assert.deepEqual(store.getAutomation('synthetic-scope').fertilizer_land_types, ['normal']);
  store.setAutomation('fertilizer_land_types', ['blue'], 'synthetic-scope');
  assert.deepEqual(store.getAutomation('synthetic-scope').fertilizer_land_types, ['blue']);
  assert.ok(!store.getAutomation('synthetic-fresh').fertilizer_land_types.includes('blue'));
});
test('one successful new source survives another failure; recovery without semantic change is not a new version', () => {
  const data = dir();
  let value = digest.recordUpdateDigest(data, report({ announcements: source('first'), mall: source('same') }), 'initial');
  const initial = digest.captureUpdateBatch(data); digest.acknowledgeUpdateBatch(data, initial);
  value = digest.recordUpdateDigest(data, report({ announcements: source('new'), mall: source('ignored', 'error') }), 'partial');
  assert.equal(value.unreviewed.length, 1); assert.equal(value.unreviewed[0].source, 'announcements');
  assert.equal(value.sourceHashes.mall, hash('same'));
  value = digest.recordUpdateDigest(data, report({ announcements: source('new'), mall: source('same') }), 'recovered');
  assert.equal(value.unreviewed.length, 1);
});
test('exact captured acknowledgment preserves newer observations and pending facts enter both real prompt constructors', () => {
  const data = dir(); digest.recordUpdateDigest(data, report({ announcements: source('earlier') }), 'first');
  const captured = digest.captureUpdateBatch(data);
  digest.recordUpdateDigest(data, report({ announcements: source('later') }), 'second');
  assert.equal(digest.acknowledgeUpdateBatch(data, captured), true);
  const pending = digest.readUpdateDigest(data); assert.equal(pending.unreviewed.length, 1); assert.equal(pending.unreviewed[0].digest, hash('later'));
  const text = context.buildOfficialAnnouncementCacheContext(data); assert.match(text, /尚未核实完成/); assert.ok(text.includes(hash('later')));
});
test('malformed or symlink pending ledger is retained and cannot become an empty successful ledger', () => {
  const data = dir(); const file = path.join(data, 'activity-update-digest.json'); fs.writeFileSync(file, '{bad');
  assert.throws(() => digest.recordUpdateDigest(data, report({ announcements: source('new') }), 'new'));
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad'); assert.match(context.buildOfficialAnnouncementCacheContext(data), /记录不可读或格式无效/);
  const other = dir(); const outside = path.join(data, 'outside'); fs.writeFileSync(outside, 'sentinel'); fs.symlinkSync(outside, path.join(other, 'activity-update-digest.json'));
  assert.throws(() => digest.recordUpdateDigest(other, report({ announcements: source('new') }), 'new')); assert.equal(fs.readFileSync(outside, 'utf8'), 'sentinel');
});

test('new batch-confirmation helper remains protected while ordinary collection code can still be reviewed', () => {
  const { parseStageResult } = require('../src/services/evolution-team');
  const plan = { decision: 'approve', summary: 'Synthetic exact scope with real behavior checks', allowedFiles: ['core/src/services/game-update-evidence.js'], acceptanceChecks: ['Observe no extra RPC'], baselineChecks: [] };
  assert.equal(parseStageResult(JSON.stringify(plan), 'plan').allowedFiles[0], plan.allowedFiles[0]);
  assert.throws(() => parseStageResult(JSON.stringify({ ...plan, allowedFiles: ['core/src/services/game-update-digest.js'] }), 'plan'));
});
test('all twenty current crop pairs resolve existing or newly reviewed item images without generic fallback', () => {
  const cfg = require('../src/config/gameConfig'); const catalog = require('../src/services/update-catalog').getUpdateCatalog();
  for (const crop of catalog.crops) {
    assert.ok(crop.seedImage); assert.ok(crop.fruitImage); assert.equal(cfg.getPlantBySeedId(crop.seedId).size, 1);
  }
  assert.deepEqual(cfg.getGenericFallbackItemIds(), []);
  assert.equal(cfg.getMutantEffectById(18).name, '藏品'); assert.equal(cfg.getMutantEffectById(18).icon, '');
  assert.notEqual(cfg.getMutantEffectByIcon('naicha')?.id, 18); assert.equal(cfg.getMutantEffectByIcon('golden').id, 5);
  assert.equal(cfg.getMutantEffectById(13), undefined, 'the official hidden event is not exposed as an ordinary mutation');
});

test('bounded context prioritizes middle bulletin changes over ordinary progress without exceeding its exact batch', () => {
  const data = dir();
  for (let i = 0; i < 8; i++) digest.recordUpdateDigest(data, report({ emails: source(`old-${  i}`) }), 'old');
  digest.recordUpdateDigest(data, report({ announcements: source('middle-bulletin') }), 'bulletin');
  for (let i = 0; i < 16; i++) digest.recordUpdateDigest(data, report({ emails: source(`new-${  i}`) }), 'new');
  const batch = digest.captureUpdateBatch(data); assert.equal(batch.entries.length, 24);
  assert.ok(batch.entries.some(entry => entry.source === 'announcements')); assert.ok(digest.updateTriggerFingerprint(batch));
  assert.ok(context.buildOfficialAnnouncementCacheContext(data).includes(hash('middle-bulletin')));
});
test('same activity id with a new semantic identity survives acknowledgment of its older captured version', () => {
  const data = dir(); const first = { scannedAt: Date.now(), online: { unknownActivityIds: [91001], activities: [{ id: 91001, title: 'A', endTime: 2000 }] } };
  digest.recordUpdateDigest(data, first, 'first'); const old = digest.captureUpdateBatch(data);
  const second = { ...first, online: { ...first.online, activities: [{ id: 91001, title: 'B', endTime: 3000 }] } };
  digest.recordUpdateDigest(data, second, 'second'); assert.equal(digest.readUpdateDigest(data).unreviewed.length, 2);
  digest.acknowledgeUpdateBatch(data, old); digest.recordUpdateDigest(data, second, 'same');
  const pending = digest.readUpdateDigest(data).unreviewed; assert.equal(pending.length, 1); assert.notEqual(pending[0].key, old.entries[0].key);
});
