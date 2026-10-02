'use strict';

const nodeCrypto = require('node:crypto');
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { getDataFile } = require('../config/runtime-paths');
const logger = require('./logger');

/**
 * 微信登录提醒服务（Bark）。
 *
 * 只在凭据被服务端判定「明确失效」（40188 / 授权范围失效 / -101 凭据拒绝等，
 * 见 wx-login-adapter.isDefinitiveWxCredentialError）时提醒一次；时间流逝、
 * 到期前正常续期、临时网络错误、被踢下线本身都不触发。
 *
 * 去重口径是服务端控制的「扫码代次」（generation）：只有真实接受的新扫码
 * （noteAcceptedScan，来自面板/自助已认证的保存路径）才递增；token 轮换、
 * 改备注、服务重启都不重置。同代次只发一条；外发声明必须先成功落盘，
 * 落盘失败一律不外发（fail closed），发送失败保留声明不风暴。
 *
 * 另含可选「扫码维护参考计划」提前提醒：以真实接受扫码的时刻为基线，
 * 按用户自设周期（默认 24h，可 4..168h）计算参考维护时间，提前量默认
 * 60 分钟。它不是微信官方到期时间（上游凭据 ~2h 滚动续期），也不保证
 * 零断线。发送前置条件：该代次尚未用过唯一一次自动提醒 + 最近 24h 内
 * 观察到「已在其他终端登录」踢下线信号（作为用户手机进场的参考代理，
 * 会漏掉无在线 Bot 时的手机进场，也不能区分另一台 PC）。本地定时巡检
 * 不做任何外部探测、不生成二维码、不改运行中的账号。
 */

const REGISTRY_FILENAME = 'wx-login-reminder.json';
const DEFAULT_BARK_SERVER = 'https://api.day.app';
const BARK_SEND_TIMEOUT_MS = 10 * 1000;
const ADVANCE_SWEEP_INTERVAL_MS = 60 * 1000;
// 「其他终端登录」信号的参考回看窗口（用户指定固定 24h，不随计划周期变化）。
const OTHER_TERMINAL_LOGIN_LOOKBACK_MS = 24 * 3600 * 1000;
// 与 wx-login-adapter 的本地扫码会话期限一致（WX_SESSION_TTL_MS=300s）。
// 这是本地会话截止，不代表微信侧二维码的实际寿命（可能更早失效）。
const LOCAL_SESSION_TTL_MS = 300 * 1000;
const WATCHER_POLL_INTERVAL_MS = 2000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47]);
const SAFE_KEY_RE = /^[\w.:-]{1,128}$/;
// 声明/事件里允许落盘的 lastError 只保留可读短语，绝不含路径、密钥或异常原文。
const SAFE_ERROR_RE = /^[\p{Script=Han}\w ：:，,。.\-()（）=/]{1,160}$/u;

const barkLogger = logger.createModuleLogger('wx-login-reminder');

function sanitizeErrorText(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return SAFE_ERROR_RE.test(text) ? text.slice(0, 160) : '发送失败';
}

function normalizeUserConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const trim = value => (value === undefined || value === null ? '' : String(value).trim());
  return {
    enabled: input.enabled === true,
    barkServer: trim(input.barkServer) || DEFAULT_BARK_SERVER,
    deviceKey: trim(input.deviceKey),
    serverUrl: trim(input.serverUrl).replace(/\/+$/, ''),
    ...normalizeAdvancePlan(input),
  };
}

/**
 * 扫码维护参考计划参数（服务端防御性钳制；路由层另做逐字段校验）：
 * 周期默认 24h（4..168h），提前量默认 60 分钟（>=5 且严格小于周期）。
 */
function normalizeAdvancePlan(input) {
  const cycleRaw = Number(input.maintenanceCycleHours);
  const maintenanceCycleHours = Number.isFinite(cycleRaw) && cycleRaw >= 4 && cycleRaw <= 168
    ? cycleRaw : 24;
  const advanceRaw = Number(input.advanceMinutes);
  const fallbackAdvance = 60;
  let advanceMinutes = Number.isFinite(advanceRaw) ? Math.round(advanceRaw) : fallbackAdvance;
  advanceMinutes = Math.min(Math.max(advanceMinutes, 5), maintenanceCycleHours * 60 - 1);
  return {
    advanceEnabled: input.advanceEnabled !== false,
    maintenanceCycleHours,
    advanceMinutes,
  };
}

/**
 * 设备 Key 输入框允许直接粘贴 Bark App 复制出的完整链接：
 * https://api.day.app/<key>/<标题>/<内容>... 只取服务器与 key，其余丢弃。
 */
function parseBarkTarget(deviceKey, barkServer) {
  const rawKey = String(deviceKey || '').trim();
  if (!rawKey) return { server: String(barkServer || DEFAULT_BARK_SERVER), key: '' };
  if (!/^https?:\/\//i.test(rawKey)) return { server: String(barkServer || DEFAULT_BARK_SERVER), key: rawKey };
  try {
    const url = new URL(rawKey);
    const [key = ''] = url.pathname.replace(/^\/+/, '').split('/');
    return { server: `${url.protocol}//${url.host}`, key: decodeURIComponent(key) };
  } catch {
    return { server: String(barkServer || DEFAULT_BARK_SERVER), key: '' };
  }
}

function isPngBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 8 && buffer.subarray(0, 4).equals(PNG_MAGIC);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function ownSafeEntries(object) {
  return Object.entries(object).filter(([key]) => SAFE_KEY_RE.test(key));
}

function emptyRegistry() {
  return {
    users: {}, generations: {}, incidents: {},
    acceptedScans: {}, advanceNotices: {}, otherTerminalLogins: {},
  };
}

// 可选分区（旧文件缺失视为空）：字段类型非法即整体阻断。
function validateOptionalSections(parsed) {
  const shapes = {
    acceptedScans: value => Number.isInteger(Number(value.at)) && Number(value.at) >= 0
      && Number.isInteger(Number(value.generation)) && Number(value.generation) >= 0
      && typeof value.owner === 'string' && typeof value.wxid === 'string',
    advanceNotices: value => Number.isInteger(Number(value.generation)) && Number(value.generation) >= 0
      && Number.isInteger(Number(value.claimedAt)) && Number(value.claimedAt) >= 0
      && Number.isInteger(Number(value.sentAt)) && Number(value.sentAt) >= 0
      && typeof value.lastError === 'string',
    otherTerminalLogins: value => Number.isInteger(Number(value.at)) && Number(value.at) >= 0
      && typeof value.owner === 'string' && typeof value.wxid === 'string',
  };
  for (const [section, check] of Object.entries(shapes)) {
    if (parsed[section] === undefined) {
      parsed[section] = {};
      continue;
    }
    if (!isPlainObject(parsed[section])) return false;
    for (const [, value] of ownSafeEntries(parsed[section])) {
      if (!isPlainObject(value) || !check(value)) return false;
    }
  }
  return true;
}

/** 读取 + 校验：文件缺失视为空；损坏/结构非法则进入阻断态（宁可不发，不可错发）。 */
function readRegistryStrict(file) {
  let raw = null;
  try {
    raw = nodeFs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, data: emptyRegistry() };
    return { ok: false };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return { ok: false };
    for (const section of ['users', 'generations', 'incidents']) {
      if (!isPlainObject(parsed[section])) return { ok: false };
    }
    for (const [, value] of ownSafeEntries(parsed.generations)) {
      if (!Number.isInteger(Number(value)) || Number(value) < 0) return { ok: false };
    }
    for (const [, value] of ownSafeEntries(parsed.incidents)) {
      if (!isPlainObject(value) || !Number.isInteger(Number(value.generation))
        || Number(value.generation) < 0 || typeof value.needsRescan !== 'boolean') {
        return { ok: false };
      }
    }
    if (!validateOptionalSections(parsed)) return { ok: false };
    return { ok: true, data: parsed };
  } catch {
    return { ok: false };
  }
}

/** 私有原子写：临时文件与目标文件 0600、目录 0700（不共用全局 0644 的写助手）。 */
let tmpFileCounter = 0;
function writeRegistryFilePrivate(file, data) {
  const target = String(file);
  const dir = nodePath.dirname(target);
  nodeFs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = nodePath.join(dir, `.${nodePath.basename(target)}.${process.pid}.${++tmpFileCounter}.tmp`);
  try {
    nodeFs.chmodSync(dir, 0o700);
    nodeFs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    nodeFs.chmodSync(tmp, 0o600);
    nodeFs.renameSync(tmp, target);
    nodeFs.chmodSync(target, 0o600);
  } catch {
    try { nodeFs.unlinkSync(tmp); } catch { /* 清理失败无需处理 */ }
    throw new Error('REGISTRY_WRITE_FAILED');
  }
}

function createWxLoginReminderService(deps = {}) {
  const getAccounts = typeof deps.getAccounts === 'function'
    ? deps.getAccounts : (() => ({ accounts: [] }));
  const log = typeof deps.log === 'function' ? deps.log : (() => {});
  const addAccountLog = typeof deps.addAccountLog === 'function' ? deps.addAccountLog : null;
  const fetchImpl = deps.fetchImpl || fetch;
  const sendTimeoutMs = Math.max(1, Number(deps.sendTimeoutMs) || BARK_SEND_TIMEOUT_MS);
  const now = typeof deps.now === 'function' ? deps.now : (() => Date.now());
  const watcherPollMs = Math.max(50, Number(deps.watcherPollMs) || WATCHER_POLL_INTERVAL_MS);
  const adapter = deps.adapter || require('./wx-login-adapter');
  const completeRescan = typeof deps.completeRescan === 'function'
    ? deps.completeRescan : null;
  const registryFile = deps.registryFile
    || (() => getDataFile(REGISTRY_FILENAME));
  // 本地巡检定时器（测试注入假时钟用）；默认 60s，只读本地状态，无外部探测。
  const sweepIntervalMs = Math.max(1, Number(deps.sweepIntervalMs) || ADVANCE_SWEEP_INTERVAL_MS);
  const sweepTimers = deps.timers || {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: handle => clearInterval(handle),
  };

  // 进程内串行化注册表读写与临界区，配合落盘声明避免并发双发。
  let mutexTail = Promise.resolve();
  function withRegistry(operation) {
    const run = mutexTail.then(operation, operation);
    mutexTail = run.then(() => undefined, () => undefined);
    return run;
  }

  let registryState = null;
  let registryBlocked = false;
  function loadRegistry() {
    if (registryState) return registryState;
    const result = readRegistryStrict(registryFile());
    if (!result.ok) {
      // 损坏/不可读：进入阻断态。配置可读（默认值），但任何声明与外发都被拒绝。
      registryBlocked = true;
      registryState = emptyRegistry();
      log('错误', '微信登录提醒状态文件不可用，已暂停自动提醒（不影响农场运行）');
      return registryState;
    }
    registryBlocked = false;
    registryState = result.data;
    return registryState;
  }

  /**
   * 克隆 → 修改 → 校验 → 原子落盘 → 成功后才提交内存态。
   * 落盘失败抛出（调用方不得外发）；内存态保持旧值，绝不半提交。
   */
  function commitRegistry(mutator) {
    return withRegistry(() => {
      const data = loadRegistry();
      if (registryBlocked) throw new Error('REGISTRY_UNAVAILABLE');
      const cloneEntries = section => Object.fromEntries(
        Object.entries(data[section] || {}).map(([key, value]) => [key, { ...value }]),
      );
      const next = {
        users: { ...data.users },
        generations: { ...data.generations },
        incidents: cloneEntries('incidents'),
        acceptedScans: cloneEntries('acceptedScans'),
        advanceNotices: cloneEntries('advanceNotices'),
        otherTerminalLogins: cloneEntries('otherTerminalLogins'),
      };
      const changed = mutator(next) !== false;
      if (!changed) return data;
      writeRegistryFilePrivate(registryFile(), next);
      registryState = next;
      return next;
    });
  }

  function findAccount(accountId) {
    const data = getAccounts();
    const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
    return accounts.find(acc => String(acc && acc.id) === String(accountId)) || null;
  }

  // ── 用户 Bark 配置（每个登录用户各自维护，互不可见） ──
  function getUserConfig(username) {
    const key = String(username || '').trim();
    const data = loadRegistry();
    const raw = key && Object.prototype.hasOwnProperty.call(data.users, key)
      ? data.users[key] : {};
    return normalizeUserConfig(raw);
  }

  function setUserConfig(username, patch = {}) {
    const key = String(username || '').trim();
    if (!key || !SAFE_KEY_RE.test(key)) return Promise.resolve(getUserConfig(''));
    return withRegistry(() => {
      const data = loadRegistry();
      if (registryBlocked) throw new Error('REGISTRY_UNAVAILABLE');
      const current = normalizeUserConfig(
        Object.prototype.hasOwnProperty.call(data.users, key) ? data.users[key] : {},
      );
      const next = normalizeUserConfig({ ...current, ...patch });
      const users = { ...data.users, [key]: next };
      writeRegistryFilePrivate(registryFile(), { ...data, users });
      registryState = { ...data, users };
      return { ...next };
    });
  }

  function currentGeneration(accountId) {
    const data = loadRegistry();
    const key = String(accountId);
    return Object.prototype.hasOwnProperty.call(data.generations, key)
      ? (Number(data.generations[key]) || 0) : 0;
  }

  /** 会话/请求绑定快照：账号 + 属主 + wxid + 扫码代次 + 请求代。 */
  function captureSnapshot(account) {
    const accountId = String(account.id);
    return {
      accountId,
      owner: String(account.username || '').trim(),
      wxid: String(account.wxid || ''),
      generation: currentGeneration(accountId),
      epoch: nextRequestEpoch(accountId),
    };
  }

  function isSnapshotCurrent(snapshot) {
    if (!snapshot) return false;
    if ((requestEpochs.get(String(snapshot.accountId)) || 0) !== Number(snapshot.epoch)) return false;
    const account = findAccount(snapshot.accountId);
    if (!account) return false;
    if (String(account.username || '').trim() !== String(snapshot.owner)) return false;
    if (String(account.wxid || '') !== String(snapshot.wxid)) return false;
    return currentGeneration(snapshot.accountId) === Number(snapshot.generation);
  }

  /**
   * 面板已认证路径成功接受一次新扫码后调用：递增代次并清除待重扫状态，
   * 同时作废该账号遗留的自助二维码（守望/图片能力/adapter 本地会话）。
   * 只有这里能让代次前进（服务端控制），轮换 token / 改备注 / 重启都不会。
   *
   * 同时以服务端当前时间记录「真实接受扫码」基线（维护参考计划唯一合法
   * 起点，绝不用 lastSuccess/updatedAt/进程启动等推断），并作废该代次的
   * 提前提醒声明（新扫码是唯一重新武装方式）。「其他终端登录」信号在同
   * 属主/同微信绑定时保留真实旧时间戳，绝不改写成扫码时刻。
   */
  async function noteAcceptedScan(accountId, options = {}) {
    const key = String(accountId || '');
    if (!key || !SAFE_KEY_RE.test(key)) return false;
    const pending = pendingByAccount.get(key);
    const ownCompletion = options.keepSessionId && pending?.sessionId === String(options.keepSessionId);
    if (!ownCompletion) supersedePendingSessions(key);
    await commitRegistry((data) => {
      const nextGeneration = (Number(data.generations[key]) || 0) + 1;
      data.generations[key] = nextGeneration;
      delete data.incidents[key];
      delete data.advanceNotices[key];
      const liveAccount = findAccount(key);
      const previousLogin = data.otherTerminalLogins[key];
      if (!liveAccount) {
        // 账号已不存在：绑定基线一并失效。
        delete data.acceptedScans[key];
        delete data.otherTerminalLogins[key];
        return;
      }
      const owner = String(liveAccount.username || '').trim();
      const wxid = String(liveAccount.wxid || '');
      if (previousLogin && String(previousLogin.owner) === owner
        && String(previousLogin.wxid) === wxid) {
        data.otherTerminalLogins[key] = { ...previousLogin };
      } else {
        // 换属主/换微信：旧信号不属于新绑定，丢弃（不伪造新时间戳）。
        delete data.otherTerminalLogins[key];
      }
      data.acceptedScans[key] = { at: now(), generation: nextGeneration, owner, wxid };
    });
    if (ownCompletion && pendingByAccount.get(key) === pending) {
      // 本次自助保存推进代次，保留它的完成状态与启动守卫；其他扫码取消旧任务。
      pending.snapshot.generation = currentGeneration(key);
      noteSessionConsumed(pending.sessionId, key);
    }
    return true;
  }

  function needsRescan(accountId) {
    const data = loadRegistry();
    const incident = data.incidents[String(accountId)];
    return !!(incident && incident.needsRescan);
  }

  /**
   * 通用下线提醒去重：WX 账号的失效提醒已由本服务认领（属主配置开启）时，
   * 跳过 relogin-reminder 的通用下线推送，避免同一原因双提醒。
   * QQ / 普通掉线 / 旧数据路径不受影响。
   */
  function shouldSuppressOfflineReminder(accountId) {
    const key = String(accountId || '');
    if (!key) return false;
    const data = loadRegistry();
    const incident = data.incidents[key];
    if (!incident || incident.needsRescan !== true || incident.claimed !== true) return false;
    const account = findAccount(key);
    if (!account || String(account.platform || '') !== 'wx') return false;
    return getUserConfig(String(account.username || '')).enabled === true;
  }

  function getIncident(accountId) {
    const data = loadRegistry();
    const incident = data.incidents[String(accountId)];
    if (!incident) return null;
    return {
      needsRescan: incident.needsRescan === true,
      generation: Number(incident.generation) || 0,
      firstSeenAt: Number(incident.firstSeenAt) || 0,
      sentAt: Number(incident.sentAt) || 0,
      lastError: sanitizeErrorText(incident.lastError),
    };
  }

  // ── 「其他终端登录」信号（用户手机进场参考；官方踢下线原因文本） ──

  function latestOtherTerminalLogin(data, accountId) {
    const entry = data.otherTerminalLogins[String(accountId)];
    if (!isPlainObject(entry)) return null;
    const at = Number(entry.at);
    if (!Number.isInteger(at) || at < 0) return null;
    return { at, owner: String(entry.owner || ''), wxid: String(entry.wxid || '') };
  }

  function isRecentOtherTerminalLogin(entry, owner, wxid, nowMs) {
    if (!entry || !owner || !wxid) return false;
    if (entry.owner !== owner || entry.wxid !== wxid) return false;
    // 只认窗口内且不晚于当前时刻的时间戳（未来值视为脏数据）。
    return entry.at <= nowMs && entry.at >= nowMs - OTHER_TERMINAL_LOGIN_LOOKBACK_MS;
  }

  /**
   * runtime 监听到「已在其他终端登录」踢下线时调用：记录服务端当前时刻，
   * 作为维护参考计划的手机进场参考。同步捕获绑定快照后异步落盘；
   * 任何失败都静默放弃（信号缺失只会少发提醒，fail closed），不影响
   * 踢下线/接管主流程。不推进代次、不重置计划、不触发任何外发。
   */
  function noteOtherTerminalLogin(accountId) {
    const key = String(accountId || '');
    if (!key || !SAFE_KEY_RE.test(key)) return Promise.resolve(false);
    const account = findAccount(key);
    if (!account || String(account.platform || '') !== 'wx') return Promise.resolve(false);
    const owner = String(account.username || '').trim();
    const wxid = String(account.wxid || '');
    // 缺原生微信身份（wxid 为空）的账号没有可绑定的进场参考，不记录。
    if (!owner || !wxid) return Promise.resolve(false);
    const at = now();
    return withRegistry(() => {
      const data = loadRegistry();
      if (registryBlocked) return false;
      const liveAccount = findAccount(key);
      if (!liveAccount || String(liveAccount.platform || '') !== 'wx') return false;
      if (String(liveAccount.username || '').trim() !== owner
        || String(liveAccount.wxid || '') !== wxid) return false;
      const previous = data.otherTerminalLogins[key];
      if (previous && Number(previous.at) > at) return false; // 迟到旧信号不得回拨最新值
      const otherTerminalLogins = { ...data.otherTerminalLogins, [key]: { at, owner, wxid } };
      try {
        writeRegistryFilePrivate(registryFile(), { ...data, otherTerminalLogins });
      } catch {
        return false; // 写失败：不更新内存态，信号缺失宁可少发
      }
      registryState = { ...data, otherTerminalLogins };
      return true;
    });
  }

  // ── 扫码维护参考计划（本地巡检；仅真实接受扫码作为基线） ──

  /** 计划视图：只读；pauseReason 必须与实际状态一致（可用且无阻塞时为空）。 */
  function buildPlanView(account) {
    const nowMs = now();
    const owner = String(account.username || '').trim();
    const wxid = String(account.wxid || '');
    const config = getUserConfig(owner);
    const data = loadRegistry();
    const key = String(account.id);
    const activity = latestOtherTerminalLogin(data, key);
    // 绑定不符的信号时间戳属于旧绑定，不得展示在新绑定名下。
    const bindingMatched = !!activity && activity.owner === owner && activity.wxid === wxid;
    const view = {
      mode: 'reference',
      advanceEnabled: config.advanceEnabled,
      cycleHours: config.maintenanceCycleHours,
      advanceMinutes: config.advanceMinutes,
      available: false,
      waitingForScan: true,
      acceptedScanAt: 0,
      maintenanceAt: 0,
      reminderAt: 0,
      remainingMs: 0,
      overdue: false,
      notified: false,
      notificationSentAt: 0,
      notificationError: '',
      recentMobileActivityAt: bindingMatched ? activity.at : 0,
      recentMobileActivityAvailable: isRecentOtherTerminalLogin(activity, owner, wxid, nowMs),
      pauseReason: '完成下一次扫码后开始计算计划',
    };
    const scan = isPlainObject(data.acceptedScans[key]) ? data.acceptedScans[key] : null;
    const generation = Number(data.generations[key]) || 0;
    const scanAt = Number(scan && scan.at);
    // 缺原生身份 / 无真实扫码基线 / 代次或绑定不符 / 基线时间非法（含未来值）
    // 都不构成有效计划，也不制造历史时间戳。
    if (!wxid || !scan || Number(scan.generation) !== generation
      || String(scan.owner || '') !== owner || String(scan.wxid || '') !== wxid
      || !Number.isInteger(scanAt) || scanAt <= 0 || scanAt > nowMs) {
      return view;
    }
    const maintenanceAt = scanAt + config.maintenanceCycleHours * 3600_000;
    const reminderAt = maintenanceAt - config.advanceMinutes * 60_000;
    const notice = isPlainObject(data.advanceNotices[key])
      && Number(data.advanceNotices[key].generation) === generation
      ? data.advanceNotices[key] : null;
    view.available = true;
    view.waitingForScan = false;
    view.acceptedScanAt = scanAt;
    view.maintenanceAt = maintenanceAt;
    view.reminderAt = reminderAt;
    view.remainingMs = maintenanceAt - nowMs;
    view.overdue = nowMs >= maintenanceAt;
    // notified = 本代次唯一一次自动提醒已认领（含发送失败，不承诺送达）。
    view.notified = !!notice;
    view.notificationSentAt = notice ? (Number(notice.sentAt) || 0) : 0;
    view.notificationError = notice ? sanitizeErrorText(notice.lastError) : '';
    // 明确清空：有效计划不得再显示「等待扫码」字样；阻塞原因按实情给出。
    view.pauseReason = '';
    if (account.autoLogin === false) {
      view.pauseReason = '账号已设为不登录（暂停），不发送周期提醒';
    } else if (config.enabled !== true) {
      view.pauseReason = '提醒总开关未开启，不发送周期提醒';
    } else if (!view.recentMobileActivityAvailable) {
      view.pauseReason = '最近 24 小时未观察到其他终端登录（手机进场参考），暂不发送周期提醒';
    } else if (config.advanceEnabled !== true) {
      view.pauseReason = '已在设置中关闭扫码维护参考计划的提前提醒';
    }
    return view;
  }

  /**
   * 单账号提前提醒判定：只读本地注册表与账号状态（零网络探测、零二维码
   * 生成）。入口先做同步快照（accountId/owner/wxid/意愿），声明临界区内
   * 用「下一份注册表状态 + 实时账号绑定」重验全部条件后才落盘声明——
   * 排队期间的暂停/换绑/禁用/改参数必须拦下且不消耗唯一一次声明；
   * 外发前再读当前配置与状态做最后一道校验。任何不满足都静默跳过。
   */
  async function maybeSendAdvanceNotice(account) {
    // 同步快照：等待期间账号对象可能被改（autoLogin/wxid 等），不得信可变引用。
    const key = String(account.id);
    const snapshot = {
      accountId: key,
      owner: String(account.username || '').trim(),
      wxid: String(account.wxid || ''),
      active: account.autoLogin !== false,
    };
    // 缺属主/缺原生微信身份/用户明确暂停（autoLogin=false）都不发。
    if (!key || !snapshot.owner || !snapshot.wxid || !snapshot.active) return false;
    const nowMs = now();
    const data = loadRegistry();
    if (registryBlocked) return false;
    const generation = Number(data.generations[key]) || 0;
    const scan = isPlainObject(data.acceptedScans[key]) ? data.acceptedScans[key] : null;
    const scanAt = Number(scan && scan.at);
    if (!scan) return false; // 没有真实扫码基线：不制造历史时间戳
    if (Number(scan.generation) !== generation
      || String(scan.owner || '') !== snapshot.owner
      || String(scan.wxid || '') !== snapshot.wxid
      || !Number.isInteger(scanAt) || scanAt <= 0 || scanAt > nowMs) return false;
    // 该代次已有失效事件（终端兜底已记录/认领）：不再发「参考维护」提醒。
    const incident = data.incidents[key];
    if (incident && (Number(incident.generation) || 0) === generation) return false;
    const notice = data.advanceNotices[key];
    if (notice && (Number(notice.generation) || 0) === generation) return false;

    // 入口侧预检（快速路径）；真实判定以声明临界区内的最新状态为准。
    const config = getUserConfig(snapshot.owner);
    if (config.enabled !== true || config.advanceEnabled !== true) return false;
    const reminderAt = scanAt + config.maintenanceCycleHours * 3600_000 - config.advanceMinutes * 60_000;
    if (nowMs < reminderAt) return false;
    if (!isRecentOtherTerminalLogin(latestOtherTerminalLogin(data, key), snapshot.owner, snapshot.wxid, nowMs)) {
      return false;
    }

    let claimed = false;
    await commitRegistry((next) => {
      if ((Number(next.generations[key]) || 0) !== generation) return false;
      const liveScan = next.acceptedScans[key];
      if (!liveScan || Number(liveScan.at) !== scanAt) return false;
      const liveIncident = next.incidents[key];
      if (liveIncident && (Number(liveIncident.generation) || 0) === generation) return false;
      const liveNotice = next.advanceNotices[key];
      if (liveNotice && (Number(liveNotice.generation) || 0) === generation) return false;
      // 临界区内重验实时账号绑定与运行意愿（排队期间的暂停/换绑拦下且不声明）。
      const liveAccount = findAccount(key);
      if (!liveAccount || String(liveAccount.platform || '') !== 'wx') return false;
      if (String(liveAccount.username || '').trim() !== snapshot.owner
        || String(liveAccount.wxid || '') !== snapshot.wxid) return false;
      if (liveAccount.autoLogin === false) return false;
      // 以「下一份注册表」重读属主配置：排队期间的禁用/改参数立即生效，
      // 周期与提前量也按最新值重新判定到期。
      const liveConfig = normalizeUserConfig(
        Object.prototype.hasOwnProperty.call(next.users, snapshot.owner) ? next.users[snapshot.owner] : {},
      );
      if (liveConfig.enabled !== true || liveConfig.advanceEnabled !== true) return false;
      if (!parseBarkTarget(liveConfig.deviceKey, liveConfig.barkServer).key) return false;
      if (!buildHelpLink(liveConfig, key)) return false;
      const liveReminderAt = scanAt + liveConfig.maintenanceCycleHours * 3600_000
        - liveConfig.advanceMinutes * 60_000;
      if (now() < liveReminderAt) return false;
      if (!isRecentOtherTerminalLogin(
        latestOtherTerminalLogin(next, key), snapshot.owner, snapshot.wxid, now())) return false;
      next.advanceNotices[key] = { generation, claimedAt: now(), sentAt: 0, lastError: '' };
      claimed = true;
      return true;
    });
    if (!claimed) return false;

    // 外发前最后一道实时校验：配置以「此刻」为准（声明后的禁用仍应拦下），
    // 终端失效若已记录则不再发参考提醒。
    const liveData = loadRegistry();
    if ((Number(liveData.generations[key]) || 0) !== generation) return false;
    if (liveData.incidents[key]
      && (Number(liveData.incidents[key].generation) || 0) === generation) return false;
    const liveAccount = findAccount(key);
    if (!liveAccount || String(liveAccount.platform || '') !== 'wx'
      || String(liveAccount.username || '').trim() !== snapshot.owner
      || String(liveAccount.wxid || '') !== snapshot.wxid
      || liveAccount.autoLogin === false) return false;
    const sendConfig = getUserConfig(snapshot.owner);
    const sendTarget = parseBarkTarget(sendConfig.deviceKey, sendConfig.barkServer);
    const sendLink = buildHelpLink(sendConfig, key);
    if (sendConfig.enabled !== true || sendConfig.advanceEnabled !== true
      || !sendTarget.key || !sendLink) return false;

    const name = String(liveAccount.name || '') || key;
    const overdue = now() >= scanAt + sendConfig.maintenanceCycleHours * 3600_000;
    // 措辞不得声称账号此刻必然正常运行（无连接态证据），只说明参考语义。
    const result = await sendBark(sendConfig, {
      title: '微信扫码维护提醒',
      body: `${overdue
        ? `你设置的账号「${name}」扫码维护参考时间已到。这是维护参考提醒，不表示账号已失效；请方便时点开链接发送新的二维码完成重扫。`
        : `你设置的账号「${name}」扫码维护参考时间将到。这是维护参考提醒，不表示账号已失效；请方便时点开链接准备/发送新的二维码（到时再生成，现在无需扫码）。`
         }计划为自行设置的参考，非微信官方到期时间。`,
      url: sendLink,
    });
    await commitRegistry((next) => {
      const entry = next.advanceNotices[key];
      if (!entry || (Number(entry.generation) || 0) !== generation) return false;
      if (result.ok) {
        entry.sentAt = now();
        entry.lastError = '';
        log('系统', `微信扫码维护提前提醒已发送: ${name}`, { accountId: key });
      } else {
        entry.lastError = sanitizeErrorText(result.error);
        log('错误', `微信扫码维护提前提醒发送失败: ${name}`, { accountId: key, error: entry.lastError });
      }
      return true;
    });
    return true;
  }

  let sweepTimer = null;
  let sweepInFlight = false;

  /**
   * 一轮本地巡检：逐账号判定，单账号异常不阻断其余；不与在途一轮重叠。
   * 自身任何异常（含 getAccounts 抛错）都被吞掉——巡检失败绝不影响进程。
   */
  function sweepOnce() {
    if (sweepInFlight) return Promise.resolve(0);
    sweepInFlight = true;
    return (async () => {
      let sent = 0;
      try {
        const data = getAccounts();
        const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
        for (const account of accounts) {
          if (!account || String(account.platform || '') !== 'wx') continue;
          try {
            if (await maybeSendAdvanceNotice(account)) sent += 1;
          } catch { /* 单账号失败静默，下一轮再看 */ }
        }
      } catch { /* 巡检自身异常静默：绝不冒泡到定时器/启动路径 */ }
      finally {
        sweepInFlight = false;
      }
      return sent;
    })();
  }

  /** 由 runtime-engine 启动一次：立即执行一轮 + 周期巡检；不阻塞进程退出。 */
  function startMaintenanceSweep() {
    if (sweepTimer) return false;
    const handle = sweepTimers.setInterval(() => { sweepOnce(); }, sweepIntervalMs);
    if (handle && typeof handle.unref === 'function') handle.unref();
    sweepTimer = handle;
    try {
      sweepOnce(); // 启动即补一轮：进程重启后的到期计划不等到下个整周期。
    } catch { /* 同步异常也不影响启动 */ }
    return true;
  }

  function stopMaintenanceSweep() {
    if (!sweepTimer) return false;
    const handle = sweepTimer;
    sweepTimer = null;
    try { sweepTimers.clearInterval(handle); } catch { /* 已清理 */ }
    return true;
  }

  // ── Bark 发送（严格校验 HTTP 状态 + 厂商 code；device_key 不进日志） ──
  async function sendBark(userConfig, payload = {}) {
    const config = normalizeUserConfig(userConfig);
    const target = parseBarkTarget(config.deviceKey, config.barkServer);
    if (!target.key) return { ok: false, error: '未配置 Bark 设备 Key' };
    const body = String(payload.body || '').trim();
    if (!body) return { ok: false, error: '通知内容为空' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), sendTimeoutMs);
    try {
      const response = await fetchImpl(`${target.server.replace(/\/+$/, '')}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          title: String(payload.title || '微信登录提醒').trim(),
          body,
          device_key: target.key,
          group: String(payload.group || 'wx-login').trim() || 'wx-login',
          ...(payload.url ? { url: String(payload.url) } : {}),
          ...(payload.image ? { image: String(payload.image) } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, error: `Bark HTTP ${response.status}` };
      let data = null;
      try { data = await response.json(); } catch { return { ok: false, error: 'Bark 返回非 JSON' }; }
      const code = Number(data && data.code);
      if (code === 200) return { ok: true };
      return { ok: false, error: `Bark code=${Number.isFinite(code) ? code : 'unknown'}` };
    } catch (error) {
      const aborted = error && (error.name === 'AbortError' || /aborted/i.test(String(error.message)));
      return { ok: false, error: aborted ? 'Bark 发送超时' : 'Bark 发送失败' };
    } finally {
      clearTimeout(timer);
    }
  }

  function buildHelpLink(userConfig, accountId) {
    const base = String(userConfig.serverUrl || '').trim();
    if (!base) return '';
    return `${base.replace(/\/+$/, '')}/wx-login-help?accountId=${encodeURIComponent(String(accountId))}`;
  }

  function describeAccount(account) {
    return { id: String(account.id), name: String(account.name || ''), username: String(account.username || '') };
  }

  /**
   * 自动提醒入口：凭据被判定明确失效时由 auto-code-refresh 注入的回调调用。
   * 入参可以是 accountId，也可以是 auto-code 边界传入的绑定快照
   * （含 owner/wxid），避免异步边界再取当前值造成错绑。
   * 绝不抛错、绝不影响既有保活/错误预算；同代次只发一次；
   * 外发前先落盘声明，声明落不下来就不外发（fail closed）。
   */
  async function noteCredentialInvalid(input) {
    try {
      const snapshotInput = isPlainObject(input) ? input : { accountId: input };
      const key = String(snapshotInput.accountId || '');
      if (!key || !SAFE_KEY_RE.test(key)) return false;

      const account = findAccount(key);
      if (!account) return false;
      // 只面向微信扫码账号；QQ 账号的失效走各自的提醒链路。
      if (String(account.platform || '') !== 'wx') return false;
      const boundOwner = String(snapshotInput.owner || '').trim();
      const boundWxid = String(snapshotInput.wxid || '');
      if (boundOwner && boundOwner !== String(account.username || '')) return false;
      if (boundWxid && boundWxid !== String(account.wxid || '')) return false;

      const name = account.name || key;
      if (addAccountLog) {
        addAccountLog('wx_login_reminder', '微信凭据已明确失效，需要重新扫码授权',
          account.id, account.name, { reason: 'definitive' });
      }

      // 临界区内：重验账号绑定与代次后才写声明；落盘失败 → 异常向上抛 → 不外发。
      const generation = currentGeneration(key);
      let shouldSend = false;
      await commitRegistry((data) => {
        const liveAccount = findAccount(key);
        if (!liveAccount || String(liveAccount.platform || '') !== 'wx') return false;
        if (boundOwner && String(liveAccount.username || '') !== boundOwner) return false;
        if (boundWxid && String(liveAccount.wxid || '') !== boundWxid) return false;
        if ((Number(data.generations[key]) || 0) !== generation) return false;
        // 本代次已用过唯一一次自动提醒（提前维护提醒，含发送失败）：
        // 如实记录失效与 needsRescan，但不再外发第二条。
        const early = data.advanceNotices[key];
        const earlyClaimed = isPlainObject(early) && (Number(early.generation) || 0) === generation;
        const incident = data.incidents[key];
        if (incident && (Number(incident.generation) || 0) === generation) {
          if (incident.claimed === true) {
            // 同一代次已声明（含上次发送失败）只补 needsRescan 标记，不重复外发。
            if (incident.needsRescan === true) return false;
            data.incidents[key] = { ...incident, needsRescan: true };
            return true;
          }
          if (earlyClaimed) {
            data.incidents[key] = { ...incident, needsRescan: true, claimed: true, claimedAt: now() };
            return true;
          }
          // 此前通知未就绪（未启用/缺 Key）只记了 needsRescan：属主配置就绪
          // 后（启用保存或显式补发）现在补声明并外发一次。
          const readyConfig = getUserConfig(String(liveAccount.username || ''));
          const ready = readyConfig.enabled === true && !!readyConfig.serverUrl
            && !!parseBarkTarget(readyConfig.deviceKey, readyConfig.barkServer).key;
          if (!ready) return false;
          data.incidents[key] = { ...incident, claimed: true, claimedAt: now() };
          shouldSend = true;
          return true;
        }
        const ownerConfig = getUserConfig(String(liveAccount.username || ''));
        const canNotify = ownerConfig.enabled === true && !!ownerConfig.serverUrl
          && !!parseBarkTarget(ownerConfig.deviceKey, ownerConfig.barkServer).key;
        data.incidents[key] = {
          generation,
          needsRescan: true,
          firstSeenAt: Number(incident && incident.firstSeenAt) || now(),
          // 通知未就绪（未启用/缺 Key）只记 needsRescan 不声明，启用时可补发一次。
          claimed: canNotify || earlyClaimed,
          claimedAt: (canNotify || earlyClaimed) ? now() : 0,
          sentAt: 0,
          lastError: '',
        };
        shouldSend = canNotify && !earlyClaimed;
        return true;
      });
      const completedPending = pendingByAccount.get(key);
      if (completedPending?.state === 'saved' && needsRescan(key)) supersedePendingSessions(key);
      if (!shouldSend) return false;
      const liveAccount = findAccount(key);
      const owner = String(account.username || '').trim();
      if (!owner || !liveAccount || String(liveAccount.username || '').trim() !== owner
        || String(liveAccount.wxid || '') !== String(account.wxid || '')
        || currentGeneration(key) !== generation) return false;

      const ownerConfig = getUserConfig(owner);
      const link = buildHelpLink(ownerConfig, key);
      if (!ownerConfig.enabled || !link || !parseBarkTarget(ownerConfig.deviceKey, ownerConfig.barkServer).key) return false;
      const result = await sendBark(ownerConfig, {
        title: '微信授权失效提醒',
        body: link
          ? `账号「${name}」的微信登录已失效，需要重新扫码授权。点开链接即可自助完成；`
            + '如二维码已过期，可在页面点「重新发送二维码」。'
          : `账号「${name}」的微信登录已失效，请打开面板完成重新扫码授权。`,
        ...(link ? { url: link } : {}),
      });
      // 迟到完成不得改写新代次的记录。
      await commitRegistry((data) => {
        const incident = data.incidents[key];
        if (!incident || (Number(incident.generation) || 0) !== generation) return false;
        if (result.ok) {
          incident.sentAt = now();
          incident.lastError = '';
          log('系统', `微信重扫提醒已发送: ${name}`, { accountId: key });
        } else {
          // 发送失败保留声明（claimed），不自动重试，避免风暴。
          incident.lastError = sanitizeErrorText(result.error);
          log('错误', `微信重扫提醒发送失败: ${name}`, { accountId: key, error: incident.lastError });
        }
        return true;
      });
      return true;
    } catch (error) {
      log('错误', `微信重扫提醒处理失败: ${sanitizeErrorText(error && error.message)}`);
      return false;
    }
  }

  /** 属主启用提醒后：把此前「未声明」的待重扫事件补发一次（每代次至多一条）。 */
  async function dispatchPendingForUser(username) {
    const owner = String(username || '').trim();
    if (!owner) return [];
    const data = loadRegistry();
    const dispatched = [];
    for (const [key, incident] of ownSafeEntries(data.incidents)) {
      if (!incident || incident.needsRescan !== true || incident.claimed === true) continue;
      const account = findAccount(key);
      if (!account || String(account.platform || '') !== 'wx') continue;
      if (String(account.username || '').trim() !== owner) continue;
      await noteCredentialInvalid(key);
      dispatched.push(key);
    }
    return dispatched;
  }

  // ── 待扫码会话 + 服务端守望（浏览器切后台/切微信后仍完成扫码） ──
  const pendingByAccount = new Map(); // accountId -> entry（含绑定快照）
  const imageTokens = new Map(); // token -> { accountId, sessionId, owner, qrBase64, expiresAt, 绑定快照 }
  const inFlightSend = new Map(); // accountId -> Promise（并发点击合并为一次）
  const watchers = new Map(); // accountId -> watcher（含 sessionId 身份）
  const requestEpochs = new Map(); // accountId -> 最新请求代（取代/新扫码都会推进）

  function nextRequestEpoch(accountId) {
    const key = String(accountId);
    const next = (requestEpochs.get(key) || 0) + 1;
    requestEpochs.set(key, next);
    return next;
  }

  function revokeImageTokensFor(accountId, sessionId) {
    for (const [token, entry] of imageTokens) {
      if (String(entry.accountId) === String(accountId)
        && (!sessionId || String(entry.sessionId) === String(sessionId))) {
        imageTokens.delete(token);
      }
    }
  }

  /** 立即作废旧自助二维码（不等新二维码返回）：停守望、吊销图片、取消 adapter 会话。 */
  function supersedePendingSessions(accountId) {
    const key = String(accountId);
    const pending = pendingByAccount.get(key);
    if (pending) {
      pendingByAccount.delete(key);
      try { adapter.cancelWxSession(pending.sessionId, pending.owner); } catch { /* 尽力清理 */ }
    }
    revokeImageTokensFor(key);
    stopWatcher(key);
    nextRequestEpoch(key);
  }

  function sessionPublicView(entry) {
    return {
      sessionId: entry.sessionId,
      createdAt: Number(entry.createdAt) || 0,
      expiresAt: Number(entry.expiresAt) || 0,
      localTtlMs: LOCAL_SESSION_TTL_MS,
      state: entry.state,
      detail: entry.detail || '',
      qrBase64: entry.qrBase64 || '',
      pushed: entry.pushed === true,
      pushError: entry.pushError || '',
    };
  }

  function markPendingState(accountId, sessionId, state, detail = '') {
    const entry = pendingByAccount.get(String(accountId));
    if (!entry || entry.sessionId !== sessionId) return;
    entry.state = state;
    entry.detail = detail;
  }

  function stopWatcher(accountId, watcher) {
    const key = String(accountId);
    if (watcher) {
      // 只能停掉自己：旧守望/旧完成不得误删新守望（map 身份校验）。
      watcher.stopped = true;
      if (watchers.get(key) === watcher) watchers.delete(key);
      return;
    }
    const current = watchers.get(key);
    if (current) {
      current.stopped = true;
      watchers.delete(key);
    }
  }

  function abandonPending(entry) {
    if (!entry || pendingByAccount.get(String(entry.accountId)) !== entry) return;
    pendingByAccount.delete(String(entry.accountId));
    revokeImageTokensFor(entry.accountId, entry.sessionId);
    stopWatcher(entry.accountId);
    try { adapter.cancelWxSession(entry.sessionId, entry.owner); } catch { /* 会话可能已被消费 */ }
  }

  /**
   * 用户显式点击「现在/重新发送二维码」：新建扫码会话（旧会话/守望/图片能力
   * 立即作废），按账号属主的 Bark 配置即时推送带图通知，并启动有界服务端守望。
   * 请求快照在每个 await 之后复验：更新的扫码/请求一旦发生，迟到产物
   * （二维码/图片能力/推送）整体回滚，不覆盖新状态。
   */
  async function requestQrPush({ account, origin }) {
    const accountId = String(account.id);
    const existing = inFlightSend.get(accountId);
    if (existing) return existing;

    // 先作废旧会话（会推进请求代），再捕获本请求快照，避免自我失效。
    supersedePendingSessions(accountId);
    const snapshot = captureSnapshot(account);

    const task = (async () => {
      const owner = snapshot.owner;
      if (!owner) throw new Error('账号没有属主用户，无法自助重扫');
      const qr = await adapter.getQRCode(owner);
      if (!isSnapshotCurrent(snapshot)) {
        const lateId = qr && qr.Data && qr.Data.Uuid;
        if (lateId) { try { adapter.cancelWxSession(String(lateId), owner); } catch { /* 尽力清理 */ } }
        return { superseded: true };
      }
      if (!qr || qr.Success !== true || !(qr.Data && qr.Data.Uuid)) {
        throw new Error(`获取二维码失败: ${(qr && qr.Message) || '未知错误'}`);
      }
      const sessionId = String(qr.Data.Uuid);
      const qrBase64 = String(qr.Data.QrBase64 || '');
      if (!isPngBuffer(Buffer.from(qrBase64, 'base64'))) {
        try { adapter.cancelWxSession(sessionId, owner); } catch { /* 尽力清理 */ }
        throw new Error('二维码内容不是有效的 PNG 图片');
      }
      if (!isSnapshotCurrent(snapshot)) {
        try { adapter.cancelWxSession(sessionId, owner); } catch { /* 尽力清理 */ }
        return { superseded: true };
      }
      // 会话真实起止来自 adapter（本地会话），不自造第二套时钟。
      const createdAt = Number(qr.Data.CreatedAt) || now();
      const expiresAt = Number(qr.Data.ExpiresAt) || createdAt + LOCAL_SESSION_TTL_MS;
      snapshot.sessionId = sessionId;

      const token = nodeCrypto.randomBytes(32).toString('hex');
      const entry = {
        accountId, sessionId, owner, snapshot,
        createdAt, expiresAt,
        state: 'pending', detail: '', qrBase64, imageToken: token,
        pushed: false, pushError: '', pushOrigin: String(origin || 'manual'),
      };
      pendingByAccount.set(accountId, entry);
      imageTokens.set(token, {
        accountId, sessionId, owner, qrBase64, expiresAt, snapshot,
      });

      let pushed = false;
      let pushError = '';
      const ownerConfig = getUserConfig(owner);
      const target = parseBarkTarget(ownerConfig.deviceKey, ownerConfig.barkServer);
      if (ownerConfig.enabled && ownerConfig.serverUrl && target.key) {
        const link = buildHelpLink(ownerConfig, accountId);
        const result = await sendBark(ownerConfig, {
          title: '微信重新扫码',
          body: `账号「${account.name || accountId}」的新扫码二维码已生成（本地会话约 `
            + `${Math.round((expiresAt - createdAt) / 60000)} 分钟内有效，微信侧二维码可能提前失效）。`
            + '请用微信扫码确认；如已过期，回到页面点「重新发送二维码」。',
          ...(link ? { url: link } : {}),
          image: `${ownerConfig.serverUrl}/api/wx-login-qr-image/${token}`,
        });
        pushed = result.ok;
        pushError = result.ok ? '' : sanitizeErrorText(result.error);
      } else {
        pushError = !ownerConfig.enabled ? '未启用 Bark 提醒'
          : !target.key ? '未配置 Bark 设备 Key' : '未配置面板访问地址，无法生成图片链接';
      }
      if (!isSnapshotCurrent(snapshot)) {
        // 推送期间已被更新请求/新扫码取代：回滚本次产物，不动新状态。
        revokeImageTokensFor(accountId, sessionId);
        if (pendingByAccount.get(accountId) === entry) pendingByAccount.delete(accountId);
        try { adapter.cancelWxSession(sessionId, owner); } catch { /* 尽力清理 */ }
        return { superseded: true };
      }
      entry.pushed = pushed;
      entry.pushError = pushError;

      startWatcher(account, snapshot);
      return {
        session: sessionPublicView(entry),
        pushed,
        pushError,
        imageToken: token,
      };
    })();

    inFlightSend.set(accountId, task);
    try {
      return await task;
    } finally {
      if (inFlightSend.get(accountId) === task) inFlightSend.delete(accountId);
    }
  }

  /** 保存链执行器：把绑定快照换算成 isCurrent 守卫交给注入的保存实现。 */
  async function runCompletion(accountId, sessionId, openid, snapshot) {
    if (!completeRescan) return { ok: false, error: '服务端未接入扫码保存流程' };
    const isCurrent = () => isSnapshotCurrent(snapshot)
      && pendingByAccount.get(String(accountId))?.sessionId === sessionId;
    try {
      return await completeRescan({
        accountId, sessionId, openid, owner: snapshot.owner, isCurrent,
      });
    } catch (error) {
      return { ok: false, error: sanitizeErrorText(error && error.message) || '保存扫码凭据失败' };
    }
  }

  function applyCompletionState(accountId, watcher, result, successLabel) {
    if (!result || result.superseded) return; // 已被更新操作接管，状态归新会话
    if (result.ok) {
      // 保存成功为事实；启动失败作为附加说明如实展示，不掩盖为成功启动。
      markPendingState(accountId, watcher.sessionId, 'saved',
        result.started === false && result.error ? result.error : '');
      log('系统', `${successLabel}: ${watcher.accountName || accountId}`, { accountId });
    } else if (result.retryable) {
      // 换码临时失败：保留已确认的一次性 OAuth 检查点，等用户显式重试。
      markPendingState(accountId, watcher.sessionId, 'confirmed_retry', result.error || '');
    } else {
      markPendingState(accountId, watcher.sessionId, 'error', result.error || '扫码结果保存失败');
      log('错误', `自助重新扫码保存失败: ${watcher.accountName || accountId}`, {
        accountId, error: sanitizeErrorText(result && result.error),
      });
    }
    stopWatcher(accountId, watcher);
  }

  /**
   * 有界守望：单账号单实例、间隔轮询、每个 await 前后都校验绑定快照与
   * 会话身份；新的发送/重扫/删除让旧守望直接退出，不能保存或重启账号。
   */
  function startWatcher(account, snapshot) {
    const accountId = String(account.id);
    stopWatcher(accountId);
    const entry = pendingByAccount.get(accountId);
    if (!entry || entry.sessionId !== snapshot.sessionId) return;
    const watcher = {
      accountId,
      sessionId: entry.sessionId,
      owner: entry.owner,
      accountName: String(account.name || ''),
      stopped: false,
    };
    watchers.set(accountId, watcher);

    (async () => {
      const sleep = ms => new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        if (typeof timer.unref === 'function') timer.unref();
      });
      const deadline = entry.expiresAt + watcherPollMs;
      while (!watcher.stopped) {
        if (now() >= deadline) break;
        if (!isSnapshotCurrent(snapshot)) { abandonPending(entry); stopWatcher(accountId, watcher); return; }
        try {
          const result = await adapter.checkQR(watcher.sessionId, entry.owner);
          if (watcher.stopped) return;
          if (!isSnapshotCurrent(snapshot)) { abandonPending(entry); stopWatcher(accountId, watcher); return; }
          const pending = pendingByAccount.get(accountId);
          if (!pending || pending.sessionId !== watcher.sessionId) return;

          if (result && result.Success === true && result.Data && result.Data.acctSectResp) {
            const openid = String(result.Data.acctSectResp.userName || '');
            markPendingState(accountId, watcher.sessionId, 'saving');
            const outcome = await runCompletion(accountId, watcher.sessionId, openid, snapshot);
            if (watcher.stopped) return;
            applyCompletionState(accountId, watcher, outcome, '自助重新扫码完成');
            return;
          }
          if (result && result.Success === true && result.Data && Number(result.Data.status) === 1) {
            markPendingState(accountId, watcher.sessionId, 'scanned');
          } else if (result && result.Success === true) {
            markPendingState(accountId, watcher.sessionId, 'pending');
          } else {
            const message = String((result && result.Message) || '');
            if (/过期|已取消|用户取消/.test(message)) {
              markPendingState(accountId, watcher.sessionId, 'expired', sanitizeErrorText(message));
              stopWatcher(accountId, watcher);
              return;
            }
            // 临时失败（网络波动等）保持原状态继续轮询，不改判为过期。
          }
        } catch {
          // 单次轮询异常不终止守望，交给有界期限。
        }
        await sleep(watcherPollMs);
      }
      if (!watcher.stopped) {
        const pending = pendingByAccount.get(accountId);
        if (pending && pending.sessionId === watcher.sessionId
          && (pending.state === 'pending' || pending.state === 'scanned')) {
          markPendingState(accountId, watcher.sessionId, 'expired', '本地扫码会话已到期');
        }
        stopWatcher(accountId, watcher);
      }
    })();
  }

  /** 会话被保存路径消费（成功保存）后调用：吊销图片能力，更新状态。 */
  function noteSessionConsumed(sessionId, accountId) {
    const key = String(accountId || '');
    for (const [token, entry] of imageTokens) {
      if (String(entry.sessionId) === String(sessionId)) imageTokens.delete(token);
    }
    const pending = pendingByAccount.get(key);
    if (pending && pending.sessionId === String(sessionId)) {
      pending.state = 'saved';
    }
  }

  /**
   * 显式「重试完成登录」：同一会话补一次换码+保存（不重发二维码、不重放
   * OAuth 确认、不动扫码代次）。只服务可重试的已确认会话。
   */
  async function retryCompleteLogin(account) {
    const accountId = String(account.id);
    const pending = pendingByAccount.get(accountId);
    if (!pending) return { ok: false, error: '当前没有待完成的扫码会话，请重新发送二维码' };
    if (pending.state === 'saved') return { ok: true, started: !pending.detail, alreadySaved: true, error: pending.detail || '' };
    // 只服务「换码临时失败」的已确认会话（守望已停）；其余状态交给守望或重新发送。
    if (pending.state !== 'confirmed_retry') {
      return { ok: false, error: '当前扫码会话不需要重试，请等待自动完成或重新发送二维码' };
    }
    if (now() >= pending.expiresAt || pending.state === 'expired') {
      markPendingState(accountId, pending.sessionId, 'expired', '本地扫码会话已到期');
      return { ok: false, error: '本地扫码会话已到期，请重新发送二维码' };
    }
    const info = adapter.getWxSessionInfo(pending.sessionId, pending.owner);
    if (!info || info.confirmed !== true || !info.openid) {
      return { ok: false, error: '扫码确认信息缺失，请重新发送二维码' };
    }
    const snapshot = pending.snapshot;
    if (!isSnapshotCurrent(snapshot) || pendingByAccount.get(accountId) !== pending) {
      return { ok: false, error: '扫码会话已被新的操作取代' };
    }
    markPendingState(accountId, pending.sessionId, 'saving');
    const outcome = await runCompletion(accountId, pending.sessionId, info.openid, snapshot);
    applyCompletionState(accountId, { ...watcherLike(accountId, pending, account) }, outcome, '重试完成登录');
    return outcome;
  }

  function watcherLike(accountId, pending, account) {
    return {
      accountId,
      sessionId: pending.sessionId,
      owner: pending.owner,
      accountName: String((account && account.name) || ''),
      stopped: false,
    };
  }

  /** 图片能力读取：过期/被替换/已消费/账号已删或改绑一律视为吊销。只返回 PNG。 */
  function getQrImage(token) {
    const entry = imageTokens.get(String(token || ''));
    if (!entry) return null;
    const pending = pendingByAccount.get(String(entry.accountId));
    if (!pending || pending.sessionId !== entry.sessionId
      || !['pending', 'scanned'].includes(pending.state)) {
      revokeImageTokensFor(entry.accountId, entry.sessionId);
      return null;
    }
    if (now() >= entry.expiresAt) {
      imageTokens.delete(String(token));
      return null;
    }
    // 能力与账号强绑定：账号没了/换属主/换微信/新扫码代次，立即整组吊销。
    const account = findAccount(entry.accountId);
    if (!account
      || String(account.username || '').trim() !== String(entry.owner)
      || String(account.wxid || '') !== String(entry.snapshot.wxid)
      || currentGeneration(entry.accountId) !== Number(entry.snapshot.generation)) {
      revokeImageTokensFor(entry.accountId);
      return null;
    }
    return { png: Buffer.from(entry.qrBase64, 'base64'), accountId: entry.accountId };
  }

  function getPendingSession(accountId) {
    const entry = pendingByAccount.get(String(accountId));
    if (!entry) return null;
    if (!isSnapshotCurrent(entry.snapshot)) { abandonPending(entry); return null; }
    if (now() >= entry.expiresAt) {
      if (['pending', 'scanned', 'confirmed_retry'].includes(entry.state)) {
        entry.state = 'expired';
        revokeImageTokensFor(entry.accountId, entry.sessionId);
        stopWatcher(entry.accountId);
        try { adapter.cancelWxSession(entry.sessionId, entry.owner); } catch { /* 到期会话可能已被清理 */ }
      }
    }
    return sessionPublicView(entry);
  }

  /** 面板状态视图：只给有权访问该账号的登录用户。 */
  function getHelpStatus(account) {
    const incident = getIncident(account.id);
    const pending = getPendingSession(account.id);
    return {
      serverNow: now(),
      account: describeAccount(account),
      platform: String(account.platform || ''),
      incident: incident ? {
        needsRescan: incident.needsRescan,
        lastError: incident.lastError,
        sentAt: incident.sentAt,
      } : { needsRescan: false, lastError: '', sentAt: 0 },
      // pending.expiresAt 是本地扫码会话截止，不代表微信侧二维码寿命。
      pending: pending ? {
        ...pending,
        expiresAtLabel: '本地扫码会话截止（微信侧二维码可能提前失效）',
      } : null,
      // 扫码维护参考计划（与扫码会话独立：不生成二维码、不改运行状态）。
      plan: buildPlanView(account),
    };
  }

  return {
    getUserConfig,
    setUserConfig,
    sendBark,
    noteAcceptedScan,
    noteOtherTerminalLogin,
    noteCredentialInvalid,
    dispatchPendingForUser,
    shouldSuppressOfflineReminder,
    needsRescan,
    getIncident,
    requestQrPush,
    retryCompleteLogin,
    getPendingSession,
    getHelpStatus,
    getQrImage,
    noteSessionConsumed,
    stopWatcher,
    startMaintenanceSweep,
    stopMaintenanceSweep,
    // 确定性单轮巡检（测试/浏览器夹具用；不生成二维码、不开任何路由）。
    sweepMaintenanceOnce: sweepOnce,
    parseBarkTarget,
  };
}

// 运行时共享实例：runtime-engine 的注入回调与路由共用同一份状态。
let shared = null;
function getSharedWxLoginReminder() {
  if (!shared) {
    const store = require('../models/store');
    const { completeOwnedWxRescan } = require('./wx-rescan-save');
    shared = createWxLoginReminderService({
      getAccounts: store.getAccounts,
      log: (level, message, extra) => {
        if (level === '错误') barkLogger.warn(message, extra || {});
        else barkLogger.info(message, extra || {});
      },
      completeRescan: completeOwnedWxRescan,
    });
  }
  return shared;
}

module.exports = {
  LOCAL_SESSION_TTL_MS,
  BARK_SEND_TIMEOUT_MS,
  createWxLoginReminderService,
  getSharedWxLoginReminder,
  normalizeUserConfig,
  parseBarkTarget,
};
