const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const dir = fs.realpathSync(os.tmpdir()); const prefix = path.resolve(dir, 'request-diagnostics-'); assert.equal(path.dirname(prefix), dir);
const isolated = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = isolated;
test.after(() => fs.rmSync(isolated, { recursive: true, force: true }));
const ts = require('node:module').createRequire(path.resolve(__dirname, '../../web/package.json'))('typescript');
const source = fs.readFileSync(path.resolve(__dirname, '../../web/src/utils/request-diagnostics.ts'), 'utf8');
const moduleValue = { exports: {} };
vm.compileFunction(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, ['exports'])(moduleValue.exports);
const { requestOperation } = moduleValue.exports;
test('frontend request classification emits fixed operation names without URLs, query strings or account values', () => {
  assert.equal(requestOperation('post', '/api/shop/mall/buy?secret=hidden'), 'mall_purchase');
  assert.equal(requestOperation('get', '/api/friends/123?token=hidden'), 'friend_query');
  assert.equal(requestOperation('get', '/api/constructor'), 'other_query');
  assert.equal(requestOperation('get', 'https://unknown.invalid/private'), 'other_query');
  assert.equal(requestOperation('post', '/unknown/private/123'), 'other');
});
test('persisted diagnostics retain only approved phases and operations, without inventing trade outcome', () => {
  const { normalizeFeedback } = require('../src/services/daily-feedback');
  const event = normalizeFeedback({ kind: 'client_error', category: 'http_error', operation: 'mall_purchase', failurePhase: 'http_response',
    url: 'private-url', payload: 'secret', count: 50 }, 123);
  assert.equal(event.operation, 'mall_purchase'); assert.equal(event.failurePhase, 'http_response'); assert.equal(event.outcome, 'failed');
  assert.equal(event.url, undefined); assert.equal(event.payload, undefined); assert.equal(event.count, undefined);
  const invalid = normalizeFeedback({ kind: 'runtime', category: 'runtime_error', operation: 'private-url', failurePhase: 'constructor' }, 123);
  assert.equal(invalid.operation, undefined); assert.equal(invalid.failurePhase, undefined);
});
test('the authenticated feedback ingress retains fixed browser diagnostics and still refuses forged server outcomes', () => {
  let handler; const received = [];
  require('../src/controllers/admin-feedback-routes').registerAdminFeedbackRoutes({ app: { post: (_url, _auth, callback) => { handler = callback; } },
    requireAdminToken() {}, feedback: { record: event => { received.push(event); return true; } } });
  handler({ adminToken: 'fixture', body: { events: [{ kind: 'client_error', page: 'shop', category: 'http_error', operation: 'mall_purchase', failurePhase: 'http_response', payload: 'private' }, { kind: 'request', outcome: 'succeeded' }] } }, { json() {} });
  assert.equal(received.length, 1); assert.equal(received[0].operation, 'mall_purchase'); assert.equal(received[0].failurePhase, 'http_response'); assert.equal(received[0].payload, undefined);
});
