'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * 自助重扫前端行为回归（真实 SFC 编译 + 真实 script 执行，仅打桩网络层）：
 * - 时钟偏移无关倒计时：手机/页面墙钟与服务器相差数小时仍显示 ~5 分钟窗口，
 *   服务端 expired 终态覆盖本地正计时。
 * - 页面绝不自动发送：GET 状态/轮询不产生任何 POST；发送只能来自用户点击。
 * - 账号切换代次栅栏：旧账号迟到的 GET/错误/二维码不落到新账号头上。
 * - confirmed_retry 显式重试；403 停轮询。
 * - 登录回跳只接受站内相对路径（safe-redirect / Login / api 401 拦截器）。
 */

const root = path.resolve(__dirname, '../..');
const modules = path.join(root, 'web/node_modules');
const vue = require(path.join(modules, 'vue'));
const compiler = require(path.join(modules, 'vue/compiler-sfc'));
const ts = require(path.join(modules, 'typescript'));
const FIXTURE_PASSWORD = 'fixture-login-password';

function evaluate(source, deps, globals = {}) {
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
  const mod = { exports: {} };
  vm.compileFunction(code, ['require', 'module', 'exports', ...Object.keys(globals)])(name => {
    assert.ok(name in deps, `unexpected import ${name}`);
    return deps[name];
  }, mod, mod.exports, ...Object.values(globals));
  return mod.exports;
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
// onMounted 的异步链（加载→停 loading→启动轮询）需要 3 个 tick 才收敛。
async function settle(ticks = 5) {
  for (let i = 0; i < ticks; i++)
    await vue.nextTick();
}

// ---------- 真实 safe-redirect 模块 ----------
const safeRedirect = evaluate(
  fs.readFileSync(path.join(root, 'web/src/utils/safe-redirect.ts'), 'utf8'),
  {},
  { window: { location: { origin: 'https://panel.example.com' } } },
);

test('safe-redirect：只接受站内相对路径，开放重定向一律拒绝', () => {
  assert.equal(safeRedirect.resolveSafeRedirect('/wx-login-help?accountId=301'), '/wx-login-help?accountId=301');
  assert.equal(safeRedirect.resolveSafeRedirect('/'), '/');
  assert.equal(safeRedirect.resolveSafeRedirect('  /overview#farm  '), '/overview#farm');
  for (const bad of [
    '//evil.com', '/\\evil.com', 'https://evil.com', 'http://evil.com/x',
    'javascript:alert(1)', '/url:https://evil.com', '/a\r\nb', 'farm/relative',
    '', '   ', null, undefined, 123,
  ]) {
    assert.equal(safeRedirect.resolveSafeRedirect(bad), '', `必须拒绝: ${JSON.stringify(String(bad))}`);
  }
});

// ---------- api/index.ts 401 拦截器 ----------
function apiHarness(pathname, search) {
  let responseErrorHandler = null;
  let tokenRef = null;
  const warnings = [];
  const errors = [];
  const axiosStub = {
    __esModule: true,
    default: {
      isCancel: () => false,
      create: () => ({
        interceptors: {
          request: { use: () => {} },
          response: { use: (_ok, err) => { responseErrorHandler = err; } },
        },
      }),
    },
  };
  const windowStub = { location: { pathname, search, href: '' } };
  evaluate(fs.readFileSync(path.join(root, 'web/src/api/index.ts'), 'utf8'), {
    '@vueuse/core': { useStorage: (key) => { const r = { value: key === 'admin_token' ? 'stale-token' : '' }; if (key === 'admin_token') tokenRef = r; return r; } },
    axios: axiosStub,
    '@/stores/toast': { useToastStore: () => ({ warning: m => warnings.push(m), error: m => errors.push(m) }) },
    '@/utils/daily-feedback': { currentFeedbackTrace: () => '', recordClientFailure: () => {} },
    '@/utils/safe-redirect': safeRedirect,
  }, { window: windowStub });
  return { get errorHandler() { return responseErrorHandler; }, windowStub, get tokenRef() { return tokenRef; }, warnings, errors };
}

test('api 401 拦截器：清 token 并带站内 return URL 跳登录，不产生外跳', async () => {
  const h = apiHarness('/wx-login-help', '?accountId=301');
  assert.ok(typeof h.errorHandler === 'function');
  const rejection = h.errorHandler({ response: { status: 401, data: {} } });
  assert.ok(rejection && typeof rejection.then === 'function', '拦截器必须继续拒绝以终止调用方');
  await rejection.catch(() => {});
  assert.equal(h.tokenRef.value, '', '会话过期必须清空 token');
  assert.equal(h.windowStub.location.href,
    `/login?redirect=${encodeURIComponent('/wx-login-help?accountId=301')}`,
    '深链页面登录后必须能回到原页面');
  assert.ok(h.warnings.some(m => m.includes('登录已过期')));
});

test('api 401 拦截器：已在登录页时不改写地址', async () => {
  const h = apiHarness('/login', '');
  await h.errorHandler({ response: { status: 401, data: {} } }).catch(() => {});
  assert.equal(h.windowStub.location.href, '');
});

// ---------- Login.vue：提醒深链登录后回原页 ----------
async function loginHarness(redirectQuery) {
  const timers = [];
  const route = vue.reactive({ query: redirectQuery ? { redirect: redirectQuery } : {} });
  const windowStub = { location: { href: '', origin: 'https://panel.example.com' } };
  const userStore = {
    login: async () => ({ ok: true }),
    register: async () => ({ ok: true }),
    verifyResetPassword: async () => ({ ok: true }),
    resetPassword: async () => ({ ok: true }),
  };
  const filename = path.join(root, 'web/src/views/Login.vue');
  const { descriptor } = compiler.parse(
    fs.readFileSync(filename, 'utf8').replace('</script>', '\ndefineExpose({ handleSubmit, username, password })\n</script>'),
    { filename },
  );
  const source = compiler.compileScript(descriptor, { id: 'wx-login-test' }).content;
  const stub = { __esModule: true, default: {} };
  const Login = evaluate(source, {
    vue,
    'vue-router': { useRoute: () => route },
    '@/api': { __esModule: true, default: { get: async () => ({ data: {} }), post: async () => ({ data: {} }) } },
    '@/components/login/LoginModals.vue': stub,
    '@/components/login/PasswordStrengthMeter.vue': stub,
    '@/components/login/UpdateLogModal.vue': stub,
    '@/components/ui/BaseButton.vue': stub,
    '@/components/ui/BaseInput.vue': stub,
    '@/composables/usePasswordStrength': { getPasswordStrength: () => ({ valid: true, message: '' }) },
    '@/stores/app': { useAppStore: () => vue.reactive({ loginPageConfig: {}, fetchLoginPageConfig() {} }) },
    '@/stores/user': { useUserStore: () => userStore, formatTimeDuration: () => '' },
    '@/utils/safe-redirect': safeRedirect,
  }, { window: windowStub, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {} }).default;
  Login.render = () => null;
  const renderer = vue.createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode: () => null, nextSibling: () => null });
  let instance = null;
  const app = renderer.createApp({ render: () => vue.h(Login, { ref: value => { instance = value; } }) });
  app.mount({});
  await vue.nextTick();
  return {
    app, timers, windowStub,
    instance: () => instance,
    async submit() {
      instance.username = 'farmer';
      instance.password = FIXTURE_PASSWORD;
      const pending = instance.handleSubmit();
      await vue.nextTick();
      return pending;
    },
  };
}

test('Login：提醒深链 ?redirect=/wx-login-help… 登录成功后回到原页面', async () => {
  const h = await loginHarness('/wx-login-help?accountId=301');
  try {
    await h.submit();
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].ms, 500, '登录成功后跳转延迟 500ms');
    h.timers[0].fn();
    assert.equal(h.windowStub.location.href, '/wx-login-help?accountId=301');
  }
  finally { h.app.unmount(); }
});

test('Login：redirect 为外链/协议相对时登录后只回首页', async () => {
  for (const bad of ['//evil.com', 'https://evil.com']) {
    const h = await loginHarness(bad);
    try {
      await h.submit();
      h.timers[0].fn();
      assert.equal(h.windowStub.location.href, '/');
    }
    finally { h.app.unmount(); }
  }
});

// ---------- WxLoginHelp.vue ----------
function helpStatusFixture(accountId, overrides = {}) {
  const createdAt = 4_900_000;
  return {
    serverNow: 5_000_000,
    account: { id: accountId, name: `农场号${accountId}`, platform: 'wx' },
    incident: { needsRescan: true, lastError: '', sentAt: 1 },
    plan: null, // 旧服务端不带 plan 字段：页面必须照常工作
    pending: {
      sessionId: `sess-${accountId}`,
      createdAt,
      expiresAt: createdAt + 400_000, // serverNow=createdAt+100s → 满窗 300s
      localTtlMs: 300_000,
      state: 'pending',
      detail: '',
      qrBase64: `qr-image-${accountId}`,
    },
    ...overrides,
  };
}

function helpHarness(initialAccountId = '301', responder = null) {
  const route = vue.reactive({ query: initialAccountId ? { accountId: initialAccountId } : {} });

  const navigations = [];
  const intervals = [];
  const gets = []; // { url, params, ...deferred }
  const posts = []; // { url, body, ...deferred }
  const router = { push: to => navigations.push(to) };
  const getResponder = { fn: null };
  const apiStub = {
    get: (url, config) => {
      const pending = deferred();
      gets.push({ url, params: config?.params, ...pending });
      if (getResponder.fn) return Promise.resolve(getResponder.fn(gets.at(-1)));
      return pending.promise;
    },
    post: (url, body) => {
      const pending = deferred();
      posts.push({ url, body, ...pending });
      return pending.promise;
    },
  };
  const filename = path.join(root, 'web/src/views/WxLoginHelp.vue');
  const { descriptor } = compiler.parse(
    fs.readFileSync(filename, 'utf8').replace('</script>', '\ndefineExpose({ sendQr, retryCompleteLogin, remainingLabel, canRetryLogin, canSend, status, loading, forbidden, pushInfo, retryInfo, loadError, sending, planSummary, planActivityLabel, qrImageSrc })\n</script>'),
    { filename },
  );
  const source = compiler.compileScript(descriptor, { id: 'wx-help-test' }).content;
  const stub = { __esModule: true, default: {} };
  const Help = evaluate(source, {
    vue,
    'vue-router': { useRoute: () => route, useRouter: () => router },
    '@vueuse/core': {
      useIntervalFn: (callback) => {
        const interval = { callback, active: false };
        intervals.push(interval);
        return { pause: () => { interval.active = false; }, resume: () => { interval.active = true; } };
      },
    },
    '@/api': { __esModule: true, default: apiStub },
    '@/components/ui/BaseButton.vue': stub,
  }).default;
  Help.render = () => null;
  const renderer = vue.createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode: () => null, nextSibling: () => null });
  let instance = null;
  const app = renderer.createApp({ render: () => vue.h(Help, { ref: value => { instance = value; } }) });
  getResponder.fn = responder; // 挂载即发起首次 GET：响应器必须先就位
  app.mount({});
  return {
    app, route, gets, posts, intervals, navigations, getResponder,
    instance: () => instance,
    get interval() { return intervals[0]; },
    async resolveStatus(data) {
      const request = gets.at(-1);
      request.resolve({ data: { ok: true, data } });
      await vue.nextTick();
      await vue.nextTick();
    },
  };
}

test('时钟偏移无关：服务器时间戳与本地墙钟差数小时，仍显示 ~5 分钟扫码窗口', async () => {
  const h = helpHarness();
  try {
    await h.resolveStatus(helpStatusFixture('301')); // serverNow≈5e6，真实 Date.now≈1.7e12
    assert.ok(h.instance().remainingLabel.includes('扫码窗口剩余'), h.instance().remainingLabel);
    assert.ok(h.instance().remainingLabel.includes('5:00'), `满窗应显示 5:00，实际: ${h.instance().remainingLabel}`);
    // 本地流逝（轮询 tick）只减真实经过的毫秒，不引入墙钟差。
    h.getResponder.fn = () => ({ data: { ok: true, data: helpStatusFixture('301') } });
    await h.interval.callback();
    assert.ok(h.instance().remainingLabel.startsWith('扫码窗口剩余 5:00') || h.instance().remainingLabel.startsWith('扫码窗口剩余 4:59'));
    // 服务端 expired 终态覆盖本地正计时。
    h.getResponder.fn = () => ({ data: { ok: true, data: helpStatusFixture('301', { pending: { ...helpStatusFixture('301').pending, state: 'expired' } }) } });
    await h.interval.callback();
    assert.equal(h.instance().remainingLabel, '二维码已过期，请刷新');
    assert.equal(h.interval.active, false, 'expired 终态停止轮询');
  }
  finally { h.app.unmount(); }
});

test('页面绝不自动发送：加载与轮询零 POST；发送只能来自用户点击', async () => {
  const h = helpHarness();
  try {
    h.getResponder.fn = () => ({ data: { ok: true, data: helpStatusFixture('301') } });
    await vue.nextTick();
    await vue.nextTick();
    for (let i = 0; i < 3; i++) await h.interval.callback();
    assert.equal(h.posts.length, 0, 'GET/轮询不得触发任何发送');

    const sent = h.instance().sendQr();
    await vue.nextTick();
    assert.equal(h.posts.length, 1, '用户点击恰好一次 POST');
    assert.equal(h.posts[0].url, '/api/wx-login-help/send-qr');
    assert.deepEqual(h.posts[0].body, { accountId: '301' });
    h.posts[0].resolve({ data: { ok: true, data: { pushed: true, pushError: '', session: { sessionId: 'sess-1' } } } });
    await sent;
    await vue.nextTick();
    assert.ok(h.instance().pushInfo.includes('Bark'), h.instance().pushInfo);
    assert.equal(h.posts.length, 1, '发送后刷新走 GET，不再隐式发送');
  }
  finally { h.app.unmount(); }
});

test('账号切换栅栏：旧账号迟到的状态不落到新账号；期间零发送', async () => {
  const h = helpHarness('301');
  try {
    await vue.nextTick();
    assert.equal(h.gets.length, 1, '初始加载一次 GET（在途）');
    const stale = h.gets[0];
    h.route.query.accountId = '302'; // 切换账号：旧 GET 尚未返回
    await vue.nextTick();
    await vue.nextTick();
    assert.ok(h.gets.length >= 2, '新代次不被旧在途请求卡死');
    assert.equal(h.instance().status, null, '切换后旧二维码/状态立即清空');
    // 旧账号（301）的迟到响应：必须被丢弃。
    stale.resolve({ data: { ok: true, data: helpStatusFixture('301') } });
    await vue.nextTick();
    await vue.nextTick();
    assert.equal(h.instance().status, null, '迟到响应不得写入新账号视图');
    // 新账号状态正常显示，且只有 302 的数据。
    const latest = h.gets.at(-1);
    latest.resolve({ data: { ok: true, data: helpStatusFixture('302') } });
    await vue.nextTick();
    await vue.nextTick();
    assert.equal(h.instance().status.account.id, '302');
    assert.equal(h.instance().status.pending.qrBase64, 'qr-image-302');
    assert.equal(h.posts.length, 0, '切换全程零发送');
  }
  finally { h.app.unmount(); }
});

test('同账号重发取代旧状态读取：迟到的 saved 不得覆盖新二维码或停掉轮询', async () => {
  const h = helpHarness('301');
  try {
    await h.resolveStatus(helpStatusFixture('301'));
    await settle();
    const oldPoll = h.interval.callback();
    const stale = h.gets.at(-1);
    const sending = h.instance().sendQr();
    await settle();
    h.posts.at(-1).resolve({ data: { ok: true, data: { pushed: true } } });
    await settle();
    const latest = h.gets.at(-1);
    assert.notEqual(latest, stale, '重发必须建立新的状态读取代次');
    const next = helpStatusFixture('301');
    next.pending.sessionId = 'latest-explicit-resend';
    latest.resolve({ data: { ok: true, data: next } });
    await sending;
    stale.resolve({ data: { ok: true, data: helpStatusFixture('301', {
      pending: { ...helpStatusFixture('301').pending, state: 'saved', sessionId: 'old-completed-session' },
    }) } });
    await oldPoll;
    await settle();
    assert.equal(h.instance().status.pending.sessionId, 'latest-explicit-resend');
    assert.equal(h.instance().status.pending.state, 'pending');
    assert.equal(h.interval.active, true, '新二维码仍须继续等待服务端扫码结果');
    assert.equal(h.posts.length, 1);
  }
  finally { h.app.unmount(); }
});

test('confirmed_retry：按钮仅在可重试态出现，重试不带新二维码；启动失败如实展示', async () => {
  const retryState = () => helpStatusFixture('301', { pending: { ...helpStatusFixture('301').pending, state: 'confirmed_retry', detail: '网络波动' } });
  const h = helpHarness('301', () => ({ data: { ok: true, data: retryState() } }));
  try {
    await settle();
    assert.equal(h.instance().canRetryLogin, true);
    assert.equal(h.instance().canSend, true, '持续失败仍可整段重新发码');

    const retrying = h.instance().retryCompleteLogin();
    await vue.nextTick();
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].url, '/api/wx-login-help/retry-login', '重试只补换码/保存，不重发二维码');
    h.posts[0].resolve({ data: { ok: true, data: { started: false, startError: '账号启动失败: worker boot failed' } } });
    await retrying;
    await vue.nextTick();
    await vue.nextTick();
    assert.ok(h.instance().retryInfo.includes('启动失败'), h.instance().retryInfo);
    assert.ok(h.instance().retryInfo.includes('worker boot failed'), '启动失败原因必须如实带回');
    const sendQrPosts = h.posts.filter(p => p.url.endsWith('send-qr'));
    assert.equal(sendQrPosts.length, 0);

    // 非 confirmed_retry 状态：重试入口失效。
    h.getResponder.fn = () => ({ data: { ok: true, data: helpStatusFixture('301') } });
    await h.interval.callback();
    assert.equal(h.instance().canRetryLogin, false);
  }
  finally { h.app.unmount(); }
});

test('二维码 dataURL 用服务端嗅探的真实图片类型；旧服务端缺省回退 PNG', async () => {
  // 服务端按魔数嗅探上报 JPEG（上游真实返回 JPEG）：dataURL 必须用真实类型，
  // 否则手机浏览器拒渲染。
  const jpeg = helpHarness('301', () => ({ data: { ok: true, data: helpStatusFixture('301', {
    pending: { ...helpStatusFixture('301').pending, qrMimeType: 'image/jpeg' },
  }) } }));
  try {
    await settle();
    assert.ok(jpeg.instance().qrImageSrc.startsWith('data:image/jpeg;base64,qr-image-301'), jpeg.instance().qrImageSrc);
  }
  finally { jpeg.app.unmount(); }

  // 旧服务端不带 qrMimeType：回退 PNG。
  const legacy = helpHarness('301', () => ({ data: { ok: true, data: helpStatusFixture('301') } }));
  try {
    await settle();
    assert.ok(legacy.instance().qrImageSrc.startsWith('data:image/png;base64,qr-image-301'), legacy.instance().qrImageSrc);
  }
  finally { legacy.app.unmount(); }
});

test('403 无权访问：停轮询、不再发起后续请求', async () => {
  const h = helpHarness('301');
  try {
    await vue.nextTick();
    const pending = h.gets[0];
    pending.reject(Object.assign(new Error('forbidden'), { response: { status: 403, data: {} } }));
    await vue.nextTick();
    await vue.nextTick();
    assert.equal(h.instance().forbidden, true);
    assert.equal(h.interval.active, false);
    const getsSoFar = h.gets.length;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.gets.length, getsSoFar, 'forbidden 后不得继续轮询');
    assert.equal(h.posts.length, 0);
  }
  finally { h.app.unmount(); }
});

test('卸载后轮询停止（无悬挂定时回调副作用）', async () => {
  const h = helpHarness('301', () => ({ data: { ok: true, data: helpStatusFixture('301') } }));
  await settle();
  assert.equal(h.interval.active, true);
  h.app.unmount();
  assert.equal(h.interval.active, false, 'unmount 必须停轮询');
});

// ---------- WxLoginHelp.vue：扫码维护参考计划卡片 ----------
function planFixture(overrides = {}) {
  const serverNow = 5_000_000;
  return {
    mode: 'reference',
    advanceEnabled: true,
    cycleHours: 24,
    advanceMinutes: 60,
    available: true,
    waitingForScan: false,
    acceptedScanAt: serverNow - 22 * 3_600_000,
    maintenanceAt: serverNow + 2 * 3_600_000,
    reminderAt: serverNow + 1 * 3_600_000,
    remainingMs: 2 * 3_600_000,
    overdue: false,
    notified: false,
    notificationSentAt: 0,
    notificationError: '',
    recentMobileActivityAt: serverNow - 3_600_000,
    recentMobileActivityAvailable: true,
    pauseReason: '',
    ...overrides,
  };
}

test('维护计划卡片：有效计划显示进度与信号状态；不把未送达说成已发送', async () => {
  const h = helpHarness('301', () => ({ data: { ok: true, data: helpStatusFixture('301', { plan: planFixture() }) } }));
  try {
    await settle();
    const summary = h.instance().planSummary;
    assert.ok(summary.includes('下次维护参考时间'), summary);
    assert.ok(summary.includes('周期 24 小时，提前 60 分钟提醒'), summary);
    assert.ok(!summary.includes('已发送'), '未认领不得声称已发送');
    const activity = h.instance().planActivityLabel;
    assert.ok(activity.includes('其他终端登录'), activity);
    assert.ok(activity.includes('24 小时窗口内'), activity);
    assert.ok(activity.includes('手机进场参考'), activity);

    // 已认领但发送失败：如实说「已尝试」，不说「已发送」。
    h.getResponder.fn = () => ({ data: { ok: true, data: helpStatusFixture('301', { plan: planFixture({ notified: true, notificationSentAt: 0, notificationError: 'Bark HTTP 502' }) }) } });
    await h.interval.callback();
    assert.ok(h.instance().planSummary.includes('已尝试'), h.instance().planSummary);
    assert.ok(h.instance().planSummary.includes('不会重复自动发送'), h.instance().planSummary);
    assert.ok(h.instance().planSummary.includes('502'), '失败原因要展示');

    // 已送达：才可以说「已发送」。
    h.getResponder.fn = () => ({ data: { ok: true, data: helpStatusFixture('301', { plan: planFixture({ notified: true, notificationSentAt: 5_100_000, notificationError: '' }) }) } });
    await h.interval.callback();
    assert.ok(h.instance().planSummary.includes('已发送'), h.instance().planSummary);
  }
  finally { h.app.unmount(); }
});

test('维护计划卡片：到期/暂停/等待扫码的准确措辞', async () => {
  // 参考时间已到：不得再显示「下次 + 剩 0 分钟」。
  let h = helpHarness('301', () => ({ data: { ok: true, data: helpStatusFixture('301', { plan: planFixture({ overdue: true, remainingMs: -60_000 }) }) } }));
  try {
    await settle();
    assert.ok(h.instance().planSummary.includes('维护参考时间已到'), h.instance().planSummary);
    assert.ok(!h.instance().planSummary.includes('下次维护参考时间'), '到期后不得再显示「下次」');
  }
  finally { h.app.unmount(); }

  // 无进场信号：显示暂停原因，不得暗示会发。
  h = helpHarness('301', () => ({ data: { ok: true, data: helpStatusFixture('301', { plan: planFixture({
    recentMobileActivityAt: 0,
    recentMobileActivityAvailable: false,
    pauseReason: '最近 24 小时未观察到其他终端登录（手机进场参考），暂不发送周期提醒',
  }) }) } }));
  try {
    await settle();
    assert.ok(h.instance().planSummary.includes('其他终端登录'), h.instance().planSummary);
    assert.ok(h.instance().planSummary.includes('暂不发送周期提醒'), h.instance().planSummary);
    assert.ok(h.instance().planActivityLabel.includes('未观察到'), h.instance().planActivityLabel);
  }
  finally { h.app.unmount(); }

  // 无扫码基线：等待下一次扫码，不显示进度。
  h = helpHarness('301', () => ({ data: { ok: true, data: helpStatusFixture('301', { plan: planFixture({
    available: false,
    waitingForScan: true,
    acceptedScanAt: 0,
    maintenanceAt: 0,
    reminderAt: 0,
    remainingMs: 0,
    pauseReason: '完成下一次扫码后开始计算计划',
  }) }) } }));
  try {
    await settle();
    assert.equal(h.instance().planSummary, '完成下一次扫码后开始计算计划');
  }
  finally { h.app.unmount(); }

  // 旧服务端无 plan 字段：页面照常工作，计划区为空。
  h = helpHarness('301', () => ({ data: { ok: true, data: helpStatusFixture('301') } }));
  try {
    await settle();
    assert.equal(h.instance().planSummary, '');
    assert.equal(h.instance().planActivityLabel, '');
    assert.ok(typeof h.instance().sendQr === 'function', '扫码功能不受影响');
  }
  finally { h.app.unmount(); }
});
