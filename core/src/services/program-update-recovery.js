'use strict';
// Called only by the proven helper after it has entered the stop phase.
const fs = require('node:fs');
async function recover({ context, contextFile, updateState, dataDir, panePid, paneStart, tmuxTarget, botPid,
    newPid, newStart, sessions, physicalProof, oldFingerprint, oldRoot, oldCommit, api }) {
    const { collectProcesses, processStarttime, panePidOf, isDescendantOf, aliveNonZombie, stopBotTree, waitFor, portFree,
        paneAcceptingCommands, sendRestart, findRestartedBot, holdsSocket, listeningInodes, healthOk, logicSnapshot, verifySessions, verifyPhysical } = api;
    if (panePidOf(tmuxTarget) !== panePid || processStarttime(panePid) !== paneStart) throw new Error('rollback_pane_changed');
    if (logicSnapshot(oldRoot).fingerprint !== oldFingerprint) throw new Error('rollback_source_changed');
    // A late-starting new manager is found by exact argv/root and pane identity.
    if (!newPid) {
        const found = findRestartedBot(panePid, api.targetArgv, botPid, 0);
        if (found) {
            const foundStart = processStarttime(found);
            if (!foundStart || !aliveNonZombie(found, foundStart) || !isDescendantOf(found, panePid, collectProcesses())
                || findRestartedBot(panePid, api.targetArgv, botPid, 0) !== found || processStarttime(found) !== foundStart) throw new Error('rollback_process_unproven');
            newPid = found;
            newStart = foundStart;
        }
    }
    if (newPid) {
        const actualStart = processStarttime(newPid);
        if (!actualStart) {
            if (fs.existsSync(`/proc/${newPid}`)) throw new Error('rollback_process_unproven');
        } else {
            if (!newStart || actualStart !== newStart) throw new Error('rollback_process_unproven');
            if (aliveNonZombie(newPid, newStart)) {
                if (!isDescendantOf(newPid, panePid, collectProcesses())) throw new Error('rollback_process_unproven');
                await stopBotTree(newPid, newStart, collectProcesses(), sessions);
            }
        }
        // A proven exited/zombie target requires no signal. Its normal startup
        // failure must still restore the old manager after port/pane checks.
    }
    if (!await waitFor(() => portFree(context.adminPort), 15000)) throw new Error('rollback_port_busy');
    if (!await waitFor(() => paneAcceptingCommands(panePid), 10000)) throw new Error('rollback_pane_busy');
    require('./program-update-overlay').restoreOverlay(updateState.overlay);
    require('./program-update').restoreSharedProof(dataDir, updateState);
    fs.writeFileSync(contextFile, JSON.stringify(context), { mode: 0o600 }); fs.chmodSync(contextFile, 0o600);
    // The caller already pinned this private context; only its path reaches tmux.
    sendRestart(contextFile);
    const recovered = await waitFor(() => findRestartedBot(panePid, context.argv, newPid || botPid, 0), 30000);
    if (!recovered) throw new Error('rollback_start_failed');
    const recoveredStart = processStarttime(recovered);
    const ready = await waitFor(async () => {
        if (!aliveNonZombie(recovered, recoveredStart) || !holdsSocket(recovered, listeningInodes(context.adminPort)) || !await healthOk(context.adminPort)) return false;
        const proof = await verifySessions({ dataDir, proofs: sessions, final: true, expectedBusinessCommit: oldCommit });
        return proof.ok && proof.outcomes.every(item => item.state === 'preserved') && await verifyPhysical(dataDir, physicalProof);
    }, 90000);
    if (!ready || logicSnapshot(oldRoot).fingerprint !== oldFingerprint) throw new Error('rollback_not_ready');
    return { newPid: recovered, newStarttime: recoveredStart, restoredCommit: oldCommit };
}
module.exports = { recover };
