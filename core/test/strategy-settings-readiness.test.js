'use strict';
// 真实行为回归（设置页背包种子读取就绪守卫）：用 web 工作区既有依赖（vue / vue/compiler-sfc /
// typescript / pinia / @vueuse/core）在内存中编译真实 useStrategySettings.ts 与 Settings.vue，
// 以可控 api mock、假 setInterval 时钟与真实 Vue 响应式验证：
//   1) 账号未运行 / 运行态缺失 / 无选择时，种子首取与 15 秒轮询全部暂停；
//   2) 恢复运行立即读取恰好一次，此后仅按既有 15 秒周期；
//   3) 在途请求跨多个周期不重复发起；迟到成功/失败/finally 不回填；
//   4) 停止、选择切换、策略退出、显式重置与卸载后旧代次失效；
//   5) 离线仍可编辑保存策略，不触发读取、不清持久优先序、不新增运行状态请求；
//   6) Settings 调用点真实传入运行态（渲染真实组件，而非源码字符串匹配）。
// 网络与存储边界隔离：'@/api' 替换为可控 mock；vue-router 与子组件替换为 stub，不访问生产服务。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO_ROOT = path.join(__dirname, '..', '..');
const WEB_ROOT = path.join(REPO_ROOT, 'web');
const WEB_SRC = path.join(WEB_ROOT, 'src');
const WEB_MODULES = path.join(WEB_ROOT, 'node_modules');

// ---- 全局环境必须在加载 @vueuse/core 前就位（isClient 在模块加载时求值） ----
function memoryStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(String(key)) ? map.get(String(key)) : null),
    setItem: (key, value) => map.set(String(key), String(value)),
    removeItem: key => map.delete(String(key)),
    clear: () => map.clear(),
  };
}
globalThis.localStorage = memoryStorage();
// document 仅需满足 vue runtime-dom 模块加载时的 createElement("template") 探测；
// 渲染走测试自带 nodeOps，不使用 runtime-dom 的真实 DOM 操作。
globalThis.document = { createElement: () => ({ innerHTML: '', content: null }) };
// vueuse useStorage 在 window 存在时引用全局 Storage/CustomEvent 并向 window 挂事件监听：
// Node 无这些全局，提供最小 stub（本存储为内存对象，非 Storage 实例，走自定义事件路径）。
globalThis.Storage = class Storage {};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, options) {
    this.type = type;
    this.detail = options?.detail;
  }
};
globalThis.window = {
  localStorage: globalThis.localStorage,
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: id => globalThis.clearInterval(id),
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
  prompt: () => null,
};

const vue = require(path.join(WEB_MODULES, 'vue'));
const piniaLib = require(path.join(WEB_MODULES, 'pinia'));
const vueuse = require(path.join(WEB_MODULES, '@vueuse/core'));
const sfcCompiler = require(path.join(WEB_MODULES, 'vue', 'compiler-sfc'));
const typescript = require(path.join(WEB_MODULES, 'typescript'));
void vueuse; // 仅确保 @vueuse/core 在 window 就位后完成加载（isClient / useStorage 依赖）

// ---- 可控 api mock：所有请求走内存 mock，'/api/bag/seeds' 行为按用例注入 ----
const apiCalls = [];
let apiState = null;

function resetApiState({ accounts = [], settings = null } = {}) {
  apiCalls.length = 0;
  apiState = {
    accounts,
    settings,
    bagSeedsResponder: null,
    settingsResponder: null,
    postBodies: [],
  };
}

const apiDispatch = {
  async get(url, config) {
    apiCalls.push({ method: 'get', url, headers: config?.headers || {} });
    if (url === '/api/bag/seeds') {
      const respond = apiState.bagSeedsResponder || (() => ({ ok: true, data: [] }));
      return { data: await respond(config) };
    }
    if (url === '/api/accounts')
      return { data: { ok: true, data: { accounts: apiState.accounts.map(account => ({ ...account })) } } };
    if (url === '/api/settings') {
      const respond = apiState.settingsResponder || (() => ({ ok: true, data: apiState.settings || {} }));
      return { data: await respond(config) };
    }
    if (url === '/api/seeds')
      return { data: { ok: true, data: [] } };
    if (url === '/api/user/device-protocol') {
      return {
        data: {
          ok: true,
          config: { enabled: false, userAgent: '', deviceBrand: '', deviceModel: '', deviceMac: '', deviceId: '', imei: '' },
        },
      };
    }
    return { data: { ok: true, data: null } };
  },
  async post(url, body) {
    apiCalls.push({ method: 'post', url });
    apiState.postBodies.push({ url, body });
    return { data: { ok: true } };
  },
  async put(url, _body) {
    apiCalls.push({ method: 'put', url });
    return { data: { ok: true } };
  },
  async delete(url) {
    apiCalls.push({ method: 'delete', url });
    return { data: { ok: true } };
  },
};
const apiModule = { __esModule: true, default: apiDispatch };
const bagSeedsCalls = () => apiCalls.filter(call => call.url === '/api/bag/seeds');
const settingsCalls = () => apiCalls.filter(call => call.url === '/api/settings');
const accountStatusCalls = () => apiCalls.filter(call => call.url === '/api/accounts');

// ---- 内存模块加载器：编译真实 composable / stores / Settings.vue ----
const vueRouterStub = { useRoute: () => ({ query: {} }), useRouter: () => ({ push() {} }) };
const stubComponentModule = spec => ({
  __esModule: true,
  default: { name: path.basename(spec, '.vue'), render: () => null },
});

const moduleCache = new Map();

function toCjs(code) {
  return typescript.transpileModule(code, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ESNext,
    },
  }).outputText;
}

function buildModule(absPath) {
  let code;
  if (absPath.endsWith('.vue')) {
    const source = fs.readFileSync(absPath, 'utf8');
    const { descriptor, errors } = sfcCompiler.parse(source, { filename: absPath });
    assert.deepEqual(errors.map(String), [], `SFC 解析失败: ${absPath}`);
    const script = sfcCompiler.compileScript(descriptor, { id: path.basename(absPath), inlineTemplate: true });
    assert.deepEqual((script.errors || []).map(String), [], `SFC 编译失败: ${absPath}`);
    code = toCjs(script.content);
  }
  else {
    code = toCjs(fs.readFileSync(absPath, 'utf8'));
  }
  const mod = { exports: {} };
  mod.exports.__esModule = true;
  const requireFromModule = spec => resolveSpec(spec, absPath);
  vm.compileFunction(code, ['require', 'module', 'exports'])(requireFromModule, mod, mod.exports);
  return mod.exports;
}

function loadWebModule(target) {
  const candidates = [target, `${target}.ts`, `${target}.vue`, path.join(target, 'index.ts')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      if (moduleCache.has(candidate))
        return moduleCache.get(candidate);
      const mod = buildModule(candidate);
      moduleCache.set(candidate, mod);
      return mod;
    }
  }
  throw new Error(`测试加载器无法解析模块: ${target}`);
}

function resolveSpec(spec, fromAbsPath) {
  if (spec === 'vue')
    return vue;
  if (spec === 'pinia')
    return piniaLib;
  if (spec === '@vueuse/core')
    return vueuse;
  if (spec === 'vue-router')
    return vueRouterStub;
  if (spec === '@/api')
    return apiModule;
  if (spec.startsWith('@/components/'))
    return stubComponentModule(spec);
  if (spec.startsWith('@/'))
    return loadWebModule(path.join(WEB_SRC, spec.slice(2)));
  if (spec.startsWith('.'))
    return loadWebModule(path.resolve(path.dirname(fromAbsPath), spec));
  throw new Error(`测试加载器无法解析依赖: ${spec}`);
}

const strategySettingsModule = loadWebModule(path.join(WEB_SRC, 'composables/settings/useStrategySettings.ts'));
const useStrategySettingsFn = strategySettingsModule.useStrategySettings;
// 渲染真实 Settings.vue 时记录 composable 返回的控制句柄（inline 模板编译不暴露 setupState），
// 用于断言真实接线下的种子数据 / loading / 错误状态；composable 级测试直接用原函数，不经包装。
const mountedStrategyControls = [];
strategySettingsModule.useStrategySettings = (options) => {
  const controls = useStrategySettingsFn(options);
  mountedStrategyControls.push(controls);
  return controls;
};
const SettingsView = loadWebModule(path.join(WEB_SRC, 'views/Settings.vue')).default;
// 真实账号 store：切换选择走与生产一致的 selectAccount / currentAccountId 写入路径。
const useAccountStoreFn = loadWebModule(path.join(WEB_SRC, 'stores/account.ts')).useAccountStore;

// ---- 假 interval 时钟：deadline 按全局累计时间整除触发；步进间让微任务清空，
// 使在途请求在下一个 deadline 前完成（与 loading 守卫的真实语义一致） ----
function installFakeIntervalClock() {
  const timers = new Map();
  let nextTimerId = 1;
  let elapsedMs = 0;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (fn, ms) => {
    const id = nextTimerId++;
    timers.set(id, { fn, interval: Number(ms) || 0 });
    return id;
  };
  globalThis.clearInterval = (id) => { timers.delete(id); };
  return {
    activeTimerCount: () => timers.size,
    async advance(totalMs) {
      for (let t = elapsedMs + 100; t <= elapsedMs + totalMs; t += 100) {
        for (const timer of [...timers.values()]) {
          if (timer.interval > 0 && t % timer.interval === 0)
            timer.fn();
        }
        await Promise.resolve();
      }
      elapsedMs += totalMs;
    },
    restore() {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    },
  };
}

function deferred() {
  let resolveFn;
  let rejectFn;
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await vue.nextTick();
    await new Promise(resolve => setImmediate(resolve));
  }
}

// ---- composable 级测试装载：真实 Vue 响应式 + effectScope 生命周期 ----
function createStrategyHarness({ running = false, accountId = null } = {}) {
  piniaLib.setActivePinia(piniaLib.createPinia());
  const currentAccountId = vue.ref(accountId);
  const currentAccountRunning = vue.ref(running);
  const scope = vue.effectScope();
  const controls = {};
  scope.run(() => {
    Object.assign(controls, useStrategySettingsFn({
      currentAccountId,
      currentAccountRunning,
      getAutomationSettings: () => ({ automation: {} }),
      showAlert: () => {},
    }));
  });
  return { scope, currentAccountId, currentAccountRunning, controls };
}

async function withStrategyTest(options, run) {
  globalThis.localStorage.clear();
  resetApiState();
  const clock = installFakeIntervalClock();
  const harness = createStrategyHarness(options);
  try {
    await run(harness, clock);
  }
  finally {
    harness.scope.stop();
    clock.restore();
  }
}

async function enableBagPriority(harness) {
  harness.controls.localStrategySettings.value.plantingStrategy = 'bag_priority';
  await settle();
}

test('composable：账号未运行、无选择或非 bag_priority 时，四个连续 15 秒截止全部零读取', async () => {
  const scenarios = [
    { running: false, accountId: '1', strategy: 'bag_priority', label: '账号未运行' },
    { running: true, accountId: null, strategy: 'bag_priority', label: '无选择' },
    { running: true, accountId: '1', strategy: 'max_exp', label: '非 bag_priority 策略' },
  ];
  for (const scenario of scenarios) {
    await withStrategyTest({ running: scenario.running, accountId: scenario.accountId }, async (harness, clock) => {
      harness.controls.localStrategySettings.value.plantingStrategy = scenario.strategy;
      await settle();
      await clock.advance(60_000);
      assert.equal(bagSeedsCalls().length, 0, `${scenario.label}: 不应有任何种子读取`);
      assert.equal(harness.controls.bagSeedsLoading.value, false);
      assert.equal(harness.controls.bagSeedsError.value, null);
      assert.deepEqual(harness.controls.bagSeeds.value, []);
    });
  }
});

test('composable：恢复运行立即读取恰好一次，此后每个 15 秒截止最多读取一次', async () => {
  await withStrategyTest({ running: false, accountId: '1' }, async (harness, clock) => {
    await enableBagPriority(harness);
    assert.equal(bagSeedsCalls().length, 0, '未运行时不读取');

    harness.currentAccountRunning.value = true;
    await settle();
    assert.equal(bagSeedsCalls().length, 1, '恢复运行后立即读取恰好一次');
    assert.equal(harness.controls.bagSeedsLoading.value, false);
    // 请求完成后不重新打开页面：连续正常周期每个截止最多一次。
    await clock.advance(45_000);
    assert.equal(bagSeedsCalls().length, 4, '三个周期各读取一次（1 + 3）');
  });
});

test('composable：一次有效读取挂起跨越三个周期仍只读取一次，成功不触发额外立即读取', async () => {
  await withStrategyTest({ running: true, accountId: '1' }, async (harness, clock) => {
    const pending = deferred();
    apiState.bagSeedsResponder = () => pending.promise;
    await enableBagPriority(harness);
    assert.equal(bagSeedsCalls().length, 1);
    assert.equal(harness.controls.bagSeedsLoading.value, true);

    await clock.advance(60_000);
    assert.equal(bagSeedsCalls().length, 1, '在途挂起时后续截止不重复发起');

    pending.resolve({ ok: true, data: [{ seedId: 11, name: 'S11', count: 1, requiredLevel: 1, plantSize: 1 }] });
    await settle();
    assert.equal(bagSeedsCalls().length, 1, '成功回包不得触发额外立即读取');
    assert.equal(harness.controls.bagSeedsLoading.value, false);
    assert.equal(harness.controls.bagSeeds.value.length, 1);
  });
});

test('composable：失败回包不触发自动重试循环，仅按下一周期正常重读', async () => {
  await withStrategyTest({ running: true, accountId: '1' }, async (harness, clock) => {
    const pending = deferred();
    apiState.bagSeedsResponder = () => pending.promise;
    await enableBagPriority(harness);
    assert.equal(bagSeedsCalls().length, 1);

    pending.reject(new Error('network down'));
    await settle();
    assert.equal(bagSeedsCalls().length, 1, '失败不得触发自动重试');
    assert.equal(harness.controls.bagSeedsError.value, 'network down');
    assert.equal(harness.controls.bagSeedsLoading.value, false);

    apiState.bagSeedsResponder = null;
    await clock.advance(15_000);
    assert.equal(bagSeedsCalls().length, 2, '下一周期正常重读一次');
    assert.equal(harness.controls.bagSeedsError.value, null, '新请求清除旧错误');
  });
});

test('composable：在线转离线停止读取，迟到成功/失败不改草稿与请求状态，重新上线获取新结果', async () => {
  await withStrategyTest({ running: true, accountId: '1' }, async (harness, clock) => {
    apiState.bagSeedsResponder = () => ({ ok: true, data: [{ seedId: 11, name: 'S11', count: 5, requiredLevel: 1, plantSize: 1 }] });
    await enableBagPriority(harness);
    await settle();
    assert.equal(bagSeedsCalls().length, 1);
    assert.deepEqual(harness.controls.localStrategySettings.value.bagSeedKnownIds, [11]);

    // 在线期间离线编辑草稿：移除 11、手工调整优先序。
    harness.controls.localStrategySettings.value.bagSeedPriority = [11];
    harness.controls.removeBagSeedPriority(11);
    assert.deepEqual(harness.controls.localStrategySettings.value.bagSeedPriority, []);

    // 第二次读取挂起时转离线。
    const pending = deferred();
    apiState.bagSeedsResponder = () => pending.promise;
    await clock.advance(15_000);
    assert.equal(bagSeedsCalls().length, 2);
    assert.equal(harness.controls.bagSeedsLoading.value, true);

    harness.currentAccountRunning.value = false;
    await settle();
    assert.equal(harness.controls.bagSeedsLoading.value, false, '离线失效应清 loading');

    // 迟到成功不得改变离线期间的草稿、优先序、已知集合与请求状态。
    pending.resolve({ ok: true, data: [{ seedId: 22, name: 'S22', count: 9, requiredLevel: 2, plantSize: 2 }] });
    await settle();
    assert.deepEqual(harness.controls.bagSeeds.value.map(seed => seed.seedId), [11], '迟到成功不得覆盖已有种子数据');
    assert.deepEqual(harness.controls.localStrategySettings.value.bagSeedPriority, [], '迟到成功不得回填离线编辑的优先序');
    assert.deepEqual(harness.controls.localStrategySettings.value.bagSeedKnownIds, [11], '迟到成功不得改已知种子集合');
    assert.equal(harness.controls.bagSeedsError.value, null);
    assert.equal(harness.controls.bagSeedsLoading.value, false);

    await clock.advance(60_000);
    assert.equal(bagSeedsCalls().length, 2, '离线期间零新读取');

    // 迟到失败同样不得写入错误。
    const lateFailure = deferred();
    apiState.bagSeedsResponder = () => lateFailure.promise;
    harness.currentAccountRunning.value = true;
    await settle();
    assert.equal(bagSeedsCalls().length, 3, '重新上线立即读取一次');
    harness.currentAccountRunning.value = false;
    await settle();
    lateFailure.reject(new Error('late failure'));
    await settle();
    assert.equal(harness.controls.bagSeedsError.value, null, '迟到失败不得写入离线期间错误状态');

    // 再次上线可正常获取新结果。
    apiState.bagSeedsResponder = () => ({ ok: true, data: [{ seedId: 33, name: 'S33', count: 1, requiredLevel: 1, plantSize: 1 }] });
    harness.currentAccountRunning.value = true;
    await settle();
    assert.equal(bagSeedsCalls().length, 4);
    assert.deepEqual(harness.controls.bagSeeds.value.map(seed => seed.seedId), [33]);
  });
});

test('composable：离线仍可编辑并保存策略，不触发读取、不清持久优先序、不新增运行状态请求', async () => {
  await withStrategyTest({ running: false, accountId: '1' }, async (harness) => {
    await enableBagPriority(harness);
    // 离线编辑：调整优先序并新增一个列表外种子 ID。
    harness.controls.localStrategySettings.value.bagSeedPriority = [22, 11];
    harness.controls.addBagSeedToPriority(33);
    assert.deepEqual(harness.controls.localStrategySettings.value.bagSeedPriority, [22, 11, 33]);

    await harness.controls.saveStrategySettings();
    await settle();
    assert.equal(bagSeedsCalls().length, 0, '离线保存不得触发种子读取');
    assert.equal(accountStatusCalls().length, 0, '不得新增账号运行状态请求');

    const saved = apiState.postBodies.find(entry => entry.url === '/api/settings/save');
    assert.ok(saved, '应保存策略设置');
    assert.deepEqual(saved.body.bagSeedPriority, [22, 11, 33], '保存载荷保留离线编辑的优先序');
    assert.deepEqual(harness.controls.localStrategySettings.value.bagSeedPriority, [22, 11, 33], '保存后本地优先序不被清空');
  });
});

test('composable：账号切换后旧代次成功/失败/finally 均不覆盖新代次；字符串与数字选择统一标识', async () => {
  await withStrategyTest({ running: true, accountId: '1' }, async (harness, clock) => {
    const first = deferred();
    apiState.bagSeedsResponder = () => first.promise;
    await enableBagPriority(harness);
    assert.equal(bagSeedsCalls().length, 1);

    // 切换到账号 2（Settings 的 watch 会调用 resetStrategyState 后重新装载）。
    const second = deferred();
    apiState.bagSeedsResponder = () => second.promise;
    harness.currentAccountId.value = '2';
    harness.controls.resetStrategyState();
    await settle();
    assert.equal(bagSeedsCalls().length, 2, '重置后条件仍满足应立即重新读取');
    assert.equal(harness.controls.bagSeedsLoading.value, true, '新代次在途时 loading 为真');

    // 旧代次迟到成功：不回填数据、不清新代次 loading。
    first.resolve({ ok: true, data: [{ seedId: 11, name: 'S11', count: 1, requiredLevel: 1, plantSize: 1 }] });
    await settle();
    assert.deepEqual(harness.controls.bagSeeds.value.map(seed => seed.seedId), [], '旧代次成功不得回填');
    assert.equal(harness.controls.bagSeedsLoading.value, true, '旧代次 finally 不得清除新代次 loading');

    // 切换到账号 3：旧代次（账号 2）迟到失败不得写入错误。
    const third = deferred();
    apiState.bagSeedsResponder = () => third.promise;
    harness.currentAccountId.value = '3';
    harness.controls.resetStrategyState();
    await settle();
    assert.equal(bagSeedsCalls().length, 3);
    second.reject(new Error('old failure'));
    await settle();
    assert.equal(harness.controls.bagSeedsError.value, null, '旧代次失败不得写入新代次错误');
    assert.equal(harness.controls.bagSeedsLoading.value, true);

    third.resolve({ ok: true, data: [{ seedId: 44, name: 'S44', count: 2, requiredLevel: 1, plantSize: 1 }] });
    await settle();
    assert.deepEqual(harness.controls.bagSeeds.value.map(seed => seed.seedId), [44], '新代次数据生效');
    assert.equal(harness.controls.bagSeedsLoading.value, false);

    // 字符串与数字形式的同一选择按统一标识处理：不触发新请求，在途请求仍被接受。
    const fourth = deferred();
    apiState.bagSeedsResponder = () => fourth.promise;
    await clock.advance(15_000);
    assert.equal(bagSeedsCalls().length, 4, '周期触发第四次读取（在途）');
    harness.currentAccountId.value = 3; // 数字形式的同一选择
    await settle();
    assert.equal(bagSeedsCalls().length, 4, '同一选择的类型变化不得触发重新读取');
    fourth.resolve({ ok: true, data: [{ seedId: 55, name: 'S55', count: 1, requiredLevel: 1, plantSize: 1 }] });
    await settle();
    assert.deepEqual(harness.controls.bagSeeds.value.map(seed => seed.seedId), [55], '同一选择的在途请求仍被接受');
  });
});

test('composable：同一选择挂起时主动重置形成新代次，旧迟到成功不回填、finally 不清新代次 loading', async () => {
  await withStrategyTest({ running: true, accountId: '1' }, async (harness) => {
    const first = deferred();
    apiState.bagSeedsResponder = () => first.promise;
    await enableBagPriority(harness);
    assert.equal(bagSeedsCalls().length, 1);
    assert.equal(harness.controls.bagSeedsLoading.value, true);

    // 选择不变（应用默认方案等显式重置）：无条件放弃在途请求并立即读取一次新代次。
    harness.controls.localStrategySettings.value.bagSeedPriority = [11];
    harness.controls.localStrategySettings.value.bagSeedKnownIds = [11];
    const second = deferred();
    apiState.bagSeedsResponder = () => second.promise;
    harness.controls.resetStrategyState();
    await settle();
    assert.equal(bagSeedsCalls().length, 2, '重置放弃旧在途请求后立即读取一次新代次');
    assert.equal(harness.controls.bagSeedsLoading.value, true, '新代次在途 loading 为真');
    assert.deepEqual(harness.controls.bagSeeds.value.map(seed => seed.seedId), [], '重置清空旧展示数据');

    // 旧代次迟到成功：不得回填种子/优先序/已知集合，不得清新代次 loading。
    first.resolve({ ok: true, data: [{ seedId: 77, name: 'S77', count: 1, requiredLevel: 1, plantSize: 1 }] });
    await settle();
    assert.deepEqual(harness.controls.bagSeeds.value.map(seed => seed.seedId), [], '旧代次成功不得回填重置后的新草稿');
    assert.deepEqual(harness.controls.localStrategySettings.value.bagSeedPriority, [11], '旧代次成功不得改优先序');
    assert.deepEqual(harness.controls.localStrategySettings.value.bagSeedKnownIds, [11], '旧代次成功不得改已知集合');
    assert.equal(harness.controls.bagSeedsLoading.value, true, '旧代次 finally 不得清除新代次 loading');
    assert.equal(harness.controls.bagSeedsError.value, null);

    // 新代次正常生效。
    second.resolve({ ok: true, data: [{ seedId: 88, name: 'S88', count: 1, requiredLevel: 1, plantSize: 1 }] });
    await settle();
    assert.deepEqual(harness.controls.bagSeeds.value.map(seed => seed.seedId), [88], '新代次数据生效');
    assert.equal(harness.controls.bagSeedsLoading.value, false);
  });
});

test('composable：同一选择挂起时主动重置后旧迟到失败不写入错误；无在途时重置立即读取一次', async () => {
  await withStrategyTest({ running: true, accountId: '1' }, async (harness) => {
    const first = deferred();
    apiState.bagSeedsResponder = () => first.promise;
    await enableBagPriority(harness);
    assert.equal(bagSeedsCalls().length, 1);

    const second = deferred();
    apiState.bagSeedsResponder = () => second.promise;
    harness.controls.resetStrategyState();
    await settle();
    assert.equal(bagSeedsCalls().length, 2, '重置立即读取一次新代次');
    assert.equal(harness.controls.bagSeedsLoading.value, true);

    first.reject(new Error('old failure'));
    await settle();
    assert.equal(harness.controls.bagSeedsError.value, null, '旧代次失败不得写入新草稿错误');
    assert.equal(harness.controls.bagSeedsLoading.value, true, '旧代次失败 finally 不得清除新代次 loading');

    second.resolve({ ok: true, data: [] });
    await settle();
    assert.equal(harness.controls.bagSeedsLoading.value, false);

    // 无在途时显式重置：条件仍满足应立即读取一次（不等下一个 15 秒周期）。
    apiState.bagSeedsResponder = null;
    harness.controls.resetStrategyState();
    await settle();
    assert.equal(bagSeedsCalls().length, 3, '无在途时重置立即读取一次');
  });
});

test('composable：退出 bag_priority 失效在途请求，返回该策略重新读取一次；不满足条件的重置不读取', async () => {
  await withStrategyTest({ running: true, accountId: '1' }, async (harness, clock) => {
    const pending = deferred();
    apiState.bagSeedsResponder = () => pending.promise;
    await enableBagPriority(harness);
    assert.equal(bagSeedsCalls().length, 1);

    harness.controls.localStrategySettings.value.plantingStrategy = 'max_exp';
    await settle();
    await clock.advance(30_000);
    assert.equal(bagSeedsCalls().length, 1, '退出 bag_priority 后零新读取');
    pending.resolve({ ok: true, data: [{ seedId: 11, name: 'S11', count: 1, requiredLevel: 1, plantSize: 1 }] });
    await settle();
    assert.deepEqual(harness.controls.bagSeeds.value.map(seed => seed.seedId), [], '退出后旧请求结果不回填');
    assert.equal(harness.controls.bagSeedsLoading.value, false);

    // 不满足条件（未运行）时显式重置：清状态且不读取。
    harness.currentAccountRunning.value = false;
    await settle();
    harness.controls.resetStrategyState();
    await settle();
    assert.equal(bagSeedsCalls().length, 1, '不满足条件的重置不得读取');

    // 返回 bag_priority 且运行：重新读取一次。
    apiState.bagSeedsResponder = null;
    harness.controls.localStrategySettings.value.plantingStrategy = 'bag_priority';
    await settle();
    assert.equal(bagSeedsCalls().length, 1, '仍未运行，返回策略也不读取');
    harness.currentAccountRunning.value = true;
    await settle();
    assert.equal(bagSeedsCalls().length, 2, '条件重新满足立即读取一次');
  });
});

test('composable：卸载清除定时器并失效在途请求，卸载后推进截止与完成旧 Promise 状态不再变化', async () => {
  await withStrategyTest({ running: true, accountId: '1' }, async (harness, clock) => {
    const pending = deferred();
    apiState.bagSeedsResponder = () => pending.promise;
    await enableBagPriority(harness);
    assert.equal(bagSeedsCalls().length, 1);
    assert.ok(clock.activeTimerCount() >= 1, '运行期间应注册周期定时器');

    harness.scope.stop();
    assert.equal(clock.activeTimerCount(), 0, '卸载后周期定时器应全部清除');

    await clock.advance(60_000);
    assert.equal(bagSeedsCalls().length, 1, '卸载后推进多个截止零读取');

    pending.resolve({ ok: true, data: [{ seedId: 11, name: 'S11', count: 1, requiredLevel: 1, plantSize: 1 }] });
    await settle();
    assert.deepEqual(harness.controls.bagSeeds.value.map(seed => seed.seedId), [], '卸载后旧请求结果不回填');
    assert.equal(harness.controls.bagSeedsLoading.value, false);
    assert.equal(harness.controls.bagSeedsError.value, null);
  });
});

test('composable：识别语义回归——迁移追加含四格种子、列表外展示、移除/加回/移动保留原语义', async () => {
  await withStrategyTest({ running: true, accountId: '1' }, async (harness) => {
    apiState.bagSeedsResponder = () => ({
      ok: true,
      data: [
        { seedId: 11, name: '单格种子', count: 3, requiredLevel: 1, plantSize: 1 },
        { seedId: 22, name: '四格种子', count: 2, requiredLevel: 1, plantSize: 2 },
      ],
    });
    await enableBagPriority(harness);
    await settle();
    // 迁移：空已知集合时把全部背包种子（含四格）追加进优先列表。
    assert.deepEqual(harness.controls.localStrategySettings.value.bagSeedPriority, [11, 22]);
    assert.deepEqual(harness.controls.localStrategySettings.value.bagSeedKnownIds, [11, 22]);
    assert.equal(harness.controls.unplannedBagSeeds.value.length, 0);

    // 移除后出现在「未加入优先列表」组：四格种子不被过滤。
    harness.controls.removeBagSeedPriority(22);
    assert.deepEqual(harness.controls.localStrategySettings.value.bagSeedPriority, [11]);
    assert.deepEqual(harness.controls.unplannedBagSeeds.value.map(seed => seed.seedId), [22]);

    // 加回与移动保留原排序语义。
    harness.controls.addBagSeedToPriority(22);
    assert.deepEqual(harness.controls.localStrategySettings.value.bagSeedPriority, [11, 22]);
    harness.controls.moveBagSeed(22, -1);
    assert.deepEqual(harness.controls.localStrategySettings.value.bagSeedPriority, [22, 11]);
    harness.controls.resetBagSeedPriority();
    assert.deepEqual(harness.controls.localStrategySettings.value.bagSeedPriority, [11, 22]);
  });
});

// ---- Settings.vue 真实接线（渲染真实组件脚本，子组件/router/api 隔离） ----
function makeNode(tag) {
  return { tag, children: [], props: {}, text: '', parent: null, querySelector: () => null };
}

const nodeOps = {
  createElement: tag => makeNode(tag),
  createText: (text) => {
    const node = makeNode('TEXT');
    node.text = String(text ?? '');
    return node;
  },
  createComment: () => makeNode('COMMENT'),
  setText: (node, text) => { node.text = String(text); },
  setElementText: (el, text) => { el.text = String(text); el.children.length = 0; },
  parentNode: node => node.parent,
  nextSibling: (node) => {
    if (!node.parent)
      return null;
    const siblings = node.parent.children;
    const index = siblings.indexOf(node);
    return index >= 0 && index + 1 < siblings.length ? siblings[index + 1] : null;
  },
  insert: (child, parent, anchor) => {
    if (child.parent && child.parent !== parent) {
      const index = child.parent.children.indexOf(child);
      if (index !== -1)
        child.parent.children.splice(index, 1);
    }
    child.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index === -1)
      parent.children.push(child);
    else
      parent.children.splice(index, 0, child);
  },
  remove: (child) => {
    if (child.parent) {
      const index = child.parent.children.indexOf(child);
      if (index !== -1)
        child.parent.children.splice(index, 1);
      child.parent = null;
    }
  },
};

const { render } = vue.createRenderer({
  ...nodeOps,
  patchProp: (el, key, prev, next) => { el.props[key] = next; },
});

const bagPrioritySettings = {
  plantingStrategy: 'bag_priority',
  preferredSeedId: 0,
  prioritize2x2Crops: false,
  bagSeedPriority: [11],
  bagSeedKnownIds: [11],
  bagSeedFallbackStrategy: 'level',
  intervals: {},
  friendQuietHours: {},
  automation: {},
};

test('真实 Settings 接线：账号未运行时挂载后零种子读取，四个 15 秒截止仍为零', async () => {
  globalThis.localStorage.clear();
  resetApiState({
    accounts: [{ id: '1', name: 'A', running: false }],
    settings: bagPrioritySettings,
  });
  const clock = installFakeIntervalClock();
  piniaLib.setActivePinia(piniaLib.createPinia());
  const root = makeNode('root');
  render(vue.h(SettingsView), root);
  try {
    await settle(6);
    assert.equal(bagSeedsCalls().length, 0, '未运行账号挂载后不得首取');
    await clock.advance(60_000);
    assert.equal(bagSeedsCalls().length, 0, '未运行账号多个截止零轮询');
  }
  finally {
    render(null, root);
    clock.restore();
  }
});

test('真实 Settings 接线：运行账号挂载立即读取恰好一次；账号列表每 3 秒整体替换只按 15 秒周期读取', async () => {
  globalThis.localStorage.clear();
  resetApiState({
    accounts: [{ id: '1', name: 'A', running: true }],
    settings: bagPrioritySettings,
  });
  const clock = installFakeIntervalClock();
  piniaLib.setActivePinia(piniaLib.createPinia());
  const root = makeNode('root');
  render(vue.h(SettingsView), root);
  try {
    await settle(6);
    assert.equal(bagSeedsCalls().length, 1, '运行账号 + bag_priority 挂载后立即读取恰好一次');

    // 模拟既有账号列表每 3 秒整体替换对象（选择与 running 不变）：
    // 30 秒内种子读取只发生在 15s/30s 两个周期截止，对象替换本身不触发首取。
    for (let i = 0; i < 10; i++) {
      apiState.accounts = [{ id: '1', name: `A${i}`, running: true }];
      await clock.advance(3000);
    }
    assert.equal(bagSeedsCalls().length, 3, '列表对象替换不得额外触发种子读取');

    // 其他账号的运行态变化不得触发当前账号种子首取。
    const before = bagSeedsCalls().length;
    apiState.accounts = [{ id: '1', name: 'A', running: true }, { id: '2', name: 'B', running: true }];
    await clock.advance(3000);
    assert.equal(bagSeedsCalls().length, before, '其他账号运行态变化不触发当前种子首取');
  }
  finally {
    render(null, root);
    clock.restore();
  }
});

test('真实 Settings 接线：在线转离线停止读取，重新上线立即恢复；卸载后零读取', async () => {
  globalThis.localStorage.clear();
  resetApiState({
    accounts: [{ id: '1', name: 'A', running: true }],
    settings: bagPrioritySettings,
  });
  const clock = installFakeIntervalClock();
  piniaLib.setActivePinia(piniaLib.createPinia());
  const root = makeNode('root');
  render(vue.h(SettingsView), root);
  try {
    await settle(6);
    assert.equal(bagSeedsCalls().length, 1);

    // 在线转离线：3 秒账号刷新带回 running=false。
    apiState.accounts = [{ id: '1', name: 'A', running: false }];
    await clock.advance(3000);
    await clock.advance(60_000);
    assert.equal(bagSeedsCalls().length, 1, '离线后四个截止零读取');

    // 重新上线：3 秒账号刷新带回 running=true，立即读取一次。
    apiState.accounts = [{ id: '1', name: 'A', running: true }];
    await clock.advance(3000);
    assert.equal(bagSeedsCalls().length, 2, '重新上线立即读取一次');

    // 卸载：不再有任何种子读取。
    render(null, root);
    await settle();
    await clock.advance(60_000);
    assert.equal(bagSeedsCalls().length, 2, '卸载后零读取');
  }
  finally {
    render(null, root);
    clock.restore();
  }
});

test('真实 Settings 接线：账号运行态字段缺失时，四个 15 秒截止全部零读取', async () => {
  globalThis.localStorage.clear();
  mountedStrategyControls.length = 0;
  // 账号对象没有 running 字段：严格运行态派生必须视为未运行（undefined !== true）。
  resetApiState({
    accounts: [{ id: '1', name: 'A' }],
    settings: bagPrioritySettings,
  });
  const clock = installFakeIntervalClock();
  piniaLib.setActivePinia(piniaLib.createPinia());
  const root = makeNode('root');
  render(vue.h(SettingsView), root);
  try {
    await settle(6);
    assert.equal(bagSeedsCalls().length, 0, '运行态字段缺失的账号挂载后不得首取');
    await clock.advance(60_000);
    assert.equal(bagSeedsCalls().length, 0, '运行态字段缺失时四个截止零读取');
    assert.equal(mountedStrategyControls[0].bagSeedsLoading.value, false);
    assert.equal(mountedStrategyControls[0].bagSeedsError.value, null);
  }
  finally {
    render(null, root);
    clock.restore();
  }
});

test('真实 Settings 切换：离线 bag_priority 选择切到运行选择立即恰好一次读取；挂起跨三周期不增加；迟到结果不覆盖', async () => {
  globalThis.localStorage.clear();
  mountedStrategyControls.length = 0;
  resetApiState({
    accounts: [
      { id: '1', name: 'A', running: false },
      { id: '2', name: 'B', running: true },
      { id: '3', name: 'C', running: true },
    ],
    settings: bagPrioritySettings,
  });
  const clock = installFakeIntervalClock();
  piniaLib.setActivePinia(piniaLib.createPinia());
  const accountStore = useAccountStoreFn();
  const controls = () => mountedStrategyControls[0];
  const root = makeNode('root');
  render(vue.h(SettingsView), root);
  try {
    await settle(6);
    assert.equal(bagSeedsCalls().length, 0, '离线 bag_priority 选择挂载零读取');

    // 目标账号配置读取与种子响应都保持挂起：切换后立即恰好一次种子读取
    // （readiness watcher 与 Settings 重置同拍触发，也不得双读）。
    const configPending = deferred();
    apiState.settingsResponder = () => configPending.promise;
    const seedForTwo = deferred();
    apiState.bagSeedsResponder = () => seedForTwo.promise;
    accountStore.selectAccount('2');
    await settle(4);
    assert.equal(bagSeedsCalls().length, 1, '切换到运行选择立即恰好一次读取');
    assert.equal(controls().bagSeedsLoading.value, true);

    // 在途挂起跨三个周期不重复发起。
    await clock.advance(60_000);
    assert.equal(bagSeedsCalls().length, 1, '挂起期间后续截止不重复发起');

    // 切换到另一运行选择：旧代次（账号 2）迟到结果不得覆盖新代次。
    const seedForThree = deferred();
    apiState.bagSeedsResponder = () => seedForThree.promise;
    accountStore.selectAccount('3');
    await settle(4);
    assert.equal(bagSeedsCalls().length, 2, '切到另一运行选择立即恰好一次新读取');
    assert.equal(controls().bagSeedsLoading.value, true);

    seedForTwo.resolve({ ok: true, data: [{ seedId: 22, name: 'S22', count: 1, requiredLevel: 1, plantSize: 1 }] });
    await settle();
    assert.deepEqual(controls().bagSeeds.value, [], '旧代次成功不得回填');
    assert.equal(controls().bagSeedsLoading.value, true, '旧代次 finally 不得清除新代次 loading');

    // 目标配置迟到返回：策略仍是 bag_priority，账号 3 的在途请求继续有效。
    configPending.resolve({ ok: true, data: bagPrioritySettings });
    await settle(4);
    assert.equal(bagSeedsCalls().length, 2, '配置返回不得触发额外读取');

    seedForThree.resolve({ ok: true, data: [{ seedId: 33, name: 'S33', count: 1, requiredLevel: 1, plantSize: 1 }] });
    await settle();
    assert.deepEqual(controls().bagSeeds.value.map(seed => seed.seedId), [33], '新代次数据生效');
    assert.equal(controls().bagSeedsLoading.value, false);
  }
  finally {
    render(null, root);
    clock.restore();
  }
});

test('真实 Settings 接线：同一选择的字符串/数字互换不触发重置或额外读取，在途请求仍被接受', async () => {
  globalThis.localStorage.clear();
  mountedStrategyControls.length = 0;
  resetApiState({
    accounts: [{ id: '3', name: 'C', running: true }],
    settings: bagPrioritySettings,
  });
  const clock = installFakeIntervalClock();
  piniaLib.setActivePinia(piniaLib.createPinia());
  const accountStore = useAccountStoreFn();
  const controls = () => mountedStrategyControls[0];
  const root = makeNode('root');
  render(vue.h(SettingsView), root);
  try {
    await settle(6);
    assert.equal(bagSeedsCalls().length, 1, '运行账号挂载立即读取一次');

    // 周期触发第二次读取并保持挂起。
    const pending = deferred();
    apiState.bagSeedsResponder = () => pending.promise;
    await clock.advance(15_000);
    assert.equal(bagSeedsCalls().length, 2, '周期触发第二次读取（在途）');
    assert.equal(controls().bagSeedsLoading.value, true);
    const settingsReadsBefore = settingsCalls().length;

    // 同一选择写成数字形式：真实 store 写入路径，Settings 的账号 watch 按归一化标识观察。
    accountStore.currentAccountId = 3;
    await settle(4);
    assert.equal(bagSeedsCalls().length, 2, '同一选择的类型变化不得触发重新读取');
    assert.equal(settingsCalls().length, settingsReadsBefore, '类型变化不得触发配置重载（无重置）');
    assert.equal(controls().bagSeedsLoading.value, true, '在途请求不被打断');

    pending.resolve({ ok: true, data: [{ seedId: 66, name: 'S66', count: 1, requiredLevel: 1, plantSize: 1 }] });
    await settle();
    assert.deepEqual(controls().bagSeeds.value.map(seed => seed.seedId), [66], '同一选择的在途请求仍被接受');
    assert.equal(controls().bagSeedsLoading.value, false);
  }
  finally {
    render(null, root);
    clock.restore();
  }
});

test('真实 Settings 接线：切走后切回同一选择，旧代次成功/失败/finally 均不覆盖新代次', async () => {
  globalThis.localStorage.clear();
  mountedStrategyControls.length = 0;
  resetApiState({
    accounts: [
      { id: '2', name: 'B', running: true },
      { id: '1', name: 'A', running: false },
    ],
    settings: bagPrioritySettings,
  });
  const clock = installFakeIntervalClock();
  piniaLib.setActivePinia(piniaLib.createPinia());
  const accountStore = useAccountStoreFn();
  const controls = () => mountedStrategyControls[0];
  // 挂载后自动选择首个账号 2（运行中）：第一次读取挂起。
  const first = deferred();
  apiState.bagSeedsResponder = () => first.promise;
  const root = makeNode('root');
  render(vue.h(SettingsView), root);
  try {
    await settle(6);
    assert.equal(bagSeedsCalls().length, 1, '挂载后运行选择立即读取一次');
    assert.equal(controls().bagSeedsLoading.value, true);

    // 切走到离线选择：旧请求失效，离线期间零新读取。
    accountStore.selectAccount('1');
    await settle(4);
    assert.equal(bagSeedsCalls().length, 1, '切到离线选择零新读取');
    assert.equal(controls().bagSeedsLoading.value, false, '失效应清 loading');

    // 切回同一运行选择：立即恰好一次新读取（watcher 与重置不双读）。
    const second = deferred();
    apiState.bagSeedsResponder = () => second.promise;
    accountStore.selectAccount('2');
    await settle(4);
    assert.equal(bagSeedsCalls().length, 2, '切回运行选择立即恰好一次新读取');
    assert.equal(controls().bagSeedsLoading.value, true);
    assert.deepEqual(controls().bagSeeds.value, [], '切回后旧展示数据已被清空');

    // 切走前旧代次（第一次请求）迟到成功：不得回填数据、不得清新代次 loading。
    first.resolve({ ok: true, data: [{ seedId: 11, name: 'S11', count: 1, requiredLevel: 1, plantSize: 1 }] });
    await settle();
    assert.deepEqual(controls().bagSeeds.value, [], '旧代次成功不得回填');
    assert.equal(controls().bagSeedsLoading.value, true, '旧代次 finally 不得清除新代次 loading');

    // 再次切走并切回：产生第三代次，旧代次（第二次请求）迟到失败不得写入错误或清 loading。
    accountStore.selectAccount('1');
    await settle(4);
    const third = deferred();
    apiState.bagSeedsResponder = () => third.promise;
    accountStore.selectAccount('2');
    await settle(4);
    assert.equal(bagSeedsCalls().length, 3, '第二次切回立即恰好一次新读取');
    assert.equal(controls().bagSeedsLoading.value, true);

    second.reject(new Error('old failure'));
    await settle();
    assert.equal(controls().bagSeedsError.value, null, '旧代次失败不得写入新代次错误');
    assert.equal(controls().bagSeedsLoading.value, true, '旧代次失败 finally 不得清除新代次 loading');

    third.resolve({ ok: true, data: [{ seedId: 33, name: 'S33', count: 1, requiredLevel: 1, plantSize: 1 }] });
    await settle();
    assert.deepEqual(controls().bagSeeds.value.map(seed => seed.seedId), [33], '新代次数据生效');
    assert.equal(controls().bagSeedsLoading.value, false);

    // 切回离线选择后推进多个截止，零新读取。
    accountStore.selectAccount('1');
    await settle(4);
    await clock.advance(45_000);
    assert.equal(bagSeedsCalls().length, 3, '离线选择期间零新读取');
  }
  finally {
    render(null, root);
    clock.restore();
  }
});
