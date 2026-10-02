'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 扫码维护参考计划（提前提醒）回归：
 * - 计划基线只认真实接受扫码（noteAcceptedScan）；轮换 token / 改备注 /
 *   Web 登录 / 进程重启都不构成基线，也不重置计划。
 * - 提前提醒前置条件：属主 Bark 启用 + 提前提醒开启 + 到达提醒窗口 +
 *   最近 24h 内有「已在其他终端登录」信号（同属主/同微信绑定）。
 * - 两种模式（提前 / 终态失效）合计每代次至多一条自动外发；声明先落盘
 *   （fail closed），发送失败保留声明不重试；新扫码是唯一重新武装。
 * - 排队期间（声明临界区前/内/外发前）的暂停、换绑、禁用、参数调整
 *   必须拦下且不消耗声明（主审反例 1–3 回归）。
 * - runtime 引擎真实接线：start 启动巡检、stopAllAccounts 停止、
 *   kickout_stop 且原因恰为「已在其他终端登录」才记录信号。
 */

const RUNTIME_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-wx-advance-runtime-'));
process.env.FARM_DATA_DIR = RUNTIME_DATA_DIR;
fs.writeFileSync(path.join(RUNTIME_DATA_DIR, 'accounts.json'), JSON.stringify({ accounts: [], nextId: 1 }));

const serviceModule = require('../src/services/wx-login-reminder');
const { createScheduler } = require('../src/services/scheduler');
const DAY_MS = 24 * 3600_000;
const HOUR_MS = 3600_000;
const MIN_MS = 60_000;
const CLOCK_START = 1_700_000_000_000;
// 每个 harness 的临时目录都登记：after 统一清理（不留悬挂句柄/垃圾）。
const HARNESS_DIRS = [];

function mkFetch(log, results = []) {
  let cursor = 0;
  return async (url, init) => {
    log.push({ url, init });
    const preset = results[cursor++] || { ok: true, json: { code: 200 } };
    return {
      ok: preset.ok !== false,
      status: preset.status || 200,
      json: async () => preset.json,
    };
  };
}

function baseAccount(overrides = {}) {
  return {
    id: '101', name: '农场号A', platform: 'wx', username: 'owner1',
    wxid: 'openid-A', refreshtoken: 'r1', loginBuffer: 'b1',
    ...overrides,
  };
}

function harness({
  accounts, fetchResults, clockStart = CLOCK_START, serviceDeps = {},
} = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-wx-adv-'));
  HARNESS_DIRS.push(dataDir);
  const registryFile = path.join(dataDir, 'wx-login-reminder.json');
  const sent = [];
  const logs = [];
  const clock = { now: clockStart };
  const adapterCalls = { qr: 0, checkQr: 0, cancelled: 0, farmCode: 0 };
  const accountList = accounts || [baseAccount()];
  const adapter = {
    getQRCode: async () => {
      adapterCalls.qr += 1;
      const createdAt = clock.now;
      return {
        Success: true,
        Data: {
          Uuid: `sess-${adapterCalls.qr}`,
          QrBase64: Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47]), Buffer.alloc(32)]).toString('base64'),
          CreatedAt: createdAt, ExpiresAt: createdAt + 300_000,
        },
      };
    },
    checkQR: async () => { adapterCalls.checkQr += 1; return { Success: true, Data: { status: 0 } }; },
    cancelWxSession: () => { adapterCalls.cancelled += 1; return true; },
    getWxSessionInfo: () => null,
  };
  const service = serviceModule.createWxLoginReminderService({
    getAccounts: () => ({ accounts: accountList.filter(Boolean) }),
    log: (level, message, extra) => logs.push({ level, message, extra }),
    addAccountLog: () => {},
    fetchImpl: mkFetch(sent, fetchResults),
    now: () => clock.now,
    watcherPollMs: 5,
    adapter,
    completeRescan: async () => ({ ok: true, started: true }),
    registryFile: () => registryFile,
    ...serviceDeps,
  });
  return { dataDir, registryFile, service, sent, logs, clock, adapterCalls, accountList };
}

async function enableBark(h, owner = 'owner1', overrides = {}) {
  await h.service.setUserConfig(owner, {
    enabled: true,
    deviceKey: 'device-key-of-owner',
    serverUrl: 'https://panel.example.com',
    ...overrides,
  });
}

/** 建立真实扫码基线（默认周期 24h / 提前 60min → 23h 处进入提醒窗口）。 */
async function acceptScan(h, accountId = '101') {
  await h.service.noteAcceptedScan(accountId);
}

test('默认 24h/60min：22h59m 不发，23h 恰好一条；措辞是参考提醒不判失效', async () => {
  const h = harness();
  await enableBark(h);
  await acceptScan(h);
  await h.service.noteOtherTerminalLogin('101');

  h.clock.now += 23 * HOUR_MS - MIN_MS;
  assert.equal(await h.service.sweepMaintenanceOnce(), 0, '提醒窗口开始前一秒不得外发');
  assert.equal(h.sent.length, 0);

  h.clock.now += MIN_MS;
  assert.equal(await h.service.sweepMaintenanceOnce(), 1, '进入提前窗口恰好一条');
  assert.equal(h.sent.length, 1);
  const body = JSON.parse(h.sent[0].init.body);
  assert.equal(body.device_key, 'device-key-of-owner', '只发属主自己的 Key');
  assert.equal(body.title, '', '提前提醒也是纯二维码通知：无标题');
  assert.equal(body.body, ' ', '正文仅一个空白字符（无文字内容）');
  assert.match(body.image, /^https:\/\/panel\.example\.com\/api\/wx-login-qr-image\/[0-9a-f]{64}$/, '推送内容就是当次生成的二维码图片');
  assert.match(body.url, /\/wx-login-help\?accountId=101$/);
  assert.deepEqual(Object.keys(body).sort(), ['body', 'device_key', 'group', 'image', 'title', 'url']);
  assert.equal(h.adapterCalls.qr, 1, '到点即生成一张二维码');
  assert.equal(h.service.needsRescan('101'), false, '提前提醒不设置 needsRescan');
  assert.equal(h.service.getIncident('101'), null);

  const plan = h.service.getHelpStatus(h.accountList[0]).plan;
  assert.equal(plan.notified, true, '状态视图标记本代次已提前提醒');
  assert.equal(plan.available, true);
  assert.equal(plan.waitingForScan, false);
  assert.equal(plan.pauseReason, '', '有效计划且无阻塞时不得显示等待扫码/暂停字样');
});

test('4h 周期 / 30min 提前：3.5h 处到达窗口；提前量与周期能按用户配置工作', async () => {
  const h = harness();
  await enableBark(h, 'owner1', { maintenanceCycleHours: 4, advanceMinutes: 30 });
  await acceptScan(h);
  await h.service.noteOtherTerminalLogin('101');
  h.clock.now += 3 * HOUR_MS + 29 * MIN_MS;
  assert.equal(await h.service.sweepMaintenanceOnce(), 0);
  h.clock.now += MIN_MS;
  assert.equal(await h.service.sweepMaintenanceOnce(), 1);
  const plan = h.service.getHelpStatus(h.accountList[0]).plan;
  assert.equal(plan.cycleHours, 4);
  assert.equal(plan.advanceMinutes, 30);
});

test('声明跨重启持久：同代次重启/重复/并发巡检都零补发；发送失败不重试', async () => {
  const h = harness();
  await enableBark(h);
  await acceptScan(h);
  await h.service.noteOtherTerminalLogin('101');
  h.clock.now += 23 * HOUR_MS;
  assert.equal(await h.service.sweepMaintenanceOnce(), 1);
  assert.deepEqual(await Promise.all([h.service.sweepMaintenanceOnce(), h.service.sweepMaintenanceOnce()]), [0, 0]);

  // 进程“重启”：同一注册表文件上的新实例。
  const reborn = serviceModule.createWxLoginReminderService({
    getAccounts: () => ({ accounts: [baseAccount()] }),
    log: () => {},
    fetchImpl: mkFetch(h.sent),
    now: () => h.clock.now,
    adapter: { getQRCode: async () => { throw new Error('不得触达'); }, cancelWxSession: () => true },
    registryFile: () => h.registryFile,
  });
  assert.equal(await reborn.sweepMaintenanceOnce(), 0, '重启后同代次不补发');
  const rebornPlan = reborn.getHelpStatus(baseAccount()).plan;
  assert.equal(rebornPlan.notified, true, '声明跨重启可读');
});

test('发送失败保留声明不风暴：lastError 落盘且不含设备 Key', async () => {
  const h = harness({ fetchResults: [{ ok: false, status: 502, json: {} }] });
  await enableBark(h);
  await acceptScan(h);
  await h.service.noteOtherTerminalLogin('101');
  h.clock.now += 23 * HOUR_MS;
  await h.service.sweepMaintenanceOnce();
  await h.service.sweepMaintenanceOnce();
  assert.equal(h.sent.length, 1, '失败也只尝试一次，无自动重试');
  const persisted = JSON.parse(fs.readFileSync(h.registryFile, 'utf8'));
  assert.equal(persisted.advanceNotices['101'].sentAt, 0);
  assert.ok(!String(persisted.advanceNotices['101'].lastError).includes('device-key-of-owner'));
});

test('最近 24h「其他终端登录」是硬前置：无信号/过期/未来/错绑一律零外发', async () => {
  // 无信号：扫码 + 到期也不发（含已超过维护参考时间）。
  const none = harness();
  await enableBark(none);
  await acceptScan(none);
  none.clock.now += 25 * HOUR_MS;
  assert.equal(await none.service.sweepMaintenanceOnce(), 0, '无进场参考信号：到期也不发');
  assert.equal(none.service.getHelpStatus(none.accountList[0]).plan.recentMobileActivityAvailable, false);
  assert.ok(none.service.getHelpStatus(none.accountList[0]).plan.pauseReason.includes('其他终端登录'));

  // 有信号但在 24h 窗口外。
  const stale = harness();
  await enableBark(stale);
  await acceptScan(stale);
  await stale.service.noteOtherTerminalLogin('101');
  stale.clock.now += 24 * HOUR_MS + 30 * MIN_MS;
  assert.equal(await stale.service.sweepMaintenanceOnce(), 0, '信号超 24h：不发');

  // 恰好 24h 边界：允许（>= 窗口下沿）。
  const edge = harness();
  await enableBark(edge);
  await acceptScan(edge);
  edge.clock.now += HOUR_MS;
  await edge.service.noteOtherTerminalLogin('101');
  edge.clock.now += 24 * HOUR_MS;
  assert.equal(await edge.service.sweepMaintenanceOnce(), 1, '恰好 24h 的信号仍算最近');

  // 未来时间戳（脏数据）：注入「晚于决策时刻」的信号（= 起点+24h，巡检在 23h 处）。
  const dirty = harness();
  await enableBark(dirty);
  await acceptScan(dirty);
  await dirty.service.noteOtherTerminalLogin('101'); // 先落一个合法基线结构
  const raw = JSON.parse(fs.readFileSync(dirty.registryFile, 'utf8'));
  raw.otherTerminalLogins['101'] = {
    at: dirty.clock.now + DAY_MS, owner: 'owner1', wxid: 'openid-A',
  };
  fs.writeFileSync(dirty.registryFile, JSON.stringify(raw));
  const dirtyReborn = serviceModule.createWxLoginReminderService({
    getAccounts: () => ({ accounts: [baseAccount()] }),
    log: () => {}, fetchImpl: mkFetch(dirty.sent), now: () => dirty.clock.now,
    adapter: { getQRCode: async () => { throw new Error('不得触达'); }, cancelWxSession: () => true },
    registryFile: () => dirty.registryFile,
  });
  dirty.clock.now += 23 * HOUR_MS; // 决策时刻：信号时间戳 = 决策时刻 + 1h（未来）
  assert.equal(await dirtyReborn.sweepMaintenanceOnce(), 0, '未来信号不得作为进场参考');
  assert.equal(dirtyReborn.getHelpStatus(baseAccount()).plan.recentMobileActivityAvailable, false);

  // 错误绑定：账号 101 的注册表信号换成别的属主/别的微信，各测一次。
  for (const mismatch of [
    { at: dirty.clock.now - HOUR_MS, owner: 'owner-OTHER', wxid: 'openid-A' },
    { at: dirty.clock.now - HOUR_MS, owner: 'owner1', wxid: 'openid-OTHER' },
  ]) {
    const bound = harness();
    await enableBark(bound);
    await acceptScan(bound);
    const rawBound = JSON.parse(fs.readFileSync(bound.registryFile, 'utf8'));
    rawBound.otherTerminalLogins = { 101: mismatch };
    fs.writeFileSync(bound.registryFile, JSON.stringify(rawBound));
    const boundReborn = serviceModule.createWxLoginReminderService({
      getAccounts: () => ({ accounts: [baseAccount()] }),
      log: () => {}, fetchImpl: mkFetch(bound.sent), now: () => bound.clock.now,
      adapter: { getQRCode: async () => { throw new Error('不得触达'); }, cancelWxSession: () => true },
      registryFile: () => bound.registryFile,
    });
    bound.clock.now += 23 * HOUR_MS;
    assert.equal(await boundReborn.sweepMaintenanceOnce(), 0, '绑定不符的信号不得作为进场参考');
    const plan = boundReborn.getHelpStatus(baseAccount()).plan;
    assert.equal(plan.recentMobileActivityAvailable, false);
    assert.equal(plan.recentMobileActivityAt, 0, '错绑信号不得在状态里展示时间戳');
  }
});

test('扫码/轮换/重启本身不是进场信号；信号晚到会在下一轮补上一次', async () => {
  const h = harness();
  await enableBark(h);
  await acceptScan(h);
  h.clock.now += 23 * HOUR_MS;
  assert.equal(await h.service.sweepMaintenanceOnce(), 0, '真实扫码与 token 轮换都不产生信号');
  h.accountList[0] = baseAccount({ refreshtoken: 'rotated', wxCredentialLastSuccessAt: h.clock.now });
  assert.equal(await h.service.sweepMaintenanceOnce(), 0, '凭据健康滚动也不是信号');

  await h.service.noteOtherTerminalLogin('101');
  assert.equal(await h.service.sweepMaintenanceOnce(), 1, '信号晚到：下一轮补发恰好一次');
});

test('反例1回归：声明排队期间 autoLogin=false 必须拦下且不消耗唯一声明', async () => {
  const h = harness();
  await enableBark(h);
  await acceptScan(h);
  await h.service.noteOtherTerminalLogin('101');
  h.clock.now += 23 * HOUR_MS;
  // 同一栈内：巡检入口判定通过后、声明落盘前暂停账号。
  const sweeping = h.service.sweepMaintenanceOnce();
  h.accountList[0].autoLogin = false;
  await sweeping;
  assert.equal(h.sent.length, 0, '排队期间暂停不得外发');
  assert.equal(JSON.parse(fs.readFileSync(h.registryFile, 'utf8')).advanceNotices['101'], undefined,
    '被拦下的判定不得消耗唯一一次声明');
  h.accountList[0].autoLogin = true;
  assert.equal(await h.service.sweepMaintenanceOnce(), 1, '恢复后仍可发那一次');
});

test('反例2回归：声明排队期间账号对象 wxid 被改，旧/新绑定都不得收旧计划提醒', async () => {
  const h = harness();
  await enableBark(h);
  await acceptScan(h);
  await h.service.noteOtherTerminalLogin('101');
  h.clock.now += 23 * HOUR_MS;
  const sweeping = h.service.sweepMaintenanceOnce();
  h.accountList[0].wxid = 'openid-REBOUND';
  await sweeping;
  assert.equal(h.sent.length, 0, '换绑后的账号不得收到按旧绑定计算的提醒');
  assert.equal(JSON.parse(fs.readFileSync(h.registryFile, 'utf8')).advanceNotices['101'], undefined,
    '不得消耗任何绑定的唯一声明');
  h.accountList[0].wxid = 'openid-A';
  assert.equal(await h.service.sweepMaintenanceOnce(), 1);
});

test('反例3回归：声明排队前禁用 Bark 必须拦下且不消耗声明；改参数按最新值判定', async () => {
  const h = harness();
  await enableBark(h);
  await acceptScan(h);
  await h.service.noteOtherTerminalLogin('101');
  h.clock.now += 23 * HOUR_MS;
  // setUserConfig 先入队（禁用），巡检声明后入队：声明必须读到禁用后的配置。
  const disabling = h.service.setUserConfig('owner1', { enabled: false });
  const sweeping = h.service.sweepMaintenanceOnce();
  await Promise.all([disabling, sweeping]);
  assert.equal(h.sent.length, 0, '排队在声明前的禁用必须生效');
  assert.equal(JSON.parse(fs.readFileSync(h.registryFile, 'utf8')).advanceNotices['101'], undefined,
    '禁用拦截不得消耗声明');

  // 重新启用 + 提前量改小（30min：23h 处尚未进入窗口）：仍不发。
  await enableBark(h, 'owner1', { advanceMinutes: 30 });
  assert.equal(await h.service.sweepMaintenanceOnce(), 0, '提前量改小后窗口未到');
  // 改回 60min：23h 处立即进入窗口，发出那一次。
  await enableBark(h, 'owner1', { advanceMinutes: 60 });
  assert.equal(await h.service.sweepMaintenanceOnce(), 1);
});

test('反例4回归：缺原生微信身份（wxid 为空）没有计划，也不记录信号', async () => {
  const h = harness({ accounts: [baseAccount({ wxid: '' })] });
  await enableBark(h);
  await acceptScan(h); // 基线仍可记录（兼容），但不构成有效计划
  assert.equal(await h.service.noteOtherTerminalLogin('101'), false, '空 wxid 不记录信号');
  h.clock.now += 25 * HOUR_MS;
  assert.equal(await h.service.sweepMaintenanceOnce(), 0);
  const plan = h.service.getHelpStatus(h.accountList[0]).plan;
  assert.equal(plan.available, false);
  assert.equal(plan.recentMobileActivityAvailable, false);
});

test('反例5回归：有效扫码+最近信号时 pauseReason 必须清空（不得残留等待扫码）', async () => {
  const h = harness();
  await enableBark(h);
  await acceptScan(h);
  await h.service.noteOtherTerminalLogin('101');
  const plan = h.service.getHelpStatus(h.accountList[0]).plan;
  assert.equal(plan.waitingForScan, false);
  assert.equal(plan.pauseReason, '', `有效计划不得显示等待扫码: ${plan.pauseReason}`);
  assert.equal(plan.acceptedScanAt > 0, true);
  assert.equal(plan.maintenanceAt - plan.acceptedScanAt, DAY_MS);
  assert.equal(plan.reminderAt, plan.maintenanceAt - HOUR_MS);
  assert.equal(typeof plan.remainingMs, 'number');
});

test('没有真实扫码基线：不制造历史时间戳，跳过且提示完成下一次扫码', async () => {
  const h = harness();
  await enableBark(h);
  await h.service.noteOtherTerminalLogin('101');
  h.clock.now += 30 * HOUR_MS;
  assert.equal(await h.service.sweepMaintenanceOnce(), 0);
  const plan = h.service.getHelpStatus(h.accountList[0]).plan;
  assert.equal(plan.available, false);
  assert.equal(plan.waitingForScan, true);
  assert.equal(plan.acceptedScanAt, 0);
  assert.ok(plan.pauseReason.includes('下一次扫码'));
  const persisted = JSON.parse(fs.readFileSync(h.registryFile, 'utf8'));
  assert.equal(persisted.acceptedScans['101'], undefined, '绝不落盘推断的扫码时间');
});

test('未来时间戳的扫码基线视为脏数据：不构成计划也不外发', async () => {
  const h = harness();
  await enableBark(h);
  await h.service.noteOtherTerminalLogin('101');
  fs.writeFileSync(h.registryFile, JSON.stringify({
    users: {}, generations: { 101: 1 },
    incidents: {},
    acceptedScans: { 101: { at: h.clock.now + DAY_MS, generation: 1, owner: 'owner1', wxid: 'openid-A' } },
    advanceNotices: {}, otherTerminalLogins: { 101: { at: h.clock.now - HOUR_MS, owner: 'owner1', wxid: 'openid-A' } },
  }));
  const reborn = serviceModule.createWxLoginReminderService({
    getAccounts: () => ({ accounts: [baseAccount()] }),
    log: () => {}, fetchImpl: mkFetch(h.sent), now: () => h.clock.now,
    adapter: { getQRCode: async () => { throw new Error('不得触达'); }, cancelWxSession: () => true },
    registryFile: () => h.registryFile,
  });
  assert.equal(await reborn.sweepMaintenanceOnce(), 0);
  assert.equal(reborn.getHelpStatus(baseAccount()).plan.available, false);
});

test('注册表损坏/写失败 fail closed：读取容错但零外发；权限 0600/0700', async () => {
  const corrupt = harness();
  await enableBark(corrupt);
  await acceptScan(corrupt);
  await corrupt.service.noteOtherTerminalLogin('101');
  corrupt.clock.now += 23 * HOUR_MS;
  fs.writeFileSync(corrupt.registryFile, '{corrupt json');
  const reborn = serviceModule.createWxLoginReminderService({
    getAccounts: () => ({ accounts: [baseAccount()] }),
    log: () => {}, fetchImpl: mkFetch(corrupt.sent), now: () => corrupt.clock.now,
    adapter: { getQRCode: async () => { throw new Error('不得触达'); }, cancelWxSession: () => true },
    registryFile: () => corrupt.registryFile,
  });
  assert.equal(await reborn.sweepMaintenanceOnce(), 0, '损坏注册表零外发');

  // 写失败：注册表路径指到无法创建的位置。
  const blockedDir = path.join(corrupt.dataDir, 'not-a-dir');
  fs.writeFileSync(blockedDir, 'x');
  const unwritable = serviceModule.createWxLoginReminderService({
    getAccounts: () => ({ accounts: [baseAccount()] }),
    log: () => {}, fetchImpl: mkFetch(corrupt.sent), now: () => corrupt.clock.now,
    adapter: { getQRCode: async () => { throw new Error('不得触达'); }, cancelWxSession: () => true },
    registryFile: () => path.join(blockedDir, 'sub', 'wx-login-reminder.json'),
  });
  await unwritable.setUserConfig('owner1', { enabled: true, deviceKey: 'k', serverUrl: 'https://panel.example.com' })
    .catch(() => {});
  assert.equal(await unwritable.sweepMaintenanceOnce(), 0, '写失败零外发');

  // 私有权限：正常路径上的注册表文件 0600、目录 0700。
  const perm = harness();
  await perm.service.setUserConfig('owner1', { enabled: true, deviceKey: 'k', serverUrl: 'https://panel.example.com' });
  assert.equal(fs.statSync(perm.registryFile).mode & 0o777, 0o600, '注册表文件必须 0600');
  assert.equal(fs.statSync(perm.dataDir).mode & 0o777, 0o700, '数据目录必须 0700');
});

test('属主/微信/删除/暂停围栏：换绑或删除账号零外发，暂停账号不打扰', async () => {
  const h = harness();
  await enableBark(h);
  await acceptScan(h);
  await h.service.noteOtherTerminalLogin('101');

  h.accountList[0] = baseAccount({ username: 'someone-else' });
  h.clock.now += 23 * HOUR_MS;
  assert.equal(await h.service.sweepMaintenanceOnce(), 0, '换属主：旧计划失效');

  h.accountList[0] = baseAccount({ wxid: 'openid-B' });
  assert.equal(await h.service.sweepMaintenanceOnce(), 0, '换微信：旧计划失效');

  h.accountList[0] = baseAccount({ autoLogin: false });
  assert.equal(await h.service.sweepMaintenanceOnce(), 0, '用户明确暂停（不登录）不打扰');

  h.accountList[0] = null;
  assert.equal(await h.service.sweepMaintenanceOnce(), 0, '账号删除后跳过');
});

test('健康轮换不重置计划；真实新扫码重置计划且是唯一重新武装方式', async () => {
  const h = harness();
  await enableBark(h);
  await acceptScan(h);
  await h.service.noteOtherTerminalLogin('101');
  h.clock.now += 23 * HOUR_MS;
  assert.equal(await h.service.sweepMaintenanceOnce(), 1);

  // 已提醒后改配置（启用状态来回切 / 改提前量 / 改周期）都不得重新武装。
  await enableBark(h, 'owner1', { advanceEnabled: false });
  await enableBark(h, 'owner1', { advanceEnabled: true, advanceMinutes: 5 });
  await enableBark(h, 'owner1', { maintenanceCycleHours: 4 });
  assert.equal(await h.service.sweepMaintenanceOnce(), 0, '改配置不得重新武装已用过的声明');
  const persisted = JSON.parse(fs.readFileSync(h.registryFile, 'utf8'));
  assert.equal(persisted.acceptedScans['101'].at > 0, true, '改配置不得伪造扫码时间');

  // 真实新扫码：计划重置、声明清空、兼容绑定的进场信号保留真实旧时间戳。
  const signalAt = h.clock.now;
  await h.service.noteOtherTerminalLogin('101'); // 把信号刷新到当前时刻
  h.clock.now += 5 * HOUR_MS;
  await h.service.noteAcceptedScan('101');
  const after = JSON.parse(fs.readFileSync(h.registryFile, 'utf8'));
  assert.equal(after.advanceNotices['101'], undefined, '新扫码清空提前声明');
  assert.equal(after.otherTerminalLogins['101'].at, signalAt, '新扫码不改写进场信号时间戳');
  await h.service.noteOtherTerminalLogin('101');
  h.clock.now += 23 * HOUR_MS;
  assert.equal(await h.service.sweepMaintenanceOnce(), 1, '新代次可再提醒一次');
  assert.equal(await h.service.sweepMaintenanceOnce(), 0);
});

test('两种模式每代次合计一条：提前→终态只补 needsRescan 不二发；终态→提前零补充', async () => {
  // 提前已发 → 实际失效：needsRescan 如实更新，但不再发第二条。
  const h = harness();
  await enableBark(h);
  await acceptScan(h);
  await h.service.noteOtherTerminalLogin('101');
  h.clock.now += 23 * HOUR_MS;
  await h.service.sweepMaintenanceOnce();
  assert.equal(await h.service.noteCredentialInvalid('101'), false, '提前已认领：终态不外发');
  assert.equal(h.sent.length, 1);
  const incident = h.service.getIncident('101');
  assert.equal(incident.needsRescan, true, '失效事实必须如实记录');
  assert.equal(incident.sentAt, 0);
  // 启用补发也不得越过（claimed）。
  assert.deepEqual(await h.service.dispatchPendingForUser('owner1'), []);

  // 反向：终态先发（唯一一条），到期巡检零补充。
  const h2 = harness();
  await enableBark(h2);
  await acceptScan(h2);
  await h2.service.noteOtherTerminalLogin('101');
  assert.equal(await h2.service.noteCredentialInvalid('101'), true);
  assert.equal(h2.sent.length, 1);
  h2.clock.now += 25 * HOUR_MS;
  assert.equal(await h2.service.sweepMaintenanceOnce(), 0, '终态已认领：不再发参考提醒');
  assert.ok(JSON.parse(fs.readFileSync(h2.registryFile, 'utf8')).advanceNotices === undefined
    || JSON.parse(fs.readFileSync(h2.registryFile, 'utf8')).advanceNotices['101'] === undefined,
  '不得为已失效代次落提前声明');

  // 无提前声明（未启用/无基线/无信号）时终态兜底照旧一条。
  const h3 = harness();
  await enableBark(h3);
  assert.equal(await h3.service.noteCredentialInvalid('101'), true);
  assert.equal(h3.sent.length, 1);
});

test('其他终端登录信号：QQ/未知账号忽略；迟到旧信号不回拨；跨重启持久', async () => {
  const h = harness({ accounts: [
    baseAccount(),
    baseAccount({ id: '102', name: 'QQ号', platform: 'qq', wxid: '' }),
  ] });
  assert.equal(await h.service.noteOtherTerminalLogin('102'), false, 'QQ 账号不记录');
  assert.equal(await h.service.noteOtherTerminalLogin('404'), false, '未知账号不记录');
  assert.equal(await h.service.noteOtherTerminalLogin('101'), true);

  const firstAt = h.clock.now;
  h.clock.now += 2 * HOUR_MS;
  const secondAt = h.clock.now;
  assert.equal(await h.service.noteOtherTerminalLogin('101'), true);
  h.clock.now = firstAt; // 时钟回拨后再来一次旧信号
  assert.equal(await h.service.noteOtherTerminalLogin('101'), false, '迟到旧信号不得回拨最新值');
  const persisted = JSON.parse(fs.readFileSync(h.registryFile, 'utf8'));
  assert.equal(persisted.otherTerminalLogins['101'].at, secondAt);
  assert.equal(persisted.otherTerminalLogins['101'].owner, 'owner1');
  assert.equal(persisted.otherTerminalLogins['101'].wxid, 'openid-A');

  // 换绑后的新扫码丢弃不兼容信号。
  h.clock.now = secondAt;
  h.accountList[0] = baseAccount({ wxid: 'openid-NEW' });
  await h.service.noteAcceptedScan('101');
  const after = JSON.parse(fs.readFileSync(h.registryFile, 'utf8'));
  assert.equal(after.otherTerminalLogins['101'], undefined, '换微信后旧信号不属于新绑定');
});

test('巡检定时器生命周期：默认 60s、unref、双启动幂等、停止后可再启动', async () => {
  const handles = [];
  const timers = {
    setInterval: (fn, ms) => {
      const handle = { fn, ms, unrefed: false, cleared: false, unref() { this.unrefed = true; } };
      handles.push(handle);
      return handle;
    },
    clearInterval: handle => { handle.cleared = true; },
  };
  const h = harness({ serviceDeps: { timers } });
  assert.equal(h.service.startMaintenanceSweep(), true);
  assert.equal(handles.length, 1);
  assert.equal(handles[0].ms, 60_000, '默认巡检间隔 60s');
  assert.equal(handles[0].unrefed, true, '定时器必须 unref（不阻塞进程退出）');
  assert.equal(h.service.startMaintenanceSweep(), false, '重复启动不得开出第二个定时器');
  await handles[0].fn();
  assert.equal(h.service.stopMaintenanceSweep(), true);
  assert.equal(handles[0].cleared, true);
  assert.equal(h.service.stopMaintenanceSweep(), false);
  assert.equal(h.service.startMaintenanceSweep(), true, '停止后可再次启动');
  h.service.stopMaintenanceSweep();
});

test('巡检自身异常绝不冒泡：getAccounts 抛错时单轮安全返回', async () => {
  const h = harness();
  let broken = true;
  const service = serviceModule.createWxLoginReminderService({
    getAccounts: () => {
      if (broken) throw new Error('accounts store exploded');
      return { accounts: [] };
    },
    log: () => {}, fetchImpl: mkFetch(h.sent), now: () => h.clock.now,
    adapter: { getQRCode: async () => { throw new Error('不得触达'); }, cancelWxSession: () => true },
    registryFile: () => h.registryFile,
  });
  const handles = [];
  const timers = {
    setInterval: (fn, ms) => {
      const handle = { fn, ms, unref() {} };
      handles.push(handle);
      return handle;
    },
    clearInterval: () => {},
  };
  const guarded = serviceModule.createWxLoginReminderService({
    getAccounts: () => { throw new Error('boom'); },
    log: () => {}, fetchImpl: mkFetch(h.sent), now: () => h.clock.now,
    adapter: { getQRCode: async () => { throw new Error('不得触达'); }, cancelWxSession: () => true },
    registryFile: () => h.registryFile,
    timers,
  });
  assert.equal(await service.sweepMaintenanceOnce(), 0, '单轮巡检安全返回');
  assert.equal(guarded.startMaintenanceSweep(), true, '启动路径不因 getAccounts 抛错崩溃');
  await handles[0].fn();
  broken = false;
});

test('runtime 引擎真实接线：start 启巡检、stopAllAccounts 停止、踢下线原因精确路由', async () => {
  const calls = { start: 0, stop: 0, other: [] };
  const stub = {
    startMaintenanceSweep: () => { calls.start += 1; return true; },
    stopMaintenanceSweep: () => { calls.stop += 1; return true; },
    noteOtherTerminalLogin: (accountId) => {
      calls.other.push(String(accountId));
      return Promise.resolve(true);
    },
    shouldSuppressOfflineReminder: () => false,
    noteCredentialInvalid: () => Promise.resolve(false),
    needsRescan: () => false,
  };
  // 必须在加载 runtime-engine 前替换共享服务（引擎在模块加载时解构绑定）。
  const original = serviceModule.getSharedWxLoginReminder;
  serviceModule.getSharedWxLoginReminder = () => stub;
  let engine = null;
  try {
    const { createRuntimeEngine } = require('../src/runtime/runtime-engine');
    engine = createRuntimeEngine({
      processRef: process,
      startAdminServer: () => {},
      onLog: () => {},
      onAccountLog: () => {},
    });
    await engine.start({ startAdminServer: false, autoStartAccounts: true });
    assert.equal(calls.start, 1, 'engine.start 必须启动本地巡检（3915f1f 旧行为为 0，本断言即基线）');

    // 只有 kickout_stop 且原因恰为「已在其他终端登录」（仅允许首尾空白）才记录。
    engine.runtimeEvents.emit('account_log', { action: 'kickout_stop', accountId: '901', reason: '已在其他终端登录' });
    engine.runtimeEvents.emit('account_log', { action: 'kickout_stop', accountId: '902', reason: ' 已在其他终端登录 ' });
    engine.runtimeEvents.emit('account_log', { action: 'kickout_stop', accountId: '903', reason: '网络波动下线' });
    engine.runtimeEvents.emit('account_log', { action: 'login', accountId: '904', reason: '已在其他终端登录' });
    engine.runtimeEvents.emit('account_log', { action: 'kickout_stop', accountId: '905', reason: '未知' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.other, ['901', '902'], '只记录精确原因的踢下线信号');

    engine.stopAllAccounts();
    assert.equal(calls.stop, 1, 'stopAllAccounts 必须停止巡检');
  }
  finally {
    serviceModule.getSharedWxLoginReminder = original;
  }
});

test.after(() => {
  // runtime-engine 会创建 worker_manager / auto_code_refresh 调度器：
  // 不清理会留下 watchdog 定时器，进程无法退出（同 wx-online-rescan 先例）。
  createScheduler('worker_manager').clearAll();
  createScheduler('auto_code_refresh').clearAll();
  for (const dir of HARNESS_DIRS) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
  }
  fs.rmSync(RUNTIME_DATA_DIR, { recursive: true, force: true });
});
