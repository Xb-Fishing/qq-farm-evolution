// Compatible with the reviewed account/password + x-admin-token Code bridge.
// The prefix scopes its save semantics; authentication stays on the normal API.
const PREFIX = '/mengka-nt';
function registerMengkaNtBridge(app) {
  app.use((req, res, next) => {
    if (!req.path.startsWith(`${PREFIX}/`)) return next();
    const target = req.path.slice(PREFIX.length);
    const allowed = (target === '/api/login' && req.method === 'POST')
      || (target === '/api/accounts' && ['GET', 'POST'].includes(req.method))
      || (target === '/api/auth/status' && req.method === 'GET');
    if (!allowed) return res.status(404).json({ ok: false, error: '萌卡 NT 桥接接口不存在' });
    req.mengkaNtBridge = true;
    req.url = req.url.slice(PREFIX.length);
    return next();
  });
  app.get('/api/auth/status', (req, res, next) => req.mengkaNtBridge
    ? res.json({ ok: true, data: { passwordLogin: true } }) : next());
}

function prepareMengkaNtAccount(raw, accounts, user, resolveId) {
  if (!user) return { error: '未登录', status: 401 };
  const qq = String(raw.qq || raw.uin || '').trim();
  const uin = String(raw.uin || raw.qq || '').trim();
  if (raw.platform !== 'qq' || !/^[1-9]\d{4,19}$/.test(qq) || qq !== uin
    || typeof raw.code !== 'string' || !raw.code.trim() || raw.code.length > 4096) {
    return { error: '萌卡 NT 仅接受绑定同一 QQ 的有效农场 Code', status: 400 };
  }
  const existing = raw.id
    ? accounts.find(account => String(account.id) === String(resolveId(raw.id)))
    : accounts.find(account => account.platform === 'qq' && account.username === user.username
      && String(account.qq || account.uin || '') === qq);
  if (raw.id && !existing) return { error: '账号不存在', status: 404 };
  if (existing && (existing.platform !== 'qq' || String(existing.qq || existing.uin || '') !== qq)) {
    return { error: '推送 QQ 与目标账号不一致，请核对萌卡中的账号', status: 409 };
  }
  return { existing, body: {
    ...(existing ? { id: existing.id } : {}),
    name: String(raw.name || existing?.name || qq).slice(0, 100), code: raw.code.trim(),
    platform: 'qq', uin: qq, qq, loginType: 'mengka_nt',
  } };
}

module.exports = { registerMengkaNtBridge, prepareMengkaNtAccount };
