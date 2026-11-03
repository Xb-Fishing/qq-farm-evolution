const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const web = path.resolve(__dirname, '../../web'), ts = require(path.join(web, 'node_modules/typescript')), vue = require(path.join(web, 'node_modules/vue')), pinia = require(path.join(web, 'node_modules/pinia'));
const presentationFile = path.join(web, 'src/utils/land-presentation.ts');
function evaluate(file, resolve, extra = {}) { const mod = { exports: {} }, source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText; vm.compileFunction(source, ['require', 'module', 'exports', ...Object.keys(extra)])(resolve, mod, mod.exports, ...Object.values(extra)); return mod.exports; }
const presentation = evaluate(presentationFile, name => { throw Error(name); });
test('blue crystal remains level six across normal, dry and 2x2 soil, without pretending to have a dedicated official sprite', () => {
  for (const fields of [{}, { needWater: true }, { plantSize: 2 }]) {
    const blue = presentation.getLandPresentation({ level: 6, status: 'empty', ...fields }); assert.equal(blue.level, 6); assert.match(blue.label, /蓝晶土地.*6级/); assert.equal(blue.rotate, false); assert.notEqual(blue.filter, 'none'); assert.doesNotMatch(blue.textureUrl, /valid5|dry5/); assert.ok(fs.existsSync(path.join(web, 'public', blue.textureUrl)));
  }
  const purple = presentation.getLandPresentation({ level: 5 }); assert.match(purple.textureUrl, /valid5\.png$/); assert.equal(purple.rotate, true); assert.equal(purple.filter, 'none');
  for (let level = 1; level < 5; level++) assert.match(presentation.getLandPresentation({ level }).textureUrl, new RegExp(`valid${level}\\.png$`));
  assert.equal(presentation.getLandPresentation({ level: 6, status: 'locked', plantSize: 2 }).textureUrl, '/game-config/land_images/land_locked.png'); assert.match(presentation.getLandPresentation({ level: 7 }).label, /未知/);
});
function farmFixture() {
  pinia.setActivePinia(pinia.createPinia()); const requests = [], account = vue.ref('selected-account');
  const api = { get: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) };
  const module = evaluate(path.join(web, 'src/stores/farm.ts'), name => name === 'vue' ? vue : name === 'pinia' ? pinia : name === '@/api' ? { default: api } : name === '@/stores/account' ? { useAccountStore: () => ({ currentAccountId: account }) } : (() => { throw Error(name); })());
  return { store: module.useFarmStore(), requests, account };
}
test('same-account late land responses cannot overwrite the newer upgraded level or clear another active read', async () => {
  const f = farmFixture(), old = f.store.fetchLands('selected-account'), fresh = f.store.fetchLands('selected-account');
  f.requests[1].resolve({ data: { ok: true, data: { lands: [{ id: 1, level: 6 }], summary: {} } } }); await fresh;
  f.requests[0].resolve({ data: { ok: true, data: { lands: [{ id: 1, level: 5 }], summary: {} } } }); await old; assert.equal(f.store.lands[0].level, 6);
  const before = f.store.fetchLands('selected-account'), after = f.store.fetchLands('selected-account'); f.requests[2].resolve({ data: { ok: true, data: { lands: [], summary: {} } } }); await before; assert.equal(f.store.loading, true);
  f.requests[3].resolve({ data: { ok: true, data: { lands: [{ id: 1, level: 6 }], summary: {} } } }); await after; assert.equal(f.store.loading, false);
});
test('clearing account data invalidates late land ownership and loading completion', async () => {
  const f = farmFixture(), pending = f.store.fetchLands('selected-account'); f.store.clearFarmData(); f.requests[0].resolve({ data: { ok: true, data: { lands: [{ id: 1, level: 6 }], summary: {} } } }); await pending; assert.equal(f.store.lands.length, 0); assert.equal(f.store.loading, false);
});
test('actual own-land callback only invalidates existing panel reads, with no requests or action scheduling', () => {
  const file = path.resolve(__dirname, '../src/core/worker.js'), source = fs.readFileSync(file, 'utf8'), ast = ts.createSourceFile('worker.js', source, ts.ScriptTarget.Latest), declaration = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'onOwnLandsPanelChanged'); assert.ok(declaration);
  let invalidations = 0; const callback = vm.runInNewContext('(' + declaration.getText(ast) + ')', { require: name => { assert.equal(name, '../services/farm-land-analyzer'); return { invalidatePanelLandsCache: () => invalidations++ }; } }); callback([{ id: 1, level: 6 }]); assert.equal(invalidations, 1); callback([]); callback(null); assert.equal(invalidations, 1);
  assert.match(source, /networkEvents\.on\('landsChanged', onOwnLandsPanelChanged\)/); assert.match(source, /networkEvents\.off\('landsChanged', onOwnLandsPanelChanged\)/);
});
