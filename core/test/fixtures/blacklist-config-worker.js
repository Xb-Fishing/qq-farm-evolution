const { parentPort } = require('node:worker_threads');
const network = require('../../src/utils/network');
const friendApi = require('../../src/services/friend-api');
const farmApi = require('../../src/services/farm-api');
const visits = require('../../src/services/friend-visit');
const limits = require('../../src/services/friend-operation-limits');
const utils = require('../../src/utils/utils');
// Only game I/O and delays are stubbed; configuration and IPC use the real paths.
network.getUserState = () => ({ gid: 1 });
friendApi.getAllFriends = async () => ({ game_friends: [301, 302, 303].map(gid => ({ gid })) });
farmApi.getAllLands = async () => ({ operation_limits: [{ id: limits.BAD_SHARED_OPERATION_ID, day_times: 0, day_times_lt: 100 }] });
visits.visitFriend = async () => { throw new Error('simulated bad-action failure'); };
limits.canOperateBad = () => true;
utils.randomDelay = async () => {};
const { isFriendBadPaused, runBadOnceOnStartup } = require('../../src/services/friend-orchestrator');

const send = parentPort ? parentPort.postMessage.bind(parentPort) : process.send.bind(process);
const run = async message => {
  if (message.type === 'ipc-failure') {
    process.send = () => { throw new Error('simulated IPC failure'); };
  }
  if (message.type === 'pause') await runBadOnceOnStartup(true);
  const paused = isFriendBadPaused();
  send({ type: 'checked', paused });
  if (parentPort) parentPort.close();
  else process.disconnect();
};
if (parentPort) parentPort.once('message', run);
else process.once('message', run);
send({ type: 'ready' });
