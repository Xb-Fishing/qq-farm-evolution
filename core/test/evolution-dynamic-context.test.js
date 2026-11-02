const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const prefix = path.resolve(fs.realpathSync(os.tmpdir()), 'farm-update-context-');
assert.equal(path.dirname(prefix), fs.realpathSync(os.tmpdir()));
const root = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = root;
const helper = require('../src/services/evolution-announcement-context');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
function write(value) {
  const dir = path.resolve(root, 'game-update-evidence'); assert.ok(dir.startsWith(root + path.sep));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.resolve(dir, `${'a'.repeat(24)  }.json`); assert.equal(path.dirname(file), dir);
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}
const fact = () => ({ source: 'game-update-evidence', collectedAt: Date.now(), status: 'partial_coverage', semanticHash: 'b'.repeat(64),
  sources: { emails: { status: 'ok', fetchedAt: Date.now(), boxes: { 1: { status: 'ok', total: 3, claimable: 1 }, 2: { status: 'error' } } }, tasks: { status: 'error', error: 'never-print-private-error' } },
  gaps: [{ entry: 'never-print-private-gap' }] });

test('real existing context builder includes bounded mailbox facts with source time and explicit missing coverage', () => {
  write(fact()); const text = helper.buildOfficialAnnouncementCacheContext(root);
  assert.match(text, /游戏更新证据快照/); assert.match(text, /"box1":3/); assert.match(text, /"claimable1":1/);
  assert.match(text, /未覆盖入口/); assert.doesNotMatch(text, /never-print-private/);
});
test('both actual Main prompt builders receive the dynamic evidence through their existing helper', () => {
  write(fact()); const evolver = require('../src/services/activity-evolver');
  for (const text of [evolver.buildSafetyPrompt(), evolver.buildPrompt({ online: { activities: [], groups: [] } }, [], [])]) {
    assert.match(text, /游戏更新证据快照/); assert.match(text, /"box1":3/);
    assert.match(text, /准备收据/); assert.match(text, /尚未核实完成/); assert.doesNotMatch(text, /never-print-private/);
  }
});
test('a previous-day snapshot cannot be presented as current, and wrong source cannot appear as valid facts', () => {
  const value = fact(); value.collectedAt -= 86400000; write(value);
  assert.match(helper.buildOfficialAnnouncementCacheContext(root), /非当日|不是当日/);
  write({ ...fact(), source: 'untrusted' }); const text = helper.buildOfficialAnnouncementCacheContext(root);
  assert.doesNotMatch(text, /"box1":3/); assert.match(text, /证据不完整/);
});
