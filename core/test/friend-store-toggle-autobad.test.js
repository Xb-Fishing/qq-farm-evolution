const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const vue = require(path.join(root, 'web/node_modules/vue'));
const pinia = require(path.join(root, 'web/node_modules/pinia'));
const ts = require(path.join(root, 'web/node_modules/typescript'));

// 换账号后旧账号的 toggle 响应（成功或失败）回来：不写 autoBadList、结果标 stale，
// Friends.vue 据此不弹当前页 toast。
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function storeHarness(accountId = 'account-a') {
  const account = vue.reactive({ currentAccountId: accountId });
  const pending = [];
  const apiStub = {
    get: async () => ({ data: { ok: true, data: [] } }),
    post: (url, body, config) => { const d = deferred(); pending.push({ url, body, config, ...d }); return d.promise; },
  };
  const friendSource = fs.readFileSync(path.join(root, 'web/src/stores/friend.ts'), 'utf8');
  const code = ts.transpileModule(friendSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
  const mod = { exports: {} };
  vm.compileFunction(code, ['require', 'module', 'exports'])(name => {
    if (name === 'pinia') return pinia;
    if (name === 'vue') return vue;
    if (name === '@/api') return { __esModule: true, default: apiStub };
    if (name === '@/stores/account') return { useAccountStore: () => account };
    throw new Error(`unexpected import ${name}`);
  }, mod, mod.exports);
  return { store: mod.exports.useFriendStore(pinia.createPinia()), account, pending };
}

test('store: 旧账号迟到成功/失败响应不污染新名单，结果标 stale', async () => {
  const h = storeHarness('account-a');
  h.store.autoBadList = [{ gid: 1 }];

  const p1 = h.store.toggleAutoBad('account-a', 777);
  h.account.currentAccountId = 'account-b'; // 请求在途时切换账号
  h.pending[0].resolve({ data: { ok: true, data: [{ gid: 777 }] } }); // 旧账号迟到成功
  const r1 = await p1;
  assert.equal(r1.stale, true, '迟到响应必须标 stale');
  assert.deepEqual(h.store.autoBadList, [{ gid: 1 }], '旧账号成功响应不得写新账号名单');

  const p2 = h.store.toggleAutoBad('account-a', 777);
  h.pending[1].resolve(Promise.reject(Object.assign(new Error('late'), { response: { data: { error: '旧账号错误' } } })));
  const r2 = await p2;
  assert.equal(r2.stale, true);
  assert.equal(r2.error, '', '迟到错误不得带到当前页');
  assert.deepEqual(h.store.autoBadList, [{ gid: 1 }]);
});

test('store: 仍是当前账号时正常写名单/返回业务错误', async () => {
  const h = storeHarness('account-a');
  const p1 = h.store.toggleAutoBad('account-a', 777);
  h.pending[0].resolve({ data: { ok: true, data: [{ gid: 777 }] } });
  assert.equal((await p1).ok, true);
  assert.deepEqual(h.store.autoBadList, [{ gid: 777 }]);

  const p2 = h.store.toggleAutoBad('account-a', 888);
  h.pending[1].resolve({ data: { ok: false, error: '设置失败：参数无效' } });
  const r2 = await p2;
  assert.equal(r2.ok, false);
  assert.equal(r2.stale, false);
  assert.equal(r2.error, '设置失败：参数无效');
});
