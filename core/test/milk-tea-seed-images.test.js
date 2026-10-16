const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const temp = fs.realpathSync(os.tmpdir()), prefix = path.resolve(temp, 'farm-milk-images-'); assert.equal(path.dirname(prefix), temp);
const data = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = data;
const base = path.resolve(__dirname, '../src/gameConfig/seed_images_named');
const manifest = JSON.parse(fs.readFileSync(path.join(base, 'event-seed-sources.json')));
const rows = manifest.reviewedResources || [];
const config = require('../src/config/gameConfig');
const files = [__filename, path.join(base, 'event-seed-sources.json'), ...rows.map(x => path.resolve(base, x.file))];
for (const file of files.slice(2)) assert.equal(path.dirname(file), base);
const fingerprint = () => files.map(file => ({ mode: fs.statSync(file).mode & 0o777, hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
const before = fingerprint();
test.after(() => { try { assert.deepEqual(fingerprint(), before); } finally { assert.equal(path.dirname(data), temp); fs.rmSync(data, { recursive: true, force: true }); } });
for (const id of [20525, 20526, 20527, 20528, 20529, 21435, 20021, 29005]) {
  test(`current activity seed ${id} has a delivered exclusive image with pinned source bytes`, () => {
    const image = config.getSeedImageBySeedId(id); assert.ok(image, 'known current seed image must resolve'); assert.doesNotMatch(image, /common|placeholder/);
    const row = rows.find(x => x.itemId === id); assert.ok(row, 'the exact resource must have a reviewed source record');
    assert.equal(image, '/game-config/seed_images_named/' + row.file); assert.equal(row.kind, 'seed');
    const bytes = fs.readFileSync(path.join(base, row.file)); assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), row.sha256);
    assert.equal(crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex'), row.gitBlob);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.equal(bytes.readUInt32BE(16), row.width); assert.equal(bytes.readUInt32BE(20), row.height);
  });
}
test('normal and naturally observed golden fruit images resolve without inventing Plant mappings', () => {
  for (const row of rows.filter(x => x.kind !== 'seed')) assert.equal(config.getItemImageById(row.itemId), '/game-config/seed_images_named/' + row.file);
  assert.ok(config.getItemImageById(1040525), 'the observed golden fruit has its own image');
  assert.equal(config.getPlantByFruitId(1040525), undefined); assert.equal(config.getPlantBySeedId(20529), undefined);
  assert.deepEqual(config.getGenericFallbackItemIds(), []);
});
test('real bag seed recognition clears icon gaps while keeping unverified footprints separate', () => {
  const { getBagSeedsFromItems } = require('../src/services/warehouse');
  const { auditBagSeedCoverage } = require('../src/services/seed-catalog-audit');
  const items = [29005, 20529].map(id => ({ id, count: 1 })); const seeds = getBagSeedsFromItems(items), audit = auditBagSeedCoverage(items, seeds);
  assert.equal(audit.issues.some(x => x.kind === 'seed_icon_missing'), false);
  assert.equal(audit.issues.some(x => x.itemId === 29005 && x.kind === 'seed_footprint_unverified'), false);
  assert.ok(audit.issues.some(x => x.itemId === 20529 && x.kind === 'seed_footprint_unverified'));
  assert.equal(seeds.find(x => x.seedId === 29005).plantSize, 2); assert.equal(seeds.find(x => x.seedId === 20529).plantSize, 0);
});
