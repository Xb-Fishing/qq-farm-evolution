'use strict';

/**
 * 微信登录提醒 / 自助重扫路由。
 *
 * - /api/user/wx-login-reminder/*：当前登录用户自己的 Bark 配置与测试发送。
 * - /api/wx-login-help/*：账号状态与「发送二维码」；一律先过 canAccessAccount，
 *   推送目标始终取账号属主（account.username）的配置，与管理员代点无关。
 * - /api/wx-login-qr-image/:token：唯一在认证门之前注册的只读 PNG 能力令牌，
 *   供 Bark 通知内嵌二维码图片；过期/替换/消费后即吊销。
 */

const BARK_DOC_URL = 'https://github.com/Finb/Bark';
const LOCAL_HOST_RE = /^(?:localhost|127\.0\.0\.1|\[::1\]|::1|0\.0\.0\.0)$/i;

/** 站内可访问的 http(s) 地址：无内嵌凭据；启用时还必须手机可达（非本机回环）。 */
function checkPublicUrl(raw, { requireRemote }) {
  const value = String(raw || '').trim();
  if (!value) return requireRemote ? '必填：手机要能打开这个地址' : '';
  let url;
  try {
    url = new URL(value);
  } catch {
    return '地址格式不正确';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '只支持 http/https 地址';
  if (url.username || url.password) return '地址不能包含用户名密码';
  if (requireRemote && LOCAL_HOST_RE.test(url.hostname)) {
    return '手机无法访问 localhost/127.0.0.1，请填写局域网或公网地址';
  }
  return '';
}

function validateReminderConfigPatch(body, currentConfig) {
  const errors = {};
  const patch = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') errors.enabled = '开关必须为布尔值';
    else patch.enabled = body.enabled;
  }
  if (body.barkServer !== undefined && String(body.barkServer || '').trim() !== '') {
    const problem = checkPublicUrl(body.barkServer, { requireRemote: false });
    if (problem) errors.barkServer = problem;
    else patch.barkServer = String(body.barkServer).trim();
  }
  if (body.deviceKey !== undefined) {
    const key = String(body.deviceKey || '').trim();
    if (key) {
      if (key.length > 512 || /\s/.test(key) || [...key].some(character => character.codePointAt(0) < 32)) {
        errors.deviceKey = '设备 Key 格式不正确';
      } else if (/^https?:\/\//i.test(key)) {
        const problem = checkPublicUrl(key, { requireRemote: false });
        if (problem) errors.deviceKey = '复制的链接格式不正确';
      }
    }
    patch.deviceKey = key;
  }
  if (body.serverUrl !== undefined) {
    const value = String(body.serverUrl || '').trim().replace(/\/+$/, '');
    const mergedEnabled = patch.enabled !== undefined ? patch.enabled : currentConfig.enabled === true;
    const problem = checkPublicUrl(value, { requireRemote: mergedEnabled });
    if (problem) errors.serverUrl = problem;
    else patch.serverUrl = value;
  } else if (body.enabled === true && !String(currentConfig.serverUrl || '').trim()) {
    errors.serverUrl = '启用提醒前必须填写面板访问地址（手机要能打开）';
  }
  if (body.advanceEnabled !== undefined) {
    if (typeof body.advanceEnabled !== 'boolean') errors.advanceEnabled = '开关必须为布尔值';
    else patch.advanceEnabled = body.advanceEnabled;
  }
  if (body.maintenanceCycleHours !== undefined) {
    const value = Number(body.maintenanceCycleHours);
    if (!Number.isFinite(value) || value < 4 || value > 168) {
      errors.maintenanceCycleHours = '维护周期需为 4–168 小时';
    } else {
      patch.maintenanceCycleHours = value;
      // 只改周期时也校验与既有提前量的关系（提前量必须严格小于新周期）。
      if (body.advanceMinutes === undefined) {
        const currentAdvance = Number(currentConfig.advanceMinutes) || 60;
        if (currentAdvance >= value * 60) {
          errors.maintenanceCycleHours = '维护周期必须大于当前的提前提醒分钟数';
        }
      }
    }
  }
  if (body.advanceMinutes !== undefined) {
    const value = Number(body.advanceMinutes);
    const cycle = patch.maintenanceCycleHours !== undefined
      ? patch.maintenanceCycleHours : (Number(currentConfig.maintenanceCycleHours) || 24);
    if (!Number.isFinite(value) || value < 5 || value >= cycle * 60) {
      errors.advanceMinutes = `提前提醒需 ≥5 分钟且小于维护周期（当前 ${cycle} 小时）`;
    } else {
      patch.advanceMinutes = value;
    }
  }
  return { errors, patch };
}

function buildAccountView(account) {
  return {
    id: String(account.id),
    name: String(account.name || ''),
    platform: String(account.platform || ''),
    username: String(account.username || ''),
  };
}

function requireCurrentUser(req, res) {
  const currentUser = req.currentUser;
  if (!currentUser) {
    res.status(401).json({ ok: false, error: '未登录' });
    return null;
  }
  return currentUser;
}

function sanitizeConfigForClient(config) {
  // 用户读取/编辑自己的配置（同下线提醒返回 token 的先例）；仅去除内部字段。
  return {
    enabled: config.enabled === true,
    barkServer: String(config.barkServer || ''),
    deviceKey: String(config.deviceKey || ''),
    serverUrl: String(config.serverUrl || ''),
    advanceEnabled: config.advanceEnabled !== false,
    maintenanceCycleHours: Number(config.maintenanceCycleHours) || 24,
    advanceMinutes: Number(config.advanceMinutes) || 60,
  };
}

function registerAdminWxLoginReminderRoutes({
  app,
  canAccessAccount,
  resolveAccountReference,
  findAccountByRef,
  getAccountsForUser,
  logger,
}) {
  const reminder = require('../services/wx-login-reminder').getSharedWxLoginReminder();

  app.get('/api/user/wx-login-reminder/config', (req, res) => {
    try {
      const currentUser = requireCurrentUser(req, res);
      if (!currentUser) return;
      res.json({
        ok: true,
        config: sanitizeConfigForClient(reminder.getUserConfig(currentUser.username)),
        defaults: { barkServer: 'https://api.day.app' },
        docUrl: BARK_DOC_URL,
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // 保存配置：必须等待 setUserConfig 完成（内部串行 + 落盘），不能把
  // Promise 序列化进响应；字段非法 400，状态文件不可用 503。
  app.post('/api/user/wx-login-reminder/config', async (req, res) => {
    try {
      const currentUser = requireCurrentUser(req, res);
      if (!currentUser) return;
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const { errors, patch } = validateReminderConfigPatch(body, reminder.getUserConfig(currentUser.username));
      if (Object.keys(errors).length > 0) {
        return res.status(400).json({ ok: false, error: '配置校验失败', fields: errors });
      }
      let config;
      try {
        config = await reminder.setUserConfig(currentUser.username, patch);
      } catch {
        logger?.warn?.('微信重扫提醒配置保存失败', { user: currentUser.username });
        return res.status(503).json({ ok: false, error: '配置暂不可用，请稍后重试' });
      }
      // 启用时把此前记录但未发送的待重扫事件补发一次（每代次至多一条）。
      let dispatched = [];
      if (config.enabled === true) {
        try {
          dispatched = await reminder.dispatchPendingForUser(currentUser.username);
        } catch { /* 补发失败不影响保存结果 */ }
      }
      res.json({ ok: true, config: sanitizeConfigForClient(config), dispatched });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // 测试通知只在用户显式点击时发送一次；不携带任何账号凭据。
  app.post('/api/user/wx-login-reminder/test', async (req, res) => {
    try {
      const currentUser = requireCurrentUser(req, res);
      if (!currentUser) return;
      const config = reminder.getUserConfig(currentUser.username);
      if (!config.enabled) {
        return res.status(400).json({ ok: false, error: '请先启用提醒并保存配置' });
      }
      const result = await reminder.sendBark(config, {
        title: '微信重扫提醒测试',
        body: '这是一条测试通知：微信授权失效时，提醒会像这样发送到你的设备。',
      });
      if (!result.ok) {
        logger?.warn?.('微信重扫提醒测试失败', { user: currentUser.username, error: result.error });
        return res.status(400).json({ ok: false, error: result.error || '发送失败' });
      }
      res.json({ ok: true, message: '测试通知已发送' });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/wx-login-help/status', (req, res) => {
    try {
      const currentUser = requireCurrentUser(req, res);
      if (!currentUser) return;
      const accountRef = String((req.query && req.query.accountId) || '').trim();
      if (!accountRef) {
        return res.status(400).json({ ok: false, error: '缺少 accountId' });
      }
      const accountId = resolveAccountReference(accountRef) || accountRef;
      if (!canAccessAccount(req, accountId)) {
        return res.status(403).json({ ok: false, error: '无权访问此账号' });
      }
      const account = findAccountByRef(getAccountsForUser(), accountId);
      if (!account) {
        return res.status(404).json({ ok: false, error: '账号不存在' });
      }
      if (String(account.platform || '') !== 'wx') {
        return res.status(400).json({ ok: false, error: '仅微信扫码账号支持自助重扫' });
      }
      const status = reminder.getHelpStatus(account);
      // 拉取状态会推进已过期会话的状态视图；响应用最新值。
      res.json({
        ok: true,
        data: {
          ...status,
          account: buildAccountView(account),
        },
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // 用户显式点击「现在发送二维码 / 重新发送二维码」才会调用；页面从不自动重复。
  app.post('/api/wx-login-help/send-qr', async (req, res) => {
    try {
      const currentUser = requireCurrentUser(req, res);
      if (!currentUser) return;
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const accountRef = String(body.accountId || '').trim();
      if (!accountRef) {
        return res.status(400).json({ ok: false, error: '缺少 accountId' });
      }
      const accountId = resolveAccountReference(accountRef) || accountRef;
      if (!canAccessAccount(req, accountId)) {
        return res.status(403).json({ ok: false, error: '无权访问此账号' });
      }
      const account = findAccountByRef(getAccountsForUser(), accountId);
      if (!account) {
        return res.status(404).json({ ok: false, error: '账号不存在' });
      }
      if (String(account.platform || '') !== 'wx') {
        return res.status(400).json({ ok: false, error: '仅微信扫码账号支持自助重扫' });
      }
      if (!String(account.username || '').trim()) {
        return res.status(400).json({ ok: false, error: '账号没有属主用户，无法自助重扫' });
      }

      const result = await reminder.requestQrPush({ account, origin: currentUser.username });
      if (result.superseded === true) {
        // 更新的发送/扫码已接管：不报错，前端刷新状态即可看到新会话。
        return res.json({ ok: true, data: { superseded: true } });
      }
      logger?.info?.('自助重扫二维码已生成', {
        accountId: String(account.id),
        pushed: result.pushed === true,
      });
      res.json({
        ok: true,
        data: {
          session: result.session,
          pushed: result.pushed,
          pushError: result.pushError,
        },
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // 显式「重试完成登录」：同一会话补一次换码+保存（不重发二维码、不重放确认）。
  app.post('/api/wx-login-help/retry-login', async (req, res) => {
    try {
      const currentUser = requireCurrentUser(req, res);
      if (!currentUser) return;
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const accountRef = String(body.accountId || '').trim();
      if (!accountRef) {
        return res.status(400).json({ ok: false, error: '缺少 accountId' });
      }
      const accountId = resolveAccountReference(accountRef) || accountRef;
      if (!canAccessAccount(req, accountId)) {
        return res.status(403).json({ ok: false, error: '无权访问此账号' });
      }
      const account = findAccountByRef(getAccountsForUser(), accountId);
      if (!account) {
        return res.status(404).json({ ok: false, error: '账号不存在' });
      }
      if (String(account.platform || '') !== 'wx') {
        return res.status(400).json({ ok: false, error: '仅微信扫码账号支持自助重扫' });
      }
      const result = await reminder.retryCompleteLogin(account);
      if (!result.ok) {
        return res.status(400).json({ ok: false, error: result.error || '重试失败' });
      }
      res.json({
        ok: true,
        data: {
          started: result.started === true,
          startError: result.error || '',
        },
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });
}

/**
 * 公开二维码图片读取：必须注册在认证门之前（唯一例外，不放宽白名单）。
 * 能力令牌为 256 位随机值，只绑当前有效会话；仅返回 PNG，无用户/账号/凭据信息。
 */
function registerWxLoginQrImageRoute(app) {
  const reminder = require('../services/wx-login-reminder').getSharedWxLoginReminder();

  app.get('/api/wx-login-qr-image/:token', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const token = String(req.params && req.params.token || '');
    const image = reminder.getQrImage(token);
    if (!image) {
      // 410：令牌从未存在（枚举尝试）、已过期、被新二维码替换或会话已消费。
      return res.status(410).end();
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(image.png);
  });
}

module.exports = {
  registerAdminWxLoginReminderRoutes,
  registerWxLoginQrImageRoute,
};
