'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 纯二维码 Bark 推送（QR-only）回归：
 * - 上游二维码接口真实返回 JPEG（线上事故：PNG-only 校验曾致 500）：按魔数
 *   嗅探 PNG/JPEG 后原样字节透传，Content-Type 用真实类型；HTML/SVG/未知
 *   内容拒绝并取消刚拿到的会话，绝不注册。
 * - 所有二维码推送只带一张图片：标题空、正文仅一个空白字符，键集合封闭为
 *   title/body/device_key/group/url/image，绝不携带账号名等描述文字。
 * - 自动提醒（提前/终态）资格守卫三道检查点（触网前/注册前/外发前）：二
 *   维码生成等待期间关提前开关/关总开关/暂停账号 → 零外发、零会话暴露、
 *   零轮询，并取消刚拿到的二维码（主审反例 disable-advance /
 *   disable-overall / pause-during-qr）。
 * - 自动提醒不打断进行中的用户扫码会话，与手动在途请求合并为一次；被取
 *   消的外发不重新武装；发送失败消耗声明不重试；手动路径 Bark 未配置时
 *   仍照常在页面展示（旧行为）。
 */

const RUNTIME_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-wx-qr-only-'));
process.env.FARM_DATA_DIR = RUNTIME_DATA_DIR;
fs.writeFileSync(path.join(RUNTIME_DATA_DIR, 'accounts.json'), JSON.stringify({ accounts: [], nextId: 1 }));

const serviceModule = require('../src/services/wx-login-reminder');
const HOUR_MS = 3600_000;
const MIN_MS = 60_000;
// 每个 harness 的临时目录都登记：after 统一清理（不留悬挂句柄/垃圾）。
const HARNESS_DIRS = [];

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47]), Buffer.alloc(32, 7)]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(48, 9)]);

const flush = () => new Promise(resolve => setImmediate(resolve));

function mkFetch(log, results = []) {
  let cursor = 0;
  return async (url, init) => {
    log.push({ url, init });
    const preset = results[cursor++] || { ok: true, json: { code: 200 } };
    return { ok: preset.ok !== false, status: preset.status || 200, json: async () => preset.json };
  };
}

function baseAccount(overrides = {}) {
  return {
    id: '101', name: '农场号A', platform: 'wx', username: 'owner1',
    wxid: 'openid-A', refreshtoken: 'r1', loginBuffer: 'b1',
    ...overrides,
  };
}

function harness({ accounts, fetchResults, qrBytes = PNG_BYTES, gate: useGate = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-wx-qr-'));
  HARNESS_DIRS.push(dataDir);
  const registryFile = path.join(dataDir, 'wx-login-reminder.json');
  const sent = [];
  const clock = { now: 1_700_000_000_000 };
  const adapterCalls = { qr: 0, checkQr: 0, cancelled: [] };
  const accountList = accounts || [baseAccount()];
  const gate = { resolve: null, promise: null };
  if (useGate) gate.promise = new Promise(resolve => { gate.resolve = resolve; });
  const adapter = {
    getQRCode: async () => {
      adapterCalls.qr += 1;
      if (gate.promise) await gate.promise;
      const createdAt = clock.now;
      return {
        Success: true,
        Data: {
          Uuid: `qr-sess-${adapterCalls.qr}`,
          QrBase64: qrBytes.toString('base64'),
          CreatedAt: createdAt, ExpiresAt: createdAt + 300_000,
        },
      };
    },
    checkQR: async () => { adapterCalls.checkQr += 1; return { Success: true, Data: { status: 0 } }; },
    cancelWxSession: sessionId => { adapterCalls.cancelled.push(String(sessionId)); return true; },
    getWxSessionInfo: () => null,
  };
  const service = serviceModule.createWxLoginReminderService({
    getAccounts: () => ({ accounts: accountList.filter(Boolean) }),
    log: () => {},
    addAccountLog: () => {},
    fetchImpl: mkFetch(sent, fetchResults),
    now: () => clock.now,
    watcherPollMs: 5,
    adapter,
    completeRescan: async () => ({ ok: true, started: true }),
    registryFile: () => registryFile,
  });
  return { dataDir, registryFile, service, sent, clock, adapterCalls, accountList, gate };
}

async function enableBark(h, owner = 'owner1', overrides = {}) {
  await h.service.setUserConfig(owner, {
    enabled: true,
    deviceKey: 'device-key-of-owner',
    serverUrl: 'https://panel.example.com',
    ...overrides,
  });
}

/** 建立真实扫码基线（默认 24h/60min → 23h 处进入提醒窗口）。 */
async function acceptScan(h, accountId = '101') {
  await h.service.noteAcceptedScan(accountId);
}

/** 等到自动/手动流程真正进入二维码生成（gate 已挂起）。 */
async function waitForQrEntered(h) {
  for (let i = 0; i < 50 && h.adapterCalls.qr === 0; i++) await flush();
  assert.equal(h.adapterCalls.qr, 1, '流程必须已进入二维码生成');
}

// ── 上游 JPEG 线上事故 ──

test('上游返回 JPEG：mustNotReject，字节原样透传 + 真实 Content-Type + 会话 MIME', async () => {
  const h = harness({ qrBytes: JPEG_BYTES });
  await enableBark(h);
  // 上游真实返回 JPEG 必须被整体接受（PNG-only 校验曾致 500 的线上事故）。
  let result = null;
  await assert.doesNotReject(async () => {
    result = await h.service.requestQrPush({ account: h.accountList[0], origin: 'manual' });
  });
  assert.ok(result && result.session, '必须返回会话结果');
  assert.equal(result.pushed, true);
  assert.equal(result.session.qrMimeType, 'image/jpeg');
  assert.equal(h.service.getPendingSession('101').qrMimeType, 'image/jpeg');
  const image = h.service.getQrImage(result.imageToken);
  assert.ok(image, '图片能力可用');
  assert.equal(image.contentType, 'image/jpeg');
  assert.deepEqual(image.png, JPEG_BYTES, '原始字节原样保留（png 字段为兼容保留）');
  assert.equal(image.accountId, '101');
  h.service.stopWatcher('101');
});

test('PNG 兼容：仍然接受，MIME image/png', async () => {
  const h = harness({ qrBytes: PNG_BYTES });
  await enableBark(h);
  const result = await h.service.requestQrPush({ account: h.accountList[0], origin: 'manual' });
  assert.equal(result.pushed, true);
  assert.equal(result.session.qrMimeType, 'image/png');
  const image = h.service.getQrImage(result.imageToken);
  assert.equal(image.contentType, 'image/png');
  assert.deepEqual(image.png, PNG_BYTES);
  h.service.stopWatcher('101');
});

test('HTML/SVG/未知内容：拒绝并取消刚拿到的会话，不注册、不外发', async () => {
  const badPayloads = [
    Buffer.from('<html><body>login page</body></html>'),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]),
  ];
  for (const bytes of badPayloads) {
    const h = harness({ qrBytes: bytes });
    await enableBark(h);
    await assert.rejects(
      () => h.service.requestQrPush({ account: h.accountList[0], origin: 'manual' }),
      /PNG\/JPEG/,
      '非图片内容必须整体拒绝',
    );
    assert.equal(h.sent.length, 0, '拒绝的内容绝不外发');
    assert.equal(h.service.getPendingSession('101'), null, '拒绝的内容不得注册会话');
    assert.deepEqual(h.adapterCalls.cancelled, ['qr-sess-1'], '必须取消刚拿到的会话');
    assert.equal(h.adapterCalls.checkQr, 0, '不得启动守望');
  }
});

// ── 纯图片通知契约 ──

test('推送只带一张二维码图片：标题空、正文一个空白、键集合封闭、无账号名', async () => {
  const h = harness();
  await enableBark(h);
  const result = await h.service.requestQrPush({ account: h.accountList[0], origin: 'manual' });
  assert.equal(result.pushed, true);
  assert.equal(h.sent.length, 1);
  const payload = JSON.parse(h.sent[0].init.body);
  assert.equal(payload.title, '', '纯二维码通知无标题');
  assert.equal(payload.body, ' ', '正文仅一个空白字符（满足上游必填）');
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['body', 'device_key', 'group', 'image', 'title', 'url'],
    '通知只携带元数据，键集合封闭',
  );
  assert.match(payload.image, /^https:\/\/panel\.example\.com\/api\/wx-login-qr-image\/[0-9a-f]{64}$/);
  assert.equal(payload.device_key, 'device-key-of-owner');
  assert.equal(payload.group, 'wx-login');
  assert.equal(payload.url, 'https://panel.example.com/wx-login-help?accountId=101');
  assert.ok(!JSON.stringify(payload).includes('农场号A'), '不得携带账号名等描述文字');
  h.service.stopWatcher('101');
});

test('纯图片通知缺图片链接：直接拒绝，不发出空白通知', async () => {
  const h = harness();
  const result = await h.service.sendBark(
    { enabled: true, deviceKey: 'device-key-of-owner', serverUrl: 'https://panel.example.com' },
    { imageOnly: true },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, '纯图片通知缺少二维码图片');
  assert.equal(h.sent.length, 0);
});

// ── 主审三反例：二维码生成等待期间资格被收回 ──

test('反例 disable-advance：等待期间关提前提醒 → 零外发/零暴露/零轮询，取消刚拿到的二维码', async () => {
  const h = harness({ gate: true });
  await enableBark(h);
  await acceptScan(h);
  await h.service.noteOtherTerminalLogin('101');
  h.clock.now += 23 * HOUR_MS;
  const sweeping = h.service.sweepMaintenanceOnce();
  await waitForQrEntered(h);
  await h.service.setUserConfig('owner1', { advanceEnabled: false });
  h.gate.resolve();
  await sweeping;
  await flush();
  assert.equal(h.sent.length, 0, '关提前开关后不得外发');
  assert.equal(h.service.getPendingSession('101'), null, '被取消的会话不得暴露在页面状态里');
  assert.equal(h.adapterCalls.checkQr, 0, '不得启动守望（零轮询）');
  assert.deepEqual(h.adapterCalls.cancelled, ['qr-sess-1'], '必须取消刚拿到的二维码会话');
  const persisted = JSON.parse(fs.readFileSync(h.registryFile, 'utf8'));
  assert.equal(persisted.advanceNotices['101'].sentAt, 0, '未送达不得记 sentAt');
  assert.equal(persisted.advanceNotices['101'].lastError, '', '用户主动取消不算错误');
  await h.service.setUserConfig('owner1', { advanceEnabled: true });
  assert.equal(await h.service.sweepMaintenanceOnce(), 0, '被取消的外发不重新武装（声明已消耗，新扫码前保持安静）');
  assert.equal(h.sent.length, 0);
});

test('反例 disable-overall：等待期间关总开关 → 零外发/零暴露/零轮询', async () => {
  const h = harness({ gate: true });
  await enableBark(h);
  await acceptScan(h);
  await h.service.noteOtherTerminalLogin('101');
  h.clock.now += 23 * HOUR_MS;
  const sweeping = h.service.sweepMaintenanceOnce();
  await waitForQrEntered(h);
  await h.service.setUserConfig('owner1', { enabled: false });
  h.gate.resolve();
  await sweeping;
  await flush();
  assert.equal(h.sent.length, 0);
  assert.equal(h.service.getPendingSession('101'), null, '用户已禁用，页面不得暴露新会话');
  assert.equal(h.adapterCalls.checkQr, 0);
  assert.deepEqual(h.adapterCalls.cancelled, ['qr-sess-1']);
  await enableBark(h);
  assert.equal(await h.service.sweepMaintenanceOnce(), 0, '重新启用也不补发（声明已消耗）');
  assert.equal(h.sent.length, 0);
});

test('反例 pause-during-qr：等待期间暂停账号 → 零外发/零暴露/零轮询', async () => {
  const h = harness({ gate: true });
  await enableBark(h);
  await acceptScan(h);
  await h.service.noteOtherTerminalLogin('101');
  h.clock.now += 23 * HOUR_MS;
  const sweeping = h.service.sweepMaintenanceOnce();
  await waitForQrEntered(h);
  h.accountList[0].autoLogin = false;
  h.gate.resolve();
  await sweeping;
  await flush();
  assert.equal(h.sent.length, 0, '暂停的账号不得被打扰');
  assert.equal(h.service.getPendingSession('101'), null);
  assert.equal(h.adapterCalls.checkQr, 0);
  assert.deepEqual(h.adapterCalls.cancelled, ['qr-sess-1']);
  h.accountList[0].autoLogin = true;
  assert.equal(await h.service.sweepMaintenanceOnce(), 0, '恢复后也不补发（声明已消耗）');
  assert.equal(h.sent.length, 0);
});

test('终态路径同栅栏：等待期间暂停账号 → 零外发/零暴露/零轮询，声明如实保留', async () => {
  const h = harness({ gate: true });
  await enableBark(h);
  const working = h.service.noteCredentialInvalid('101');
  await waitForQrEntered(h);
  h.accountList[0].autoLogin = false;
  h.gate.resolve();
  assert.equal(await working, true, '终态事件本身已认领处理');
  await flush();
  assert.equal(h.sent.length, 0);
  assert.equal(h.service.getPendingSession('101'), null);
  assert.equal(h.adapterCalls.checkQr, 0);
  assert.deepEqual(h.adapterCalls.cancelled, ['qr-sess-1']);
  const incident = h.service.getIncident('101');
  assert.equal(incident.needsRescan, true, '失效事实如实记录');
  assert.equal(incident.sentAt, 0);
  assert.equal(incident.lastError, '', '用户主动取消不算错误');
  h.accountList[0].autoLogin = true;
  assert.equal(await h.service.noteCredentialInvalid('101'), false, '不自动重试');
  assert.deepEqual(await h.service.dispatchPendingForUser('owner1'), [], '启用补发也不得越过已消耗的声明');
  assert.equal(h.sent.length, 0);
});

// ── 自动不打断用户会话 / 合并在途请求 ──

test('自动提醒遇到进行中的扫码会话：让位不重发、绝不取消用户会话', async () => {
  const h = harness();
  await enableBark(h);
  await acceptScan(h);
  await h.service.noteOtherTerminalLogin('101');
  h.clock.now += 23 * HOUR_MS;
  // 用户此刻正在用的扫码会话（未过期）：自动到点必须让位。
  const first = await h.service.requestQrPush({ account: h.accountList[0], origin: 'manual' });
  assert.equal(first.pushed, true);
  assert.equal(await h.service.sweepMaintenanceOnce(), 1, '巡检完成（认领声明）');
  assert.equal(h.sent.length, 1, '不重复推送第二张二维码');
  assert.equal(h.adapterCalls.qr, 1, '未生成第二张二维码');
  const pending = h.service.getPendingSession('101');
  assert.equal(pending.sessionId, first.session.sessionId, '用户手上的会话保持不变');
  assert.deepEqual(h.adapterCalls.cancelled, [], '绝不取消进行中的会话');
  h.service.stopWatcher('101');
});

test('自动到点与手动在途合并：只生成一张二维码，绝不取消手动请求', async () => {
  const h = harness({ gate: true });
  await enableBark(h);
  await acceptScan(h);
  await h.service.noteOtherTerminalLogin('101');
  h.clock.now += 23 * HOUR_MS;
  const manual = h.service.requestQrPush({ account: h.accountList[0], origin: 'manual' });
  await waitForQrEntered(h);
  const sweeping = h.service.sweepMaintenanceOnce();
  for (let i = 0; i < 5; i++) await flush(); // 声明落盘并合并在途请求
  h.gate.resolve();
  const [manualResult, sweepResult] = await Promise.all([manual, sweeping]);
  assert.equal(h.adapterCalls.qr, 1, '合并为一次生成');
  assert.equal(h.sent.length, 1);
  assert.equal(sweepResult, 1);
  assert.equal(h.service.getPendingSession('101').sessionId, manualResult.session.sessionId, '会话归手动请求所有');
  assert.deepEqual(h.adapterCalls.cancelled, []);
  h.service.stopWatcher('101');
});

// ── 自动到点行为 ──

test('自动提前提醒：到点恰好一张二维码，无任何预备文字通知', async () => {
  const h = harness();
  await enableBark(h);
  await acceptScan(h);
  await h.service.noteOtherTerminalLogin('101');
  h.clock.now += 23 * HOUR_MS - MIN_MS;
  assert.equal(await h.service.sweepMaintenanceOnce(), 0);
  assert.equal(h.sent.length, 0);
  h.clock.now += MIN_MS;
  assert.equal(await h.service.sweepMaintenanceOnce(), 1);
  assert.equal(h.sent.length, 1, '无预备/测试文字通知，直接就是二维码');
  assert.equal(h.adapterCalls.qr, 1);
  const payload = JSON.parse(h.sent[0].init.body);
  assert.equal(payload.title, '');
  assert.equal(payload.body, ' ');
  assert.match(payload.image, /\/api\/wx-login-qr-image\//);
  assert.equal(await h.service.sweepMaintenanceOnce(), 0, '同代次不重发');
  assert.equal(h.sent.length, 1);
  h.service.stopWatcher('101');
});

test('终态失效提醒：改推一张二维码（纯图片契约）', async () => {
  const h = harness();
  await enableBark(h);
  assert.equal(await h.service.noteCredentialInvalid('101'), true);
  assert.equal(h.sent.length, 1);
  assert.equal(h.adapterCalls.qr, 1);
  const payload = JSON.parse(h.sent[0].init.body);
  assert.equal(payload.title, '');
  assert.equal(payload.body, ' ');
  assert.match(payload.image, /\/api\/wx-login-qr-image\//);
  assert.equal(h.service.getIncident('101').sentAt > 0, true);
  h.service.stopWatcher('101');
});

test('终态发送失败：声明消耗、lastError 如实、无自动重试', async () => {
  const h = harness({ fetchResults: [{ ok: false, status: 502, json: {} }] });
  await enableBark(h);
  assert.equal(await h.service.noteCredentialInvalid('101'), true);
  assert.equal(h.sent.length, 1, '尝试过一次');
  const incident = h.service.getIncident('101');
  assert.equal(incident.sentAt, 0);
  assert.equal(incident.lastError, 'Bark HTTP 502');
  assert.equal(await h.service.noteCredentialInvalid('101'), false, '不自动重试');
  assert.equal(h.sent.length, 1);
  h.service.stopWatcher('101');
});

// ── 手动路径旧行为保持 ──

test('手动路径 Bark 未配置：会话照常在页面展示（旧行为），仅记录原因', async () => {
  const h = harness();
  await h.service.setUserConfig('owner1', { enabled: false, deviceKey: '', serverUrl: '' });
  const result = await h.service.requestQrPush({ account: h.accountList[0], origin: 'manual' });
  assert.equal(result.pushed, false);
  assert.equal(result.pushError, '未启用 Bark 提醒');
  assert.equal(h.sent.length, 0);
  assert.ok(h.service.getPendingSession('101'), '手动二维码仍要在页面展示');
  h.service.stopWatcher('101');
});

test('手动重发：旧图片令牌立即吊销', async () => {
  const h = harness();
  await enableBark(h);
  const first = await h.service.requestQrPush({ account: h.accountList[0], origin: 'manual' });
  assert.ok(h.service.getQrImage(first.imageToken));
  const second = await h.service.requestQrPush({ account: h.accountList[0], origin: 'manual' });
  assert.notEqual(second.imageToken, first.imageToken);
  assert.equal(h.service.getQrImage(first.imageToken), null, '旧令牌立即吊销');
  assert.ok(h.service.getQrImage(second.imageToken));
  h.service.stopWatcher('101');
});

test.after(() => {
  for (const dir of HARNESS_DIRS) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
  }
  fs.rmSync(RUNTIME_DATA_DIR, { recursive: true, force: true });
});
