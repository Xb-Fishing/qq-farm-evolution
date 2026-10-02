'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 微信登录提醒服务（Bark）单测：主审 5 个已执行反例的回归 +
 * 代次去重 / fail-closed 落盘 / 图片能力吊销 / 守卫化守望。
 * 全部走真实 async 服务与注入的 fetch/adapter，不用同步假件。
 */

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47]), Buffer.alloc(32)]);
const PNG_B64 = PNG_BYTES.toString('base64');

function deferred() {
  let resolve;
  const reject = () => resolve();
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve, reject };
}

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

function harness({ accounts, fetchResults, completeResults = [], completeRescan, clockStart = 1_000_000 } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-wxlr-'));
  const registryFile = path.join(dataDir, 'wx-login-reminder.json');
  const sent = [];
  const logs = [];
  const clock = { now: clockStart };
  const adapterCalls = { qr: 0, cancelled: [], checkQr: [], farmCode: [] };
  const completions = [];
  let qrGate = null; // 非空时 getQRCode 挂起直至放行
  const accountList = accounts || [baseAccount()];
  const adapter = {
    getQRCode: async _owner => {
      adapterCalls.qr += 1;
      if (qrGate) await qrGate.promise;
      const createdAt = clock.now;
      return {
        Success: true,
        Data: {
          Uuid: `sess-${adapterCalls.qr}`,
          QrBase64: PNG_B64,
          CreatedAt: createdAt,
          ExpiresAt: createdAt + 300_000,
        },
      };
    },
    checkQR: async (sessionId, owner) => {
      adapterCalls.checkQr.push({ sessionId, owner });
      return { Success: true, Data: { status: 0 } };
    },
    cancelWxSession: (sessionId, owner) => {
      adapterCalls.cancelled.push({ sessionId, owner });
      return true;
    },
    getWxSessionInfo: () => null,
  };
  const defaultCompleteRescan = async (opts) => {
    completions.push(opts);
    if (typeof opts.isCurrent === 'function' && !opts.isCurrent()) {
      return { ok: false, superseded: true };
    }
    return completeResults.shift() || { ok: true, started: true };
  };
  const service = require('../src/services/wx-login-reminder').createWxLoginReminderService({
    getAccounts: () => ({ accounts: accountList.filter(Boolean) }),
    log: (level, message, extra) => logs.push({ level, message, extra }),
    addAccountLog: () => {},
    fetchImpl: mkFetch(sent, fetchResults),
    now: () => clock.now,
    watcherPollMs: 5,
    adapter,
    completeRescan: completeRescan || defaultCompleteRescan,
    registryFile: () => registryFile,
  });
  return {
    dataDir, registryFile, service, sent, logs, clock, adapterCalls, completions,
    accountList, adapter,
    setQrGate: gate => { qrGate = gate; },
  };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return predicate();
}

async function enableBark(h, owner = 'owner1', overrides = {}) {
  await h.service.setUserConfig(owner, {
    enabled: true,
    deviceKey: 'device-key-of-owner',
    serverUrl: 'https://panel.example.com',
    ...overrides,
  });
}

test('反例1回归：注册表落盘失败绝不外发（fail closed）', async () => {
  const h = harness();
  // 把注册表路径指到一个无法创建的位置：写声明必然失败。
  const blocker = path.join(h.dataDir, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const broken = require('../src/services/wx-login-reminder').createWxLoginReminderService({
    getAccounts: () => ({ accounts: [baseAccount()] }),
    log: () => {},
    fetchImpl: mkFetch(h.sent),
    registryFile: () => path.join(blocker, 'sub', 'wx-login-reminder.json'),
  });
  await enableBark(h);
  const result = await broken.noteCredentialInvalid('101');
  assert.equal(result, false);
  assert.equal(h.sent.length, 0, '声明落不下来就一条都不能外发');
  // 健康路径对照：同一账号正常注册表可以外发。
  const ok = await h.service.noteCredentialInvalid('101');
  assert.equal(ok, true);
  assert.equal(h.sent.length, 1);
  assert.equal(h.service.getIncident('101').lastError, '', '成功提醒不得被展示为发送失败');
});

test('反例1回归：损坏的注册表进入阻断态，读取容错但外发为零', async () => {
  const h = harness();
  fs.writeFileSync(h.registryFile, '{corrupt json');
  const strict = require('../src/services/wx-login-reminder').createWxLoginReminderService({
    getAccounts: () => ({ accounts: [baseAccount()] }),
    log: () => {},
    fetchImpl: mkFetch(h.sent),
    registryFile: () => h.registryFile,
  });
  await assert.rejects(strict.setUserConfig('owner1', { enabled: true }), /REGISTRY_UNAVAILABLE/);
  assert.equal(await strict.noteCredentialInvalid('101'), false);
  assert.equal(h.sent.length, 0);
});

test('一代次只发一条：并发/重复/重启/发送失败都不补发', async () => {
  const h = harness();
  await enableBark(h);
  await Promise.all([
    h.service.noteCredentialInvalid('101'),
    h.service.noteCredentialInvalid('101'),
    h.service.noteCredentialInvalid('101'),
  ]);
  await h.service.noteCredentialInvalid('101');
  assert.equal(h.sent.length, 1, '并发与重复只允许一次外发');

  // 进程“重启”：同一注册表文件上的新实例。
  const reborn = require('../src/services/wx-login-reminder').createWxLoginReminderService({
    getAccounts: () => ({ accounts: [baseAccount()] }),
    log: () => {}, fetchImpl: mkFetch(h.sent), registryFile: () => h.registryFile,
  });
  await reborn.noteCredentialInvalid('101');
  assert.equal(h.sent.length, 1, '重启后同代次不补发');

  // token 轮换 / 改备注 / 到期时间变化都不是新扫码，不得重新武装。
  h.accountList[0] = baseAccount({ refreshtoken: 'rotated', name: '农场号A2', wxCredentialExpiresAt: 1 });
  await h.service.noteCredentialInvalid('101');
  assert.equal(h.sent.length, 1, '轮换/改名不重新提醒');

  // 新扫码被接受后，下一次失效允许再提醒。
  await h.service.noteAcceptedScan('101');
  h.accountList[0] = baseAccount({ refreshtoken: 'fresh-token' });
  await h.service.noteCredentialInvalid('101');
  assert.equal(h.sent.length, 2, '接受新扫码后新一代次可再提醒');
});

test('发送失败保留声明不风暴，lastError 落盘且不含密钥', async () => {
  const h = harness({ fetchResults: [{ ok: false, status: 502, json: {} }] });
  await enableBark(h);
  await h.service.noteCredentialInvalid('101');
  await h.service.noteCredentialInvalid('101');
  assert.equal(h.sent.length, 1);
  const incident = h.service.getIncident('101');
  assert.equal(incident.needsRescan, true);
  assert.equal(incident.sentAt, 0, '失败不算送达');
  assert.ok(incident.lastError.length > 0);
  const persisted = JSON.parse(fs.readFileSync(h.registryFile, 'utf8'));
  assert.ok(!String(persisted.incidents['101'].lastError).includes('device-key-of-owner'),
    '事件记录不得携带设备 Key');
});

test('未启用/缺 Key 只记 needsRescan；启用后补发一次', async () => {
  const h = harness();
  await h.service.noteCredentialInvalid('101');
  assert.equal(h.sent.length, 0);
  assert.equal(h.service.getIncident('101').needsRescan, true);

  await enableBark(h);
  const dispatched = await h.service.dispatchPendingForUser('owner1');
  assert.deepEqual(dispatched, ['101']);
  assert.equal(h.sent.length, 1, '启用后补发且仅一条');
  await h.service.dispatchPendingForUser('owner1');
  assert.equal(h.sent.length, 1);
});

test('配置按用户隔离；日志不泄漏设备 Key；文件 0600/目录 0700', async () => {
  const h = harness();
  await h.service.setUserConfig('owner1', { enabled: true, deviceKey: 'key-A', serverUrl: 'https://a.example.com' });
  await h.service.setUserConfig('owner2', { enabled: false, deviceKey: 'key-B' });
  assert.equal(h.service.getUserConfig('owner1').deviceKey, 'key-A');
  assert.equal(h.service.getUserConfig('owner2').deviceKey, 'key-B');
  assert.equal(h.service.getUserConfig('owner2').serverUrl, '');

  await h.service.noteCredentialInvalid('101'); // owner1
  h.accountList[0] = baseAccount({ id: '102', username: 'owner2' });
  await h.service.noteCredentialInvalid('102');
  for (const entry of h.logs) {
    assert.ok(!JSON.stringify(entry).includes('key-A') && !JSON.stringify(entry).includes('key-B'), '日志不得携带设备 Key');
  }
  assert.equal(h.sent.length, 1, '只有启用的 owner1 收到推送');
  assert.equal(JSON.parse(h.sent[0].init.body).device_key, 'key-A');

  const mode = fs.statSync(h.registryFile).mode & 0o777;
  assert.equal(mode, 0o600, '注册表文件必须 0600');
  assert.equal(fs.statSync(h.dataDir).mode & 0o777, 0o700, '数据目录必须 0700');
});

test('Bark 严格校验：HTTP/厂商 code/非 JSON/超时；粘贴完整链接可解析目标', async () => {
  const h = harness();
  const { parseBarkTarget } = require('../src/services/wx-login-reminder');
  const target = parseBarkTarget('https://bark.selfhost.cn/abc123KEY/标题/内容', '');
  assert.deepEqual(target, { server: 'https://bark.selfhost.cn', key: 'abc123KEY' });

  const noKey = await h.service.sendBark({ deviceKey: '', barkServer: 'https://api.day.app' }, { body: 'x' });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.error.includes('Key'), true);

  const failing = harness({ fetchResults: [
    { ok: true, status: 200, json: { code: 400 } },
    { ok: true, status: 200, json: 'not-json' },
  ] });
  const r1 = await failing.service.sendBark({ deviceKey: 'k' }, { body: 'x' });
  assert.equal(r1.ok, false, '厂商 code!=200 必须判失败');
  const r2 = await failing.service.sendBark({ deviceKey: 'k' }, { body: 'x' });
  assert.equal(r2.ok, false, '非 JSON 响必须判失败');

  const hanging = harness();
  const stalled = require('../src/services/wx-login-reminder').createWxLoginReminderService({
    getAccounts: () => ({ accounts: [] }), log: () => {},
    // 挂起但尊重 abort 信号：超时只能由 AbortController 兜底（真实 fetch 语义）。
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
    registryFile: () => path.join(hanging.dataDir, 'r.json'),
  });
  const result = await Promise.race([
    stalled.sendBark({ deviceKey: 'k' }, { body: 'x' }),
    new Promise((resolve, reject) =>
      setTimeout(() => reject(new Error('发送无界：AbortController 超时未生效')), 11_500)),
  ]);
  assert.deepEqual(result, { ok: false, error: 'Bark 发送超时' }, '超时必须有界且归因为超时');
});

test('反例3回归：图片能力绑定账号存在性/属主/wxid/代次', async () => {
  const h = harness();
  await enableBark(h);
  const result = await h.service.requestQrPush({ account: h.accountList[0] });
  assert.equal(result.pushed, true);
  assert.ok(h.sent[0].init.body.includes('"image":"https://panel.example.com/api/wx-login-qr-image/'));
  const token = result.imageToken;
  assert.ok(h.service.getQrImage(token), '有效令牌返回 PNG');

  // 账号被删除：令牌立即整体吊销（410 语义）。
  h.accountList[0] = null;
  assert.equal(h.service.getQrImage(token), null, '账号删除后不得再吐图');
  h.accountList[0] = baseAccount();
  const token2 = (await h.service.requestQrPush({ account: h.accountList[0] })).imageToken;
  // 换属主 / 换微信 / 新扫码代次：全部吊销。
  h.accountList[0] = baseAccount({ username: 'someone-else' });
  assert.equal(h.service.getQrImage(token2), null, '换属主吊销');
  h.accountList[0] = baseAccount({ wxid: 'openid-B' });
  assert.equal(h.service.getQrImage(token2), null, '换微信吊销');
  h.accountList[0] = baseAccount();
  const token3 = (await h.service.requestQrPush({ account: h.accountList[0] })).imageToken;
  await h.service.noteAcceptedScan('101');
  assert.equal(h.service.getQrImage(token3), null, '新扫码代次吊销旧图');
  // 本地会话到期后同样视为吊销。
  const token4 = (await h.service.requestQrPush({ account: h.accountList[0] })).imageToken;
  h.clock.now += 300_001;
  assert.equal(h.service.getQrImage(token4), null, '过期吊销');
});

test('反例2回归：getQRCode 等待期间新扫码被接受，迟到二维码不得发送/占位', async () => {
  const h = harness();
  await enableBark(h);
  const gate = deferred();
  h.setQrGate(gate);
  const pending = h.service.requestQrPush({ account: h.accountList[0] });
  await new Promise(resolve => setImmediate(resolve));
  await h.service.noteAcceptedScan('101'); // 等待期间：面板保存了新扫码
  gate.resolve();
  const result = await pending;
  assert.equal(result.superseded, true, '迟到请求必须自判被取代');
  assert.deepEqual(h.adapterCalls.cancelled, [{ sessionId: 'sess-1', owner: 'owner1' }], '迟到二维码的本地会话要取消');
  assert.equal(h.sent.length, 0, '不得外发任何推送');
  assert.equal(h.service.getPendingSession('101'), null, '不得覆盖/保留为新状态');
});

test('新的显式发送先立即取代旧会话（不等新二维码返回）', async () => {
  const h = harness();
  await enableBark(h);
  const first = await h.service.requestQrPush({ account: h.accountList[0] });
  const gate = deferred();
  h.setQrGate(gate);
  const second = h.service.requestQrPush({ account: h.accountList[0] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.service.getPendingSession('101'), null, '旧 pending 已即时清除');
  assert.equal(h.service.getQrImage(first.imageToken), null, '旧图片能力已吊销');
  assert.deepEqual(h.adapterCalls.cancelled, [{ sessionId: 'sess-1', owner: 'owner1' }], '旧 adapter 会话已取消');
  gate.resolve();
  const result = await second;
  assert.equal(result.session.sessionId, 'sess-2');
});

test('并发点击合并为一次请求；重复点击各自成功但不风暴', async () => {
  const h = harness();
  await enableBark(h);
  const gate = deferred();
  h.setQrGate(gate);
  const p1 = h.service.requestQrPush({ account: h.accountList[0] });
  const p2 = h.service.requestQrPush({ account: h.accountList[0] });
  gate.resolve();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, r2, '同一账号并发请求必须合并为同一 Promise 结果');
  assert.equal(h.adapterCalls.qr, 1);
});

test('守望：扫码→确认→守卫化保存→saved；浏览器关闭不中断', async () => {
  const h = harness();
  await enableBark(h);
  const script = [
    { Success: true, Data: { status: 0 } },
    { Success: true, Data: { status: 1 } },
    { Success: true, Data: { acctSectResp: { userName: 'openid-A' } } },
  ];
  let cursor = 0;
  h.adapter.checkQR = async () => script[Math.min(cursor++, script.length - 1)];
  await h.service.requestQrPush({ account: h.accountList[0] });
  assert.ok(await waitFor(() => h.service.getPendingSession('101')?.state === 'saved'),
    '服务端守望应完成扫码并进入 saved');
  assert.equal(h.completions.length, 1);
  assert.equal(h.completions[0].openid, 'openid-A');
  assert.equal(h.completions[0].owner, 'owner1');
  assert.equal(typeof h.completions[0].isCurrent, 'function', '保存链必须拿到 isCurrent 守卫');
  // 保存后守望停止：不再有新的轮询增长。
  const polls = h.adapterCalls.checkQr.length;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.adapterCalls.checkQr.length, polls, '终态后守望必须停止轮询');
});

test('noteAcceptedScan(keepSessionId)：自身完成保留 saved 状态并推进代次；外来扫码立即取代', async () => {
  const h = harness();
  await enableBark(h);
  const first = await h.service.requestQrPush({ account: h.accountList[0] });
  const sessionId = first.session.sessionId;
  // 自身保存链的完成：保留 pending（状态.saved）+ 代次推进 + 图片令牌按代次吊销。
  await h.service.noteAcceptedScan('101', { keepSessionId: sessionId });
  const kept = h.service.getPendingSession('101');
  assert.ok(kept, '自身完成不得清掉自己的 pending（保存链还要继续启动账号）');
  assert.equal(kept.state, 'saved');
  assert.equal(kept.sessionId, sessionId);
  // 代次已推进：同一账号的旧失效事件不得再命中（getIncident 已清）。
  assert.equal(h.service.getIncident('101'), null);
  assert.equal(h.service.getQrImage(first.imageToken), null, '代次推进后旧图片令牌按绑定检查吊销');
  // 同账号再次失效 → 新代次允许重新提醒（外部代次推进证据）；
  // 终态失效提醒到点即推送一张二维码（sess-2）。
  await h.service.noteCredentialInvalid('101');
  assert.equal(h.service.getIncident('101').needsRescan, true);

  // 外来/面板已接受的扫码：立即取代旧会话（不等注册表落盘）。
  const second = await h.service.requestQrPush({ account: h.accountList[0] });
  assert.equal(second.session.sessionId, 'sess-3', '终态提醒已生成过 sess-2，手动重发是新会话');
  await h.service.noteAcceptedScan('101');
  assert.equal(h.service.getPendingSession('101'), null, '外来已接受扫码必须清空旧 pending');
  assert.equal(h.service.getQrImage(second.imageToken), null);
});

test('守望被更新的扫码取代：守卫失败不得改写新状态', async () => {
  const gate = deferred();
  let authorized = false;
  // 保存链挂起：期间发生新的已接受扫码。单实例守卫（生产是共享单例）。
  const h = harness({
    completeRescan: async opts => {
      await gate.promise;
      return opts.isCurrent() ? { ok: true, started: true } : { ok: false, superseded: true };
    },
  });
  await enableBark(h);
  h.adapter.checkQR = async () => {
    if (!authorized) {
      authorized = true;
      return { Success: true, Data: { acctSectResp: { userName: 'openid-A' } } };
    }
    return { Success: true, Data: { status: 0 } };
  };
  await h.service.requestQrPush({ account: h.accountList[0] });
  assert.ok(await waitFor(() => authorized), '守望应发起首次轮询并拿到授权');
  await new Promise(resolve => setImmediate(resolve));
  await h.service.noteAcceptedScan('101'); // 保存挂起期间：新扫码被接受
  gate.resolve();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.service.getPendingSession('101'), null,
    '新扫码已清空旧 pending；旧守望不得写入任何 saved/error 状态');
});

test('守望换码临时失败 → confirmed_retry（无自动重试循环），显式重试后完成', async () => {
  const h = harness({ completeResults: [
    { ok: false, retryable: true, error: '换取农场码失败: 网络波动' },
    { ok: true, started: true },
  ] });
  await enableBark(h);
  let authorized = false;
  h.adapter.checkQR = async () => {
    if (!authorized) {
      authorized = true;
      return { Success: true, Data: { acctSectResp: { userName: 'openid-A' } } };
    }
    return { Success: true, Data: { status: 0 } };
  };
  h.adapter.getWxSessionInfo = () => ({
    sessionId: 'sess-1', createdAt: h.clock.now, expiresAt: h.clock.now + 300_000,
    confirmed: true, openid: 'openid-A',
  });
  await h.service.requestQrPush({ account: h.accountList[0] });
  assert.ok(await waitFor(() => h.service.getPendingSession('101')?.state === 'confirmed_retry'),
    '临时换码失败必须停在 confirmed_retry 检查点');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.completions.length, 1, '不得自动循环重试换码');

  const retry = await h.service.retryCompleteLogin(h.accountList[0]);
  assert.equal(retry.ok, true);
  assert.equal(h.completions.length, 2, '显式重试复用同一会话再走一次保存链');
  assert.equal(h.service.getPendingSession('101').state, 'saved');
  // 非可重试状态拒绝重试（不重发二维码、不重放确认）。
  const again = await h.service.retryCompleteLogin(h.accountList[0]);
  assert.equal(again.ok, true, '已保存的会话幂等返回成功');
});

test('守望二维码过期 → expired 终态；轮询有界不越过本地会话截止', async () => {
  const h = harness();
  await enableBark(h);
  h.adapter.checkQR = async () => ({ Success: true, Data: { status: 0 } });
  await h.service.requestQrPush({ account: h.accountList[0] });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.service.getPendingSession('101').state, 'pending');
  h.clock.now += 300_001; // 本地会话到期
  assert.ok(await waitFor(() => h.service.getPendingSession('101')?.state === 'expired'),
    '到期必须收敛为 expired');
  const polls = h.adapterCalls.checkQr.length;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.adapterCalls.checkQr.length, polls, '到期后轮询必须停止（有界）');
});

test.after(() => { /* tmpdirs 由操作系统清理策略处理，无需显式删除 */ });
