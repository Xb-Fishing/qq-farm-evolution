'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createGameSceneCoordinator } = require('./game-scene-coordinator');

function bindRanchScene(options) {
  let scheduler;
  const account = String(process.env.FARM_ACCOUNT_ID || '');
  const file = () => {
    if (!account) throw new Error('牧场请求未绑定账号');
    return require('../config/runtime-paths').getDataFile(`ranch-scene-${crypto.createHash('sha256').update(account).digest('hex').slice(0, 24)}.json`);
  };
  const coordinator = createGameSceneCoordinator({ ...options,
    encodeScene: id => require('../services/ranch-codec').encode('PlayerSceneLoginRequest', { global_scene_id: id }),
    decodeScene: body => require('../services/ranch-codec').decode('PlayerSceneLoginReply', body),
    load: () => {
      if (!account) return null;
      try { return JSON.parse(fs.readFileSync(file(), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    save: value => {
      const target = file(); fs.mkdirSync(path.dirname(target), { recursive: true });
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      try { fs.renameSync(temporary, target); } finally { fs.rmSync(temporary, { force: true }); }
    },
    priority: ms => {
      const behavior = require('../utils/behavior');
      return require('../services/own-quiet-priority').isActive()
        || behavior.ownHarvestIsDue() || behavior.ownHarvestIsImminent(ms)
        || behavior.stealIsDue() || behavior.stealIsImminent(ms)
        || options.urgent?.() === true;
    },
    scheduleRecovery: (callback, delay) => {
      scheduler ||= require('../services/scheduler').createScheduler('ranch_scene');
      scheduler.setTimeoutTask('recover_farm_scene', delay, callback);
    },
    cancelRecovery: () => scheduler?.clear('recover_farm_scene'),
  });
  return coordinator;
}
module.exports = { bindRanchScene };
