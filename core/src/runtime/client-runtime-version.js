const CLIENT_VERSION_RE = /^\d+(?:\.\d+){2,4}_\d{8}$/;
// Owner confirmed the current official UI version 1.16.3.8 on 2026-11-08;
// build tag agrees with reviewed client metadata (public-reference-2 @ 0e80007be156).
const VERIFIED_CLIENT_VERSION = '1.16.3.8_20261028';
function validClientVersion(value) { return typeof value === 'string' && value.length <= 64 && CLIENT_VERSION_RE.test(value); }
function compareClientVersions(a, b) {
  const parts = value => { const [version, date] = value.split('_'); return [...version.split('.').map(BigInt), ...Array(5 - version.split('.').length).fill(0n), BigInt(date)]; };
  const left = parts(a); const right = parts(b);
  for (let i = 0; i < left.length; i++) { if (left[i] > right[i]) return 1; if (left[i] < right[i]) return -1; }
  return 0;
}
function reject(reason) { throw Object.assign(new Error('连接版本同步校验失败'), { code: `SESSION_CLIENT_VERSION_${reason}` }); }
// A version is applied only by the authenticated manager configuration path.
// This helper never sends a game request, reconnects, changes platform, or writes credentials.
function prepareClientRuntime(envelope, { accountId, platform, currentVersion, state = {}, approvedVersions = null, historicalVersions = [] }) {
  if (envelope === undefined) return null; // Legacy business rollback preserves the current host version.
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
    || Object.keys(envelope).sort().join(',') !== 'accountId,clientVersion,issuer,platform,revision,schema'
    || envelope.schema !== 1 || !validClientVersion(envelope.clientVersion)
    || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(envelope.issuer || '')
    || !Number.isSafeInteger(envelope.revision) || envelope.revision <= 0) reject('INVALID');
  if (typeof envelope.accountId !== 'string' || envelope.accountId !== String(accountId)
    || envelope.platform !== platform || !['qq', 'wx'].includes(platform)) reject('BINDING');
  const same = envelope.clientVersion === currentVersion;
  const older = validClientVersion(currentVersion) && compareClientVersions(envelope.clientVersion, currentVersion) < 0;
  // A separately approved compatibility package may recognize its own prior
  // version during an old kernel's business rollback, without downgrading it.
  if (older && historicalVersions.includes(envelope.clientVersion)) return { apply: false, nextState: { ...state } };
  if (!same && approvedVersions && !approvedVersions.includes(envelope.clientVersion)) reject('UNAPPROVED');
  if (!same && state.issuer === envelope.issuer && envelope.revision < state.revision) reject('STALE');
  return { apply: !same && !older, clientVersion: envelope.clientVersion,
    nextState: { issuer: envelope.issuer, revision: state.issuer === envelope.issuer ? Math.max(state.revision || 0, envelope.revision) : envelope.revision } };
}
module.exports = { CLIENT_VERSION_RE, VERIFIED_CLIENT_VERSION, validClientVersion, compareClientVersions, prepareClientRuntime };
