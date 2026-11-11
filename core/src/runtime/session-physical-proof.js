'use strict';
const fs = require('node:fs');
const { accountsAt } = require('./session-update');
const { connectSession } = require('./session-registry');
function tcpSockets(pid) {
    const owned = new Set(fs.readdirSync(`/proc/${pid}/fd`).flatMap(fd => {
        try { const m = fs.readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/); return m ? [m[1]] : []; } catch { return []; }
    }));
    const sockets = [];
    for (const family of ['tcp', 'tcp6']) for (const line of fs.readFileSync(`/proc/net/${family}`, 'utf8').split('\n').slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (fields.length > 9 && fields[3] === '01' && owned.has(fields[9]) && Number.parseInt(fields[2].split(':').at(-1), 16) === 443) sockets.push(fields[9]);
    }
    return sockets.sort();
}
async function capture(dataDir) {
    const hosts = [];
    for (const account of accountsAt(dataDir).filter(a => a.autoLogin !== false)) {
        const session = await connectSession(dataDir, account);
        if (session.state === 'absent') continue;
        if (session.state !== 'present') throw new Error('physical_session_unproven');
        try {
            const { facts } = await session.client.call('status', {}, 10000);
            if (facts.game.connected !== true) continue;
            const sockets = tcpSockets(facts.host.pid);
            if (!sockets.length) throw new Error('physical_socket_unproven');
            hosts.push({ accountId: String(account.id), hostId: facts.host.hostId, pid: facts.host.pid, starttime: facts.host.starttime,
                socketInode: session.descriptor.socketInode, sockets, connectionEpoch: facts.game.connectionEpoch, loginEpoch: facts.game.loginEpoch,
                firstLoginReadyAt: facts.game.firstLoginReadyAt, loginReadyAt: facts.game.loginReadyAt });
        } finally { session.client.close(); }
    }
    return hosts.sort((a, b) => a.accountId.localeCompare(b.accountId));
}
async function verify(dataDir, before) { return JSON.stringify(await capture(dataDir)) === JSON.stringify(before); }
module.exports = { capture, verify, tcpSockets };
