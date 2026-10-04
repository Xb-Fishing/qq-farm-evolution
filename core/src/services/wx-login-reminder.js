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
 * 会漏掉无在线 Bot 时的手机进场，也不能区分另一台 PC）。
 *
 * 所有 Bark 通知只携带一张当次生成的扫码二维码图片（无标题、正文仅一
 * 个空白字符）：上游二维码接口真实返回 JPEG，这里按魔数嗅探 PNG/JPEG
 * 后原样字节透传（不做格式转换、不引新依赖），图片经公开能力令牌路由
 * 按真实 Content-Type 输出。自动提醒（提前/终态）到点即生成并推送新
 * 二维码；已有可用扫码会话（未过期且在等待/已扫/保存中）时不重复推送、
 * 绝不取消用户会话，手动刷新永远可以重发。
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
const JPEG_MAGIC = Buffer.from([0xFF, 0xD8, 0xFF]);
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

/** 魔数嗅探：只认 PNG / JPEG 原始字节（拒绝 HTML/SVG/未知内容），不做格式转换。 */
function sniffImageMime(buffer) {
  if (!Buffer.isBuffer(buffer)) return '';
  if (buffer.length > 8 && buffer.subarray(0, 4).equals(PNG_MAGIC)) return 'image/png';
  if (buffer.length > 4 && buffer.subarray(0, 3).equals(JPEG_MAGIC)) return 'image/jpeg';
  return '';
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
    scanCheckpoints: {},
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
    // 授权已保存/登录码待换的持久检查点：只有非秘密绑定字段（属主/wxid/
    // 扫码代次/阶段码/短错误），绝不落凭据。
    scanCheckpoints: value => Number.isInteger(Number(value.savedAt)) && Number(value.savedAt) >= 0
      && Number.isInteger(Number(value.generation)) && Number(value.generation) >= 0
      && typeof value.owner === 'string' && typeof value.wxid === 'string'
      && typeof value.stage === 'string' && typeof value.error === 'string',
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
  const retrySaved = typeof deps.retrySaved === 'function'
    ? deps.retrySaved : null;
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
        scanCheckpoints: cloneEntries('scanCheckpoints'),
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
   * keepSessionId（自助完成链）：显式携带属主/wxid/守卫绑定时，全部在
   * 注册表互斥临界区内、真正落盘那一刻复验——锁外读到的 pending 结论会
   * 在排队期间过期（新二维码请求的 supersede 是同步的）。迟到完成（会话
   * 已被更新请求取代/守卫失配/绑定变化）一律不动：不取消新二维码、不推
   * 进代次、不污染新请求的检查点，直接返回 false（不伪报已接受）。
   *
   * 同时以服务端当前时间记录「真实接受扫码」基线（维护参考计划唯一合法
   * 起点，绝不用 lastSuccess/updatedAt/进程启动等推断），并作废该代次的
   * 提前提醒声明（新扫码是唯一重新武装方式）。「其他终端登录」信号在同
   * 属主/同微信绑定时保留真实旧时间戳，绝不改写成扫码时刻。
   * 成功返回新代次（>=1），被取代返回 false。
   */
  async function noteAcceptedScan(accountId, options = {}) {
    const key = String(accountId || '');
    if (!key || !SAFE_KEY_RE.test(key)) return false;
    const keepSessionId = String(options.keepSessionId || '');
    const guard = typeof options.guard === 'function' ? options.guard : null;
    const expectedOwner = String(options.owner || '').trim();
    const expectedWxid = String(options.wxid || '');
    const pending = pendingByAccount.get(key);
    // 锁外预检（快速路径）：自己的会话已明显让位就直接回绝；真实判定一律
    // 以临界区内执行时的状态为准。
    const ownCompletion = !!keepSessionId && !!pending && pending.sessionId === keepSessionId;
    if (keepSessionId && !ownCompletion) {
      // 迟到的自助完成：自己的一次性会话已让位给更新的二维码/新扫码。
      // 不得取消新请求（supersedePendingSessions 会误杀）、不得推进代次。
      return false;
    }
    if (!ownCompletion) supersedePendingSessions(key);
    let acceptedGeneration = 0;
    await commitRegistry((data) => {
      // ── 临界区内复验：互斥队列真正执行时，锁外结论可能已被新请求推翻 ──
      if (guard && !guard()) return false;
      if (keepSessionId) {
        // 自助完成只有当前会话仍是自己的才推进：排队期间被新二维码/新扫码
        // 取代（pending 已删除/换会话）→ 迟到回调不推进、不取消、不污染。
        const livePending = pendingByAccount.get(key);
        if (!livePending || String(livePending.sessionId) !== keepSessionId) return false;
      }
      if (expectedOwner || expectedWxid) {
        const bound = findAccount(key);
        if (!bound) return false;
        if (expectedOwner && String(bound.username || '').trim() !== expectedOwner) return false;
        if (expectedWxid && String(bound.wxid || '') !== expectedWxid) return false;
      }
      const nextGeneration = (Number(data.generations[key]) || 0) + 1;
      acceptedGeneration = nextGeneration;
      data.generations[key] = nextGeneration;
      // 代次推进与「自己那轮会话」的快照推进必须在同一临界区内原子完成：
      // 若快照在 await 恢复后才刷新，两者之间的微任务窗口内任何
      // getPendingSession 都会按快照过时误判并作废正在完成的会话。
      if (keepSessionId) {
        const self = pendingByAccount.get(key);
        if (self && String(self.sessionId) === String(keepSessionId)) {
          self.snapshot.generation = nextGeneration;
        }
      }
      delete data.incidents[key];
      delete data.advanceNotices[key];
      // 每次真实接受的新扫码都让上一轮的「授权已保存/码待换」检查点作废：
      // 本轮完成链如再遇换码失败会写回自己的检查点。
      delete data.scanCheckpoints[key];
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
    if (!acceptedGeneration) return false;
    const livePending = pendingByAccount.get(key);
    if (keepSessionId && livePending === pending) {
      // 本次自助保存推进代次，保留它的完成状态（快照代次已在临界区内
      // 原子刷新）；会话标记已消费。其他扫码取消旧任务。
      noteSessionConsumed(pending.sessionId, key);
    }
    return acceptedGeneration;
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

  // ── 「授权已保存 / 登录码待换」持久检查点（2026-10-04）──
  // 已确认扫码的完整长凭据落盘后、农场 Code 尚未换成功或启动尚未被接受时
  // 写入。只记非秘密绑定字段（属主/wxid/真实扫码代次/阶段码/短错误），进程
  // 重启后仍在：状态页可如实展示「授权已保存、登录未完成」，显式「重试登录
  // 农场」据此从持久凭据补一次，而不必让用户重新扫码。
  //
  // 检查点绑定「真实扫码代次」：写入/更新/清除都在注册表互斥区内比对调用
  // 方捕获的期望代次与绑定字段——迟到的旧完成/旧重试既不能把新授权的检查
  // 点改写成自己的，也不能把新授权的检查点清掉。getScanCheckpoint 只在
  // 代次仍是当前代次、时间戳合法、账号绑定未变时可见。

  /**
   * 凭据已落盘、登录未收口：写入/更新检查点。options.generation 为调用方
   * 捕获的期望扫码代次（缺省时以临界区内的当前代次为准，仅供测试替身）；
   * 代次已前进（新扫码已接管）则拒绝写入。同代次重复调用只更新阶段与错误
   * 描述（savedAt 不重写）。成功返回绑定的代次，失败返回 false。
   */
  function noteScanCodePending(accountId, options = {}) {
    const key = String(accountId || '');
    if (!key || !SAFE_KEY_RE.test(key)) return Promise.resolve(false);
    const stage = String((options && options.stage) || 'code_pending');
    const error = sanitizeErrorText(options && options.error);
    const expectedGenerationRaw = Number(options && options.generation);
    const hasExpected = Number.isFinite(expectedGenerationRaw) && expectedGenerationRaw > 0;
    const guard = !options || typeof options.guard !== 'function' ? null : options.guard;
    const expectedOwner = String((options && options.owner) || '').trim();
    const expectedWxid = String((options && options.wxid) || '');
    let boundGeneration = 0;
    return commitRegistry((data) => {
      // 临界区内复验守卫与显式绑定：迟到的旧完成/旧重试不得写入。
      if (guard && !guard()) return false;
      const live = findAccount(key);
      if (!live || String(live.platform || '') !== 'wx') return false;
      const owner = String(live.username || '').trim();
      const wxid = String(live.wxid || '');
      if (!owner || !wxid) return false;
      if (expectedOwner && owner !== expectedOwner) return false;
      if (expectedWxid && wxid !== expectedWxid) return false;
      const liveGeneration = Number(data.generations[key]) || 0;
      if (hasExpected && liveGeneration !== expectedGenerationRaw) return false;
      const existing = data.scanCheckpoints[key];
      boundGeneration = hasExpected ? expectedGenerationRaw : liveGeneration;
      if (boundGeneration <= 0) return false;
      if (isPlainObject(existing)) {
        // 只允许同代次自更新（阶段/错误描述）；跨代次绝不可覆盖新授权的检查点。
        if (Number(existing.generation) !== boundGeneration) return false;
        existing.stage = stage;
        existing.error = error;
        return true;
      }
      data.scanCheckpoints[key] = { owner, wxid, savedAt: now(), generation: boundGeneration, stage, error };
      return true;
    }).then(() => boundGeneration || false, () => false);
  }

  /**
   * 登录收口（Code 已换成且启动已提交，或授权被判定明确失效）：清除检查点。
   * 只有绑定匹配（期望代次/属主/wxid 与检查点一致）才清除；不匹配（迟到的
   * 旧结果想清掉新授权的检查点）时不动。真实清除返回 true。
   *
   * options.connected === true 仅限可信 runtime 的连接收口传（新恢复 worker
   * 真实连上）：此时除清检查点外，还把同一扫码代次自己的内存 pending 收口
   * 为 saved（code_pending / 带失败说明的 saved 清 detail）——否则自动恢复
   * 后页面仍显示可重试，用户再点会多换一次 Code、重启健康农场。普通
   * definitive 清除（保存链/重试链自己的收口）绝不冒充保存成功；pending/
   * scanned/saving 的新二维码会话任何情况下都不碰。
   */
  function noteScanCodeResolved(accountId, options = {}) {
    const key = String(accountId || '');
    if (!key || !SAFE_KEY_RE.test(key)) return Promise.resolve(false);
    const expectedGenerationRaw = Number(options && options.generation);
    const hasExpected = Number.isFinite(expectedGenerationRaw) && expectedGenerationRaw > 0;
    const expectedOwner = String((options && options.owner) || '').trim();
    const expectedWxid = String((options && options.wxid) || '');
    const observedConnected = !!(options && options.connected === true);
    const guard = !options || typeof options.guard !== 'function' ? null : options.guard;
    let resolved = false; // commitRegistry 以注册表对象 resolve，真实结果自持
    return commitRegistry((data) => {
      // 临界区内复验守卫：迟到的旧结果不得清掉新授权的检查点。
      if (guard && !guard()) return false;
      const entry = data.scanCheckpoints[key];
      if (!isPlainObject(entry)) return false;
      if (hasExpected && Number(entry.generation) !== expectedGenerationRaw) return false;
      if (expectedOwner && String(entry.owner) !== expectedOwner) return false;
      if (expectedWxid && String(entry.wxid) !== expectedWxid) return false;
      delete data.scanCheckpoints[key];
      resolved = true;
      if (observedConnected) {
        // 已真实删掉匹配检查点后才允许同步内存 pending：严格同代次 + 同属主，
        // 且只动已完成授权那轮的收口状态（新二维码的 pending/scanned/saving
        // 原样保留，绝不误标保存成功）。
        const pending = pendingByAccount.get(key);
        if (pending && Number(pending.snapshot && pending.snapshot.generation) === Number(entry.generation)
          && String(pending.owner || '') === String(entry.owner)
          && (pending.state === 'code_pending'
            || (pending.state === 'saved' && String(pending.detail || '') !== ''))) {
          pending.state = 'saved';
          pending.detail = '';
        }
      }
      return true;
    }).then(() => resolved, () => false);
  }

  /** 只读视图：代次未过时、时间戳合法、账号绑定未变才可见；无任何秘密字段。 */
  function getScanCheckpoint(accountId) {
    const data = loadRegistry();
    const entry = data.scanCheckpoints[String(accountId)];
    if (!isPlainObject(entry)) return null;
    const savedAt = Number(entry.savedAt);
    const generation = Number(entry.generation);
    const nowMs = now();
    // 过时代次（新扫码已接管）或时间戳异常（非正数/未来值）一律视为不存在。
    if (!Number.isInteger(savedAt) || savedAt <= 0 || savedAt > nowMs) return null;
    if (!Number.isInteger(generation) || generation <= 0) return null;
    if ((Number(data.generations[String(accountId)]) || 0) !== generation) return null;
    const account = findAccount(accountId);
    if (!account || String(account.platform || '') !== 'wx'
      || String(account.username || '').trim() !== String(entry.owner)
      || String(account.wxid || '') !== String(entry.wxid)) return null;
    return { savedAt, generation, stage: String(entry.stage || 'code_pending'), error: sanitizeErrorText(entry.error) };
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
   * 单账号提前提醒判定：入口先做同步快照（accountId/owner/wxid/意愿），
   * 声明临界区内用「下一份注册表状态 + 实时账号绑定」重验全部条件后才
   * 落盘声明——排队期间的暂停/换绑/禁用/改参数必须拦下且不消耗唯一一次
   * 声明；外发前再读当前配置与状态做最后一道校验。到点外发的内容是
   * 当次生成并推送的扫码二维码图片（仅图片，无标题/正文）；已有可用
   * 扫码会话时跳过不重复、绝不取消。任何不满足都静默跳过。
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
    // 到点外发即推送一张当次生成的扫码二维码（仅图片，无标题/正文）。
    // 资格守卫只捕获基线原语（代次/扫码时刻/属主/微信），触网前/注册前/
    // 外发前复查：等待期间关提前开关/关总开关/暂停/换绑/新扫码都取消外
    // 发且不暴露会话；已有可用扫码会话时让位不重发；跳过不消耗记录字段
    // （sentAt/lastError 保持原状），生成/推送失败如实记录且不自动重试。
    let pushed = false;
    let pushErrorText = '';
    let skipReason = '';
    try {
      const qrResult = await requestQrPush({
        account: liveAccount,
        origin: 'advance-plan',
        automatic: {
          mode: 'advance-plan',
          guard: () => {
            const data = loadRegistry();
            if (registryBlocked) return false;
            if ((Number(data.generations[key]) || 0) !== generation) return false;
            const liveScan = data.acceptedScans[key];
            if (!isPlainObject(liveScan) || Number(liveScan.at) !== scanAt
              || Number(liveScan.generation) !== generation
              || String(liveScan.owner || '') !== snapshot.owner
              || String(liveScan.wxid || '') !== snapshot.wxid) return false;
            const liveIncident = data.incidents[key];
            if (liveIncident && (Number(liveIncident.generation) || 0) === generation) return false;
            const liveNotice = data.advanceNotices[key];
            if (!isPlainObject(liveNotice) || Number(liveNotice.generation) !== generation) return false;
            const qrAccount = findAccount(key);
            if (!qrAccount || String(qrAccount.platform || '') !== 'wx') return false;
            if (String(qrAccount.username || '').trim() !== snapshot.owner
              || String(qrAccount.wxid || '') !== snapshot.wxid) return false;
            if (qrAccount.autoLogin === false) return false;
            const qrConfig = normalizeUserConfig(
              Object.prototype.hasOwnProperty.call(data.users, snapshot.owner)
                ? data.users[snapshot.owner] : {},
            );
            if (qrConfig.enabled !== true || qrConfig.advanceEnabled !== true) return false;
            if (!parseBarkTarget(qrConfig.deviceKey, qrConfig.barkServer).key) return false;
            if (!buildHelpLink(qrConfig, key)) return false;
            const liveReminderAt = scanAt + qrConfig.maintenanceCycleHours * 3600_000
              - qrConfig.advanceMinutes * 60_000;
            if (now() < liveReminderAt) return false;
            return isRecentOtherTerminalLogin(
              latestOtherTerminalLogin(data, key), snapshot.owner, snapshot.wxid, now());
          },
        },
      });
      if (!qrResult) skipReason = 'empty';
      else if (qrResult.superseded === true) skipReason = 'superseded';
      else if (qrResult.skipped === 'active-session') skipReason = 'active-session';
      else if (qrResult.skipped === 'not-eligible') skipReason = 'not-eligible';
      else {
        pushed = qrResult.pushed === true;
        pushErrorText = String(qrResult.pushError || '');
      }
    } catch (error) {
      pushErrorText = sanitizeErrorText(error && error.message) || '二维码生成失败';
    }
    if (skipReason) {
      log('系统', `微信扫码维护二维码未推送（${skipReason === 'active-session' ? '已有可用二维码' : '等待期间条件已变化'}）: ${name}`, { accountId: key });
    }
    await commitRegistry((next) => {
      const entry = next.advanceNotices[key];
      if (!entry || (Number(entry.generation) || 0) !== generation) return false;
      if (pushed) {
        entry.sentAt = now();
        entry.lastError = '';
        log('系统', `微信扫码维护二维码已推送: ${name}`, { accountId: key });
      } else if (pushErrorText) {
        entry.lastError = sanitizeErrorText(pushErrorText);
        log('错误', `微信扫码维护二维码推送失败: ${name}`, { accountId: key, error: entry.lastError });
      }
      return pushed || !!pushErrorText;
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
    // 纯图片通知：可见标题/正文全空（正文仅一个空白字符满足上游必填），
    // 只带 device_key/image/url/group 元数据。文字通知仍要求非空正文。
    const imageOnly = payload.imageOnly === true;
    const body = imageOnly ? ' ' : String(payload.body || '').trim();
    if (!imageOnly && !body) return { ok: false, error: '通知内容为空' };
    // 纯图片通知没有图片就是空通知（避免发出一条无附件的空白提醒）。
    if (imageOnly && !String(payload.image || '').trim()) {
      return { ok: false, error: '纯图片通知缺少二维码图片' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), sendTimeoutMs);
    try {
      const response = await fetchImpl(`${target.server.replace(/\/+$/, '')}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          title: imageOnly ? '' : String(payload.title || '微信登录提醒').trim(),
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
        // 凭据已明确失效：同代次的「授权已保存/码待换」检查点一并收口，
        // 状态页回到「需要重新扫码」，重试入口不再假装还有可续授权。
        const hadCheckpoint = !!data.scanCheckpoints[key];
        delete data.scanCheckpoints[key];
        // 本代次已用过唯一一次自动提醒（提前维护提醒，含发送失败）：
        // 如实记录失效与 needsRescan，但不再外发第二条。
        const early = data.advanceNotices[key];
        const earlyClaimed = isPlainObject(early) && (Number(early.generation) || 0) === generation;
        const incident = data.incidents[key];
        if (incident && (Number(incident.generation) || 0) === generation) {
          if (incident.claimed === true) {
            // 同一代次已声明（含上次发送失败）只补 needsRescan 标记，不重复外发。
            if (incident.needsRescan === true) return hadCheckpoint;
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
          if (!ready) return hadCheckpoint;
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
      // 守卫基线原语：等待期间账号对象可变（wxid/暂停），不得持引用比对。
      const expectedWxid = String(liveAccount.wxid || '');

      const ownerConfig = getUserConfig(owner);
      const link = buildHelpLink(ownerConfig, key);
      if (!ownerConfig.enabled || !link || !parseBarkTarget(ownerConfig.deviceKey, ownerConfig.barkServer).key) return false;

      // 外发改推一张当次生成的扫码二维码（仅图片，无标题/正文）。资格守卫
      // 复查自身事件（代次/needsRescan/声明）与实时绑定/暂停/配置：等待期
      // 间任何失配都取消外发且不暴露会话；已确认/保存中的用户会话绝不取
      // 消；跳过不消耗记录字段，生成/推送失败如实记录（声明保留、不自动
      // 重试），手动刷新永远可以重发。
      let pushed = false;
      let pushErrorText = '';
      let skipReason = '';
      try {
        const qrResult = await requestQrPush({
          account: liveAccount,
          origin: 'credential-invalid',
          automatic: {
            mode: 'credential-invalid',
            guard: () => {
              const data = loadRegistry();
              if (registryBlocked) return false;
              if ((Number(data.generations[key]) || 0) !== generation) return false;
              const liveIncident = data.incidents[key];
              if (!isPlainObject(liveIncident) || Number(liveIncident.generation) !== generation
                || liveIncident.needsRescan !== true || liveIncident.claimed !== true) return false;
              const qrAccount = findAccount(key);
              if (!qrAccount || String(qrAccount.platform || '') !== 'wx') return false;
              if (String(qrAccount.username || '').trim() !== owner) return false;
              if (String(qrAccount.wxid || '') !== expectedWxid) return false;
              if (qrAccount.autoLogin === false) return false;
              const qrConfig = getUserConfig(owner);
              if (qrConfig.enabled !== true) return false;
              if (!parseBarkTarget(qrConfig.deviceKey, qrConfig.barkServer).key) return false;
              return !!buildHelpLink(qrConfig, key);
            },
          },
        });
        if (!qrResult) skipReason = 'empty';
        else if (qrResult.superseded === true) skipReason = 'superseded';
        else if (qrResult.skipped === 'active-session') skipReason = 'active-session';
        else if (qrResult.skipped === 'not-eligible') skipReason = 'not-eligible';
        else {
          pushed = qrResult.pushed === true;
          pushErrorText = String(qrResult.pushError || '');
        }
      } catch (error) {
        pushErrorText = sanitizeErrorText(error && error.message) || '二维码生成失败';
      }
      if (skipReason) {
        log('系统', `微信重扫二维码未推送（${skipReason === 'active-session' ? '已有可用二维码' : '等待期间条件已变化'}）: ${name}`, { accountId: key });
      }
      // 迟到完成不得改写新代次的记录。
      await commitRegistry((data) => {
        const incident = data.incidents[key];
        if (!incident || (Number(incident.generation) || 0) !== generation) return false;
        if (pushed) {
          incident.sentAt = now();
          incident.lastError = '';
          log('系统', `微信重扫二维码已推送: ${name}`, { accountId: key });
        } else if (pushErrorText) {
          incident.lastError = sanitizeErrorText(pushErrorText);
          log('错误', `微信重扫二维码推送失败: ${name}`, { accountId: key, error: incident.lastError });
        }
        return pushed || !!pushErrorText;
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
      // 服务端按魔数嗅探出的真实图片类型（前端 dataURL 用；缺省回退 PNG）。
      qrMimeType: entry.qrMimeType || 'image/png',
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

  // 自动请求不得打断的「可用扫码会话」：未过期即在服务中（等待/已扫/保存中）。
  // code_pending 阶段扫码已消费、凭据已持久化，新二维码可以正常取代。
  const ACTIVE_SESSION_STATES = ['pending', 'scanned', 'saving'];

  /**
   * 发送扫码二维码（手动点击或自动提醒到点共用）：新建扫码会话（旧会话/
   * 守望/图片能力立即作废），按账号属主的 Bark 配置即时推送「纯二维码图片」
   * 通知（无标题、正文仅一个空白字符），并启动有界服务端守望。请求快照在
   * 每个 await 之后复验：更新的扫码/请求一旦发生，迟到产物（二维码/图片
   * 能力/推送）整体回滚，不覆盖新状态（isSnapshotCurrent 请求代栅栏）。
   *
   * automatic（提前/终态自动提醒）：须携带稳定资格守卫（guard 闭包，捕获
   * 基线原语而非可变账号引用），在触网前/注册前/外发前三道复查——任何一
   * 道失配都取消「刚拿到的」二维码（不碰更新的请求），不注册 pending/
   * 图片能力/守望（页面不可见、零轮询）。已有可用扫码会话时不取消、不重
   * 复推送（让位于用户手上的二维码）；与手动在途请求合并为同一次。手动
   * 请求无守卫、永远直接取代，且 Bark 未配置时仍照常在页面展示（旧行为）。
   */
  async function requestQrPush({ account, origin, automatic = false }) {
    const accountId = String(account.id);
    const eligibility = isPlainObject(automatic) && typeof automatic.guard === 'function'
      ? automatic.guard : null;
    const existing = inFlightSend.get(accountId);
    if (existing) return existing;
    if (automatic) {
      // 检查点 A（触网/取代之前）：资格已失（关提前/关总开关/暂停/换绑/新
      // 扫码）就不动任何现有会话、不生成二维码。
      if (eligibility && !eligibility()) return { skipped: 'not-eligible' };
      const pending = pendingByAccount.get(accountId);
      if (pending && ACTIVE_SESSION_STATES.includes(pending.state)
        && now() < pending.expiresAt && isSnapshotCurrent(pending.snapshot)) {
        return { skipped: 'active-session', session: sessionPublicView(pending) };
      }
    }

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
      // 上游真实返回 JPEG（线上事故：PNG-only 校验曾致 500）：按魔数嗅探
      // PNG/JPEG，原样字节透传，拒绝 HTML/SVG/未知内容。
      const qrMimeType = sniffImageMime(Buffer.from(qrBase64, 'base64'));
      if (!qrMimeType) {
        try { adapter.cancelWxSession(sessionId, owner); } catch { /* 尽力清理 */ }
        throw new Error('二维码内容不是有效的 PNG/JPEG 图片');
      }
      if (!isSnapshotCurrent(snapshot)) {
        try { adapter.cancelWxSession(sessionId, owner); } catch { /* 尽力清理 */ }
        return { superseded: true };
      }
      // 检查点 B（注册之前）：等待期间资格被收回 → 取消刚拿到的二维码，
      // 不注册 pending/图片能力/守望（页面不可见、零轮询）；更新的请求已由
      // 上一步请求代栅栏拦下，这里只清理本次产物。
      if (eligibility && !eligibility()) {
        try { adapter.cancelWxSession(sessionId, owner); } catch { /* 尽力清理 */ }
        return { skipped: 'not-eligible' };
      }
      // 会话真实起止来自 adapter（本地会话），不自造第二套时钟。
      const createdAt = Number(qr.Data.CreatedAt) || now();
      const expiresAt = Number(qr.Data.ExpiresAt) || createdAt + LOCAL_SESSION_TTL_MS;
      snapshot.sessionId = sessionId;

      const token = nodeCrypto.randomBytes(32).toString('hex');
      const entry = {
        accountId, sessionId, owner, snapshot,
        createdAt, expiresAt,
        state: 'pending', detail: '', qrBase64, qrMimeType, imageToken: token,
        pushed: false, pushError: '',
        pushOrigin: automatic
          ? `automatic:${isPlainObject(automatic) && automatic.mode ? String(automatic.mode) : String(origin || '')}`
          : String(origin || 'manual'),
      };
      pendingByAccount.set(accountId, entry);
      imageTokens.set(token, {
        accountId, sessionId, owner, qrBase64, qrMimeType, expiresAt, snapshot,
      });

      let pushed = false;
      let pushError = '';
      const ownerConfig = getUserConfig(owner);
      const target = parseBarkTarget(ownerConfig.deviceKey, ownerConfig.barkServer);
      // 检查点 C（外发之前）：注册与外发之间虽无 await，仍按同一守卫复核；
      // 失配则整体回滚本次产物（与被取代同构），绝不留下半成品会话。
      if (eligibility && !eligibility()) {
        revokeImageTokensFor(accountId, sessionId);
        if (pendingByAccount.get(accountId) === entry) pendingByAccount.delete(accountId);
        try { adapter.cancelWxSession(sessionId, owner); } catch { /* 尽力清理 */ }
        return { skipped: 'not-eligible' };
      }
      // 自动请求在二维码生成期间账号可能被暂停：外发前再拦一次，宁可不发。
      const liveAccountForPush = automatic ? findAccount(accountId) : null;
      const pausedDuringWait = automatic
        && (!liveAccountForPush || liveAccountForPush.autoLogin === false);
      if (!pausedDuringWait && ownerConfig.enabled && ownerConfig.serverUrl && target.key) {
        const link = buildHelpLink(ownerConfig, accountId);
        // 通知只带一张二维码图片：标题空、正文仅一个空白字符（纯图模式）。
        const result = await sendBark(ownerConfig, {
          imageOnly: true,
          ...(link ? { url: link } : {}),
          image: `${ownerConfig.serverUrl}/api/wx-login-qr-image/${token}`,
        });
        pushed = result.ok;
        pushError = result.ok ? '' : sanitizeErrorText(result.error);
      } else {
        pushError = pausedDuringWait ? '账号已暂停，未推送'
          : !ownerConfig.enabled ? '未启用 Bark 提醒'
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
      // 保存成功为事实；启动失败/被拒不冒充成功启动，如实附加说明。
      markPendingState(accountId, watcher.sessionId, 'saved',
        result.started === false && result.error ? result.error : '');
      log('系统', `${successLabel}${result.stage ? `（${result.stage}）` : ''}: ${watcher.accountName || accountId}`, { accountId });
    } else if (result.retryable) {
      // 凭据已持久化、换码临时失败：授权不再依赖扫码会话，检查点（持久）
      // 接管后续，等显式重试或既有自动恢复调度。
      markPendingState(accountId, watcher.sessionId, 'code_pending', result.error || '');
    } else {
      markPendingState(accountId, watcher.sessionId, 'error', result.error || '扫码结果保存失败');
      log('错误', `自助重新扫码保存失败${result.stage ? `（${result.stage}）` : ''}: ${watcher.accountName || accountId}`, {
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
   * 显式「重试登录农场」（2026-10-04 重设计）：授权已持久化（完成链换码
   * 临时失败 / 启动失败 / 进程重启后凭持久检查点恢复）时，用当前账号凭据
   * 再换一次全新 Code 并启动——不重发二维码、不重放 OAuth 确认、不推进
   * 扫码代次、不依赖已消费或到期的扫码会话。并发点击合并为同一次。
   */
  const inFlightRetry = new Map(); // accountId -> Promise

  function retryCompleteLogin(account) {
    const accountId = String(account && account.id);
    const existing = inFlightRetry.get(accountId);
    if (existing) return existing;
    const task = (async () => {
      const pending = pendingByAccount.get(accountId);
      const checkpoint = getScanCheckpoint(accountId);
      // 判定本次重试是否有可做的活：有持久检查点（凭据已保存、码未换成或
      // 启动未提交，含进程重启后）或上一轮保存后启动失败（detail 非空）才
      // 动手；纯等待态交给守望，已完成的幂等返回。
      const pendingNeedsRetry = !!pending
        && (pending.state === 'code_pending' || (pending.state === 'saved' && pending.detail));
      if (!checkpoint && !pendingNeedsRetry) {
        if (!pending) return { ok: false, error: '当前没有待完成的登录，请重新发送二维码' };
        if (pending.state === 'saved') return { ok: true, started: true, alreadySaved: true };
        if (['pending', 'scanned', 'saving'].includes(pending.state)) {
          return { ok: false, error: '当前扫码会话不需要重试，请等待自动完成或重新发送二维码' };
        }
        return { ok: false, error: '本地扫码会话已到期或失败，请重新发送二维码' };
      }
      if (!retrySaved) return { ok: false, error: '服务端未接入扫码保存流程' };
      // 只读绑定快照（不推进请求代，避免误杀当前 pending 会话的守望）：
      // 重试等待期间的新二维码/新扫码/暂停仍会被 isSnapshotCurrent 拦下。
      const snapshot = {
        accountId,
        owner: String(account.username || '').trim(),
        wxid: String(account.wxid || ''),
        generation: currentGeneration(accountId),
        epoch: requestEpochs.get(accountId) || 0,
      };
      const isCurrent = () => isSnapshotCurrent(snapshot)
        && (!pendingByAccount.get(accountId) || pendingByAccount.get(accountId) === pending);
      const generation = checkpoint ? checkpoint.generation : snapshot.generation;
      if (pending && pending.sessionId) markPendingState(accountId, pending.sessionId, 'saving');
      const outcome = await retrySaved({ accountId, isCurrent, generation, reminder: self });
      if (pending && pending.sessionId && !(outcome && outcome.superseded)) {
        applyCompletionState(accountId, { ...watcherLike(accountId, pending, account) }, outcome, '重试登录农场');
      }
      return outcome;
    })();
    inFlightRetry.set(accountId, task);
    return task.finally(() => {
      if (inFlightRetry.get(accountId) === task) inFlightRetry.delete(accountId);
    });
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

  /**
   * 图片能力读取：过期/被替换/已消费/账号已删或改绑一律视为吊销。
   * 按服务端嗅探出的真实类型返回原样字节（png 字段为兼容保留的原始字节）。
   */
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
    return {
      png: Buffer.from(entry.qrBase64, 'base64'),
      contentType: entry.qrMimeType || 'image/png',
      accountId: entry.accountId,
    };
  }

  function getPendingSession(accountId) {
    const entry = pendingByAccount.get(String(accountId));
    if (!entry) return null;
    if (!isSnapshotCurrent(entry.snapshot)) { abandonPending(entry); return null; }
    if (now() >= entry.expiresAt) {
      // code_pending/saved 阶段扫码已消费、授权已持久化：到期不改判，交给
      // 持久检查点与显式重试；只有纯等待/已扫未确认才因会话到期作废。
      if (['pending', 'scanned'].includes(entry.state)) {
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
      // 持久「授权已保存/登录未收口」检查点（无 pending 会话时仍可见，
      // 支持进程重启后的显式重试）。无任何秘密字段。
      scanCheckpoint: getScanCheckpoint(account.id),
      // 扫码维护参考计划（与扫码会话独立：不生成二维码、不改运行状态）。
      plan: buildPlanView(account),
    };
  }

  const self = {
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
    noteScanCodePending,
    noteScanCodeResolved,
    getScanCheckpoint,
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
  return self;
}

// 运行时共享实例：runtime-engine 的注入回调与路由共用同一份状态。
let shared = null;
function getSharedWxLoginReminder() {
  if (!shared) {
    const store = require('../models/store');
    const { completeOwnedWxRescan, retrySavedWxScanLogin } = require('./wx-rescan-save');
    shared = createWxLoginReminderService({
      getAccounts: store.getAccounts,
      log: (level, message, extra) => {
        if (level === '错误') barkLogger.warn(message, extra || {});
        else barkLogger.info(message, extra || {});
      },
      completeRescan: completeOwnedWxRescan,
      retrySaved: retrySavedWxScanLogin,
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
