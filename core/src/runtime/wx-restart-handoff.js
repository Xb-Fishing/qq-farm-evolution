const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const unavailable = reasonCode => ({ ok: false, reasonCode });

const HANDOFF_TTL_MS = 90000;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function accountStamp(account, autoLogin) {
  return digest([String(account.id), account.username || '', account.wxid || '',
    account.platform || '', autoLogin(account), account.code || '', account.loginBuffer || '',
    account.refreshtoken || '', account.accesstoken || '', Number(account.wxCredentialLastSuccessAt) || 0]);
}

function wxAccountsStamp(accounts, autoLogin) {
  return digest(accounts.filter(a => a.platform === 'wx').map(a =>
    [String(a.id), accountStamp(a, autoLogin)]).sort((a, b) => a[0].localeCompare(b[0])));
}

function validEnvelope(handoff, expected, now) {
  return handoff && handoff.version === 1 && Array.isArray(handoff.accounts)
    && handoff.targetCommit === expected.targetCommit && handoff.nonce === expected.nonce
    && handoff.oldPid === expected.oldPid && handoff.oldStartTicks === expected.oldStartTicks
    && /^[a-f0-9]{40,64}$/.test(handoff.targetCommit || '')
    && /^[a-z0-9-]{16,128}$/i.test(handoff.nonce || '')
    && Number.isSafeInteger(handoff.createdAt) && handoff.createdAt <= now + 1000
    && handoff.expiresAt > now && handoff.expiresAt <= handoff.createdAt + HANDOFF_TTL_MS;
}

function createWxRestartCoordinator({ getAccounts, isAutoLogin, workers, autoCodeRefresh, now = Date.now }) {
  const list = () => getAccounts().accounts || [];
  const unknownConnection = () => list().some(a => a.platform === 'wx' && isAutoLogin(a)
    && workers[String(a.id)] && typeof workers[String(a.id)].status?.connection?.connected !== 'boolean');
  const connected = () => list().filter(a => a.platform === 'wx' && isAutoLogin(a)
    && workers[String(a.id)]?.status?.connection?.connected === true);
  const liveIds = () => connected().map(a => String(a.id)).sort();

  function validateWxRestart(handoff) {
    const time = now();
    if (unknownConnection() || !validEnvelope(handoff, handoff || {}, time)
      || wxAccountsStamp(list(), isAutoLogin) !== handoff.accountsStamp
      || JSON.stringify(liveIds()) !== JSON.stringify(handoff.accounts.map(a => a.accountId).sort())) return false;
    return handoff.accounts.every(item => autoCodeRefresh.isRestartGenerationCurrent(item.accountId, item.generation));
  }

  async function prepareWxRestart(request) {
    if (unknownConnection()) return unavailable('unknown_connection');
    const selected = connected();
    const entries = [];
    const createdAt = now();
    const initialStamp = wxAccountsStamp(list(), isAutoLogin);
    const initialAccounts = new Map(list().filter(a => a.platform === 'wx').map(a =>
      [String(a.id), accountStamp(a, isAutoLogin)]));
    for (const account of selected) {
      if (request.guard && !request.guard()) return unavailable('cancelled');
      const before = list().find(a => String(a.id) === String(account.id));
      if (!before || accountStamp(before, isAutoLogin) !== initialAccounts.get(String(account.id)))
        return unavailable('account_changed');
      const result = await autoCodeRefresh.prepareRestartCode(account.id, { guard: request.guard, intentKey: request.nonce });
      if (!result?.code || (request.guard && !request.guard()))
        return unavailable(request.guard && !request.guard() ? 'cancelled' : 'unavailable');
      const latest = list().find(a => String(a.id) === String(account.id));
      if (!latest || !isAutoLogin(latest)) return unavailable('account_changed');
      entries.push({ accountId: String(account.id), accountStamp: accountStamp(latest, isAutoLogin),
        code: result.code, generation: result.generation });
    }
    // Expected token rotation during preparation is bound in each final stamp.
    // Changes to a different account invalidate the batch too.
    const current = list();
    const selectedIds = new Set(entries.map(a => a.accountId));
    const untouchedChanged = current.some(a => a.platform === 'wx' && !selectedIds.has(String(a.id))
      && accountStamp(a, isAutoLogin) !== initialAccounts.get(String(a.id)))
      || current.filter(a => a.platform === 'wx').length !== initialAccounts.size;
    const handoff = { version: 1, targetCommit: request.targetCommit, nonce: request.nonce,
      oldPid: request.oldPid, oldStartTicks: request.oldStartTicks, createdAt,
      expiresAt: createdAt + HANDOFF_TTL_MS, accountsStamp: wxAccountsStamp(current, isAutoLogin), accounts: entries };
    // Per-account preparation guards handle selected accounts; unchanged empty
    // batches must also reject a concurrent rescan or new account.
    if ((request.guard && !request.guard()) || untouchedChanged || (!entries.length && handoff.accountsStamp !== initialStamp)
      || entries.some(item => item.accountStamp !== accountStamp(current.find(a => String(a.id) === item.accountId) || {}, isAutoLogin))
      || !validateWxRestart(handoff)) return unavailable('account_changed');
    return { ok: true, handoff };
  }
  return { prepareWxRestart, validateWxRestart };
}

/** Claim a private file once, validate against canonical accounts, then return Codes.
 * A rejected file never provides a partial account handoff or a reusable Code. */
function consumeWxRestartHandoff({ file, directory, targetCommit, actualCommit, nonce,
  getAccounts, isAutoLogin, now = Date.now }) {
  const result = new Map();
  if (!file) return result;
  let claimed = '';
  try {
    const base = path.resolve(directory);
    if (fs.realpathSync(base) !== base || path.dirname(path.resolve(file)) !== base
      || path.basename(file) !== `${nonce}.json`) return result;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 1024 * 1024) return result;
    claimed = `${file}.consuming`;
    fs.renameSync(file, claimed);
    const value = JSON.parse(fs.readFileSync(claimed, 'utf8'));
    if (targetCommit !== actualCommit || !validEnvelope(value, {
      targetCommit, nonce, oldPid: value.oldPid, oldStartTicks: value.oldStartTicks,
    }, now())) return result;
    const accounts = getAccounts().accounts || [];
    if (wxAccountsStamp(accounts, isAutoLogin) !== value.accountsStamp) return result;
    for (const entry of value.accounts) {
      const account = accounts.find(a => String(a.id) === entry.accountId);
      if (!account || account.platform !== 'wx' || !isAutoLogin(account)
        || accountStamp(account, isAutoLogin) !== entry.accountStamp
        || typeof entry.code !== 'string' || !entry.code || result.has(entry.accountId)) return new Map();
      result.set(entry.accountId, { code: entry.code, accountStamp: entry.accountStamp, expiresAt: value.expiresAt });
    }
    return result;
  } catch { return new Map(); }
  finally { if (claimed) { try { fs.unlinkSync(claimed); } catch { /* no retry of claimed material */ } } }
}

module.exports = { HANDOFF_TTL_MS, accountStamp, wxAccountsStamp, createWxRestartCoordinator, consumeWxRestartHandoff };
