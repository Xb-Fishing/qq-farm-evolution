const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { activityCatalog } = require('./activity-catalog-facts');

const HASH = /^[a-f0-9]{64}$/;
const SOURCE_NAMES = ['announcements', 'emails', 'solarCalendar', 'tasks', 'illustrated', 'mall', 'clientVersion'];
const SOURCE_KEYS = new Set([...SOURCE_NAMES, 'emails.1', 'emails.2', 'activities']);
const MAX_EVENTS = 2000;
const MAX_CONTEXT_EVENTS = 24;
const MAX_BYTES = 1024 * 1024;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function checkedFile(dataDir) {
  const root = path.resolve(dataDir); const file = path.join(root, 'activity-update-digest.json');
  for (let current = file;; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('更新待办路径含符号链接'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === path.dirname(current)) break;
  }
  return file;
}

function eventKey(entry) {
  return hash([entry.kind, entry.id || '', entry.source || '', entry.digest]);
}

function normalizeEntry(entry) {
  if (!entry || !['unknown', 'ended', 'game_facts', 'source_changed'].includes(entry.kind)
      || !(HASH.test(entry.digest) || (['unknown', 'ended'].includes(entry.kind) && /^[a-f0-9]{32}$/.test(entry.digest)))
      || !Number.isFinite(entry.firstSeenAt) || entry.firstSeenAt <= 0) throw new Error('更新待办条目无效');
  const item = { kind: entry.kind, digest: entry.digest, firstSeenAt: entry.firstSeenAt };
  if (['unknown', 'ended'].includes(item.kind)) {
    if (!Number.isSafeInteger(entry.id) || entry.id <= 0) throw new Error('更新待办编号无效');
    item.id = entry.id;
  }
  if (item.kind === 'source_changed') {
    if (!SOURCE_KEYS.has(entry.source)) throw new Error('更新待办来源无效');
    item.source = entry.source;
  }
  if (Array.isArray(entry.historyRefs)) item.historyRefs = entry.historyRefs.filter(ref => /^announcement-[a-f0-9]{64}\.json$/.test(ref)).slice(0, 30);
  item.key = eventKey(item);
  return item;
}

function readUpdateDigest(dataDir) {
  const file = checkedFile(dataDir);
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('更新待办文件无效或过大');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || !Array.isArray(value.unreviewed) || value.unreviewed.length > MAX_EVENTS) throw new Error('更新待办格式无效');
  const result = { ...value, version: 2, unreviewed: value.unreviewed.map(normalizeEntry), sourceHashes: {}, activityFacts: {} };
  for (const [name, digest] of Object.entries(value.sourceHashes || {})) if (SOURCE_KEYS.has(name) && HASH.test(digest)) result.sourceHashes[name] = digest;
  for (const [key, digest] of Object.entries(value.activityFacts || {})) if (/^(?:unknown|ended):[1-9]\d{0,15}$/.test(key) && HASH.test(digest)) result.activityFacts[key] = digest;
  return result;
}

function writeUpdateDigest(dataDir, value) {
  const file = checkedFile(dataDir);
  if (value.unreviewed.length > MAX_EVENTS) throw new Error('更新待办超过安全上限，原记录保留');
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('更新待办超过大小上限，原记录保留');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return value;
}

function recordUpdateDigest(dataDir, scanned, reportDigest) {
  const previous = readUpdateDigest(dataDir);
  const value = { ...(previous || {}), version: 2, updatedAt: scanned.scannedAt, digest: reportDigest,
    unreviewed: [...(previous?.unreviewed || [])], sourceHashes: { ...(previous?.sourceHashes || {}) },
    activityFacts: { ...(previous?.activityFacts || {}) }, announcementFacts: { ...(previous?.announcementFacts || {}) } };
  const append = entry => {
    const normalized = normalizeEntry(entry);
    if (!value.unreviewed.some(item => item.key === normalized.key)) value.unreviewed.push(normalized);
  };
  for (const [kind, ids] of [['unknown', scanned.online?.unknownActivityIds || []], ['ended', scanned.endedActivityIds || []]]) {
    for (const id of ids) {
      if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) continue;
      const activity = (scanned.online?.activities || []).find(row => Number(row.id) === Number(id));
      const identity = hash([Number(id), activity?.title || '', activity?.parentId || 0, activity?.startTime || 0, activity?.endTime || 0]);
      const key = `${kind}:${Number(id)}`;
      if (value.activityFacts[key] !== identity) {
        append({ kind, id: Number(id), digest: identity, firstSeenAt: scanned.scannedAt });
      }
      value.activityFacts[key] = identity;
    }
  }
  const evidence = scanned.online?.gameUpdateEvidence;
  let observations = 0;
  const observe = (source, digest, historyRefs) => {
    if (!HASH.test(digest)) return;
    observations++;
    if (value.sourceHashes[source] !== digest) append({ kind: 'source_changed', source, digest, historyRefs, firstSeenAt: scanned.scannedAt });
    value.sourceHashes[source] = digest;
  };
  for (const name of SOURCE_NAMES) {
    const source = evidence?.sources?.[name];
    if (name === 'announcements' && ['ok', 'partial'].includes(source?.status) && Array.isArray(source.entries)) {
      const known = source.listComplete === true ? {} : { ...value.announcementFacts };
      for (const entry of source.entries.slice(0, 30)) {
        if (!/^[1-9]\d{0,18}$/.test(entry.id) || !HASH.test(entry.titleHash)) throw new Error('公告事实格式无效');
        const old = value.announcementFacts[entry.id] || {};
        known[entry.id] = { titleHash: entry.titleHash,
          contentHash: entry.detailLoaded === true && HASH.test(entry.contentHash) ? entry.contentHash : old.contentHash || '',
          historyRef: /^announcement-[a-f0-9]{64}\.json$/.test(entry.historyRef) ? entry.historyRef : old.historyRef || '' };
      }
      value.announcementFacts = known;
      const sorted = Object.keys(known).sort().map(id => [id, known[id].titleHash, known[id].contentHash]);
      observe(name, hash(sorted), Object.values(known).map(entry => entry.historyRef).filter(Boolean));
    } else if (name === 'emails' && source?.boxes) {
      for (const box of [1, 2]) if (source.boxes[box]?.status === 'ok') observe(`emails.${box}`, source.boxes[box].factsHash);
    } else if (source?.status === 'ok') observe(name, source.factsHash, source.historyRefs);
  }
  // Older reports expose one aggregate hash; retain it without fabricating per-source observations.
  if (!observations && evidence?.factsComplete === true && HASH.test(evidence.semanticHash)) {
    if (evidence.semanticHash !== previous?.gameFacts) append({ kind: 'game_facts', digest: evidence.semanticHash, firstSeenAt: scanned.scannedAt });
    value.gameFacts = evidence.semanticHash;
  }
  // Only successful group reads replace the previous catalog. A failed read
  // must not look like removal of every reward.
  if (scanned.online?.available === true && Array.isArray(scanned.online.groups)
      && !scanned.online.groups.some(group => group?.error)
      && (scanned.online.groups.length > 0 || value.sourceHashes.activities)) {
    observe('activities', hash(activityCatalog(scanned.online.groups)));
  }
  return writeUpdateDigest(dataDir, value);
}

function selectPendingEvents(value) {
  const pending = value?.unreviewed || [];
  if (pending.length <= MAX_CONTEXT_EVENTS) return pending;
  const bounded = (rows, count) => {
    if (rows.length <= count) return rows;
    const oldest = Math.min(8, count);
    return [...rows.slice(0, oldest), ...(count > oldest ? rows.slice(-(count - oldest)) : [])];
  };
  const urgent = pending.filter(isUpdateTrigger);
  const chosen = bounded(urgent, MAX_CONTEXT_EVENTS);
  const remaining = MAX_CONTEXT_EVENTS - chosen.length;
  if (remaining > 0) chosen.push(...bounded(pending.filter(entry => !isUpdateTrigger(entry)), remaining));
  const keys = new Set(chosen.map(entry => entry.key));
  return pending.filter(entry => keys.has(entry.key));
}

function captureUpdateBatch(dataDir) {
  const value = readUpdateDigest(dataDir);
  const entries = selectPendingEvents(value);
  return { version: 1, entries, totalPending: value?.unreviewed.length || 0, overflow: value?.overflow === true,
    fingerprint: hash(entries.map(entry => entry.key)) };
}

function validateUpdateBatch(batch) {
  if (!batch || batch.version !== 1 || !Array.isArray(batch.entries)
      || batch.entries.length > MAX_CONTEXT_EVENTS) throw new Error('更新审查批次无效');
  const entries = batch.entries.map(normalizeEntry);
  if (hash(entries.map(entry => entry.key)) !== batch.fingerprint) throw new Error('更新审查批次指纹不匹配');
  return { ...batch, entries };
}

function isUpdateTrigger(entry) { return entry.kind !== 'source_changed' || ['announcements', 'activities', 'solarCalendar', 'clientVersion'].includes(entry.source); }

function updateTriggerFingerprint(batch) {
  const entries = validateUpdateBatch(batch).entries.filter(isUpdateTrigger);
  return entries.length ? hash(entries.map(entry => entry.key)) : '';
}

function markUpdateBatchDispatched(dataDir, batch, runId) {
  const normalized = validateUpdateBatch(batch);
  if (!/^[\w-]{1,100}$/.test(runId) || !normalized.entries.length) return false;
  const value = readUpdateDigest(dataDir);
  if (!value) return false;
  writeUpdateDigest(dataDir, { ...value, lastDispatched: { fingerprint: normalized.fingerprint,
    eventFingerprint: updateTriggerFingerprint(normalized), runId, at: Date.now() } });
  return true;
}

function acknowledgeUpdateBatch(dataDir, batch) {
  const { entries } = validateUpdateBatch(batch);
  const value = readUpdateDigest(dataDir);
  if (!value) return false;
  const reviewed = new Set(entries.map(entry => entry.key));
  const remaining = value.unreviewed.filter(entry => !reviewed.has(entry.key));
  if (remaining.length === value.unreviewed.length) return false;
  writeUpdateDigest(dataDir, { ...value, unreviewed: remaining });
  return true;
}

module.exports = { readUpdateDigest, recordUpdateDigest, selectPendingEvents, captureUpdateBatch,
  validateUpdateBatch, updateTriggerFingerprint, markUpdateBatchDispatched, acknowledgeUpdateBatch };
