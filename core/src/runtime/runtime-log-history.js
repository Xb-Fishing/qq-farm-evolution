const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ensureDataDir } = require('../config/runtime-paths');
const { sanitizeMeta } = require('../services/logger');

const LOG_LIMIT = 2000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_ROW_BYTES = 16 * 1024;
const FILENAME = 'runtime-panel-history.jsonl';

function searchable(entry) {
    entry._searchText = `${entry.msg || ''} ${entry.tag || ''} ${JSON.stringify(entry.meta || {})}`.toLowerCase();
    return entry;
}

function storedEntry(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const entry = sanitizeMeta(input);
    delete entry._searchText;
    for (const [key, limit] of Object.entries({ msg: 4096, tag: 80, action: 80, time: 64, accountId: 128, accountName: 256 })) {
        if (entry[key] !== undefined) entry[key] = String(entry[key]).slice(0, limit);
    }
    if (Buffer.byteLength(JSON.stringify(entry)) > MAX_ROW_BYTES) entry.meta = { truncated: true };
    return Buffer.byteLength(JSON.stringify(entry)) <= MAX_ROW_BYTES ? entry : null;
}

/** Panel history is private runtime data. It never restarts or calls an account. */
function createRuntimeLogHistory({ globalLogs, accountLogs }) {
    let filename;
    try { filename = path.join(fs.realpathSync(ensureDataDir()), FILENAME); } catch {}
    const push = (rows, entry) => { rows.push(searchable(entry)); if (rows.length > LOG_LIMIT) rows.shift(); };
    function open(flags) {
        if (!filename) throw new Error('history_unavailable');
        const fd = fs.openSync(filename, flags | (fs.constants.O_NOFOLLOW || 0), 0o600);
        try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.nlink !== 1) throw new Error('history_not_regular');
            return { fd, stat };
        } catch (error) { fs.closeSync(fd); throw error; }
    }
    try {
        const { fd, stat } = open(fs.constants.O_RDONLY);
        try {
            const length = Math.min(stat.size, MAX_FILE_BYTES * 2);
            const bytes = Buffer.alloc(length);
            fs.readSync(fd, bytes, 0, length, stat.size - length);
            let text = bytes.toString('utf8');
            if (stat.size > length) text = text.slice(text.indexOf('\n') + 1);
            for (const line of text.split('\n')) {
                try {
                    const record = JSON.parse(line);
                    if (record.version !== 1) continue;
                    if (record.kind === 'snapshot' && Array.isArray(record.runtime) && Array.isArray(record.accounts)) {
                        globalLogs.length = 0; accountLogs.length = 0;
                        for (const [rows, entries] of [[globalLogs, record.runtime], [accountLogs, record.accounts]]) {
                            for (const value of entries.slice(-LOG_LIMIT)) { const entry = storedEntry(value); if (entry) push(rows, entry); }
                        }
                    } else if (['runtime', 'account'].includes(record.kind)) {
                        const entry = storedEntry(record.entry);
                        if (entry) push(record.kind === 'runtime' ? globalLogs : accountLogs, entry);
                    }
                } catch { /* A truncated or invalid row cannot hide subsequent valid rows. */ }
            }
        } finally { fs.closeSync(fd); }
    } catch { /* Missing/unreadable history must not interrupt the game connection. */ }

    function boundedTail(rows, budget) {
        const entries = []; let size = 0;
        for (let i = rows.length - 1; i >= 0 && entries.length < LOG_LIMIT; i--) {
            const entry = storedEntry(rows[i]); if (!entry) continue;
            const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
            if (size + bytes > budget) break;
            entries.push(entry); size += bytes;
        }
        return entries.reverse();
    }
    function snapshot() {
        let temporary;
        try {
            const { fd } = open(fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND);
            fs.closeSync(fd);
            const budget = MAX_FILE_BYTES / 4 - 1024;
            const record = { version: 1, kind: 'snapshot', runtime: boundedTail(globalLogs, budget), accounts: boundedTail(accountLogs, budget) };
            temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
            const out = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
            try { fs.writeFileSync(out, `${JSON.stringify(record)}\n`); fs.fsyncSync(out); } finally { fs.closeSync(out); }
            fs.renameSync(temporary, filename);
            temporary = null;
            return true;
        } catch { return false; }
        finally { if (temporary) { try { fs.unlinkSync(temporary); } catch {} } }
    }
    function append(kind, input) {
        let opened;
        try {
            const entry = storedEntry(input); if (!entry) return false;
            opened = open(fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND);
            fs.fchmodSync(opened.fd, 0o600);
            if (opened.stat.size >= MAX_FILE_BYTES) { fs.closeSync(opened.fd); opened = null; return snapshot(); }
            if (opened.stat.size) {
                const end = Buffer.alloc(1);
                fs.readSync(opened.fd, end, 0, 1, opened.stat.size - 1);
                if (end[0] !== 10) fs.writeSync(opened.fd, '\n');
            }
            fs.writeSync(opened.fd, `${JSON.stringify({ version: 1, kind, entry })}\n`);
            return true;
        } catch { return false; }
        finally { if (opened) { try { fs.closeSync(opened.fd); } catch {} } }
    }
    return { recordRuntime: entry => append('runtime', entry), recordAccount: entry => append('account', entry), snapshot };
}

module.exports = { createRuntimeLogHistory, LOG_LIMIT, MAX_FILE_BYTES, FILENAME };
