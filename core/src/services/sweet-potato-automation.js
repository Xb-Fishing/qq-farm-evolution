const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CHECK_INTERVAL = 5 * 60 * 1000;
const AFTER_ACTION_INTERVAL = 30000;
const DEFAULT_POLICY = Object.freeze({
  enabled: false, claim: true, grow: false, sell: false, keepPotatoes: 0, saleBatch: 1000,
  exchangeIndex: 0, coinBudget: 0, keepCoins: 0,
});
const LABELS = {
  seeds: '领种', dividend: '领分红', harvestCrop: '收获', plantCrop: '种植', sale: '售卖', exchange: '兑换',
};

function integer(value, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error('以薯换福托管设置超出范围');
  }
  return value;
}

function normalizePolicy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('托管设置无效');
  const next = { ...DEFAULT_POLICY, ...Object.fromEntries(Object.keys(DEFAULT_POLICY)
    .filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]])) };
  for (const key of ['enabled', 'claim', 'grow', 'sell']) {
    if (typeof next[key] !== 'boolean') throw new Error('托管开关无效');
  }
  integer(next.keepPotatoes, 0, 999999999);
  integer(next.saleBatch, 1, 8000);
  integer(next.exchangeIndex, 0, 10);
  integer(next.coinBudget, 0, 999999999);
  integer(next.keepCoins, 0, 999999999);
  if ((next.exchangeIndex > 0) !== (next.coinBudget > 0)) throw new Error('自动兑换需要同时选择商品并设置每日预算');
  return next;
}

const farmDay = at => new Date(at + 8 * 3600000).toISOString().slice(0, 10);
const initial = () => ({
  version: 1, policy: { ...DEFAULT_POLICY }, revision: 0, nextAt: 0,
  pending: {}, spendDay: '', spent: 0, last: null,
});

function createSweetPotatoAutomation({
  file, now = Date.now, activity, plots, trade, allowWindow, observe = () => {},
}) {
  let running = false;

  function read() {
    try {
      const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
      if (data.version !== 1 || !data.pending || Array.isArray(data.pending) || typeof data.pending !== 'object'
        || !Number.isSafeInteger(data.revision) || !Number.isSafeInteger(data.nextAt)
        || !Number.isSafeInteger(data.spent) || data.spent < 0) throw new Error('invalid');
      data.policy = normalizePolicy(data.policy);
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return initial();
      throw new Error('以薯换福托管记录暂不可读');
    }
  }

  function save(data) {
    const destination = file();
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, destination);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  function status() {
    const { policy, nextAt, pending, spendDay, spent, last } = read();
    return { policy, nextAt, pending: Object.keys(pending), spentToday: spendDay === farmDay(now()) ? spent : 0, last };
  }

  function update(input) {
    const data = read();
    data.policy = normalizePolicy(input);
    data.revision++;
    data.nextAt = 0;
    save(data);
    return status();
  }

  function assertManualAllowed(action) {
    if (Object.hasOwn(LABELS, action) && read().pending[action])
      throw new Error('该活动操作的上一次自动结果仍待核对');
  }

  function record(action, state, cost = 0) {
    const data = read();
    delete data.pending[action];
    if (cost > 0) {
      const day = farmDay(now());
      data.spent = (data.spendDay === day ? data.spent : 0) + cost;
      data.spendDay = day;
    }
    data.last = { action, state, at: now() };
    data.nextAt = Math.min(data.nextAt, now() + AFTER_ACTION_INTERVAL);
    save(data);
  }

  async function reconcile(pending, personal, check, inventory, readPlots) {
    for (const [action, allowed] of Object.entries(pending)) {
      const { input, before } = allowed;
      let resolved = false;
      let cost = 0;
      if (action === 'seeds') resolved = personal.seedsClaimed === true;
      if (action === 'dividend') {
        resolved = Number.isSafeInteger(before.coins) && personal.coinBalance === before.coins + before.dividend
          && (personal.pendingDividend ?? 0) < before.dividend;
      }
      if (action === 'plantCrop') resolved = (await readPlots()).planted.includes(input.landId);
      if (action === 'harvestCrop') resolved = !(await readPlots()).ready.includes(input.landId)
        && (await inventory()).potatoes > before.potatoes;
      if (action === 'sale') {
        const current = await inventory();
        resolved = current.potatoes === input.potatoes - input.count
          && current.coins === before.coins + input.unitPrice * input.count;
      }
      if (action === 'exchange') {
        const priced = input.unitPrice * input.count;
        const current = await trade.getSweetPotatoInventory(check, before.itemId);
        resolved = current.coins === input.coins - priced && current.selected >= before.selected + input.count;
        cost = resolved ? priced : 0;
      }
      check();
      if (resolved) {
        record(action, 'reconciled', cost);
        observe(action, 'reconciled');
      }
    }
  }

  async function choose(data, personal, check, inventory, readPlots) {
    const { policy, pending } = data;
    if (policy.claim && personal.seedsClaimed === false && !pending.seeds) return ['seeds', {}, {}];
    if (policy.claim && personal.pendingDividend > 0 && !pending.dividend) {
      return ['dividend', {}, { coins: personal.coinBalance, dividend: personal.pendingDividend }];
    }
    if (policy.grow) {
      const field = await readPlots();
      if (field.ready.length && !pending.harvestCrop) return ['harvestCrop', { landId: field.ready[0] }, await inventory()];
    }
    if (policy.sell && !pending.sale) {
      const bag = await inventory();
      const surplus = Math.min(policy.saleBatch, bag.potatoes - policy.keepPotatoes);
      if (surplus > 0) {
        const price = await trade.getOwnSweetPotatoQuote(check);
        const count = Math.min(surplus, price.remaining ?? 0);
        if (price.acceptsSales === true && count > 0)
          return ['sale', { count, unitPrice: price.unitPrice, potatoes: bag.potatoes }, { coins: bag.coins }];
      }
    }
    if (policy.exchangeIndex && !pending.exchange) {
      const remainingBudget = policy.coinBudget - (data.spendDay === farmDay(now()) ? data.spent : 0);
      const itemId = trade.getSweetPotatoRewardId(policy.exchangeIndex);
      if (remainingBudget > 0 && itemId) {
        const bag = await trade.getSweetPotatoInventory(check, itemId);
        if (bag.coins > policy.keepCoins) {
          const listed = await trade.getSweetPotatoCatalog(check);
          const goods = listed.find(row => row.index === policy.exchangeIndex && row.itemId === itemId);
          if (goods?.limit > 0 && goods.unitPrice <= remainingBudget && goods.unitPrice <= bag.coins - policy.keepCoins) {
            return ['exchange', { index: goods.index, count: 1, unitPrice: goods.unitPrice, coins: bag.coins },
              { itemId, selected: bag.selected }];
          }
        }
      }
    }
    if (policy.grow && !pending.plantCrop) {
      const field = await readPlots();
      if (field.empty.length && (await inventory()).seeds > 0) return ['plantCrop', { landId: field.empty[0] }, {}];
    }
    return null;
  }

  async function tick(allowed, invalidate) {
    if (running || !allowed() || !allowWindow()) return;
    const data = read();
    if ((!data.policy.enabled && !Object.keys(data.pending).length) || data.nextAt > now()) return;
    running = true;
    try {
      data.nextAt = now() + CHECK_INTERVAL;
      save(data);
      const check = () => {
        if (!allowed() || !allowWindow()) throw new Error('以薯换福托管暂缓');
      };
      const checkMutation = () => {
        check();
        const latest = read();
        if (latest.revision !== data.revision || !latest.policy.enabled) throw new Error('托管设置已变化');
      };
      const board = await activity(() => allowed() && allowWindow());
      if (!board?.available || !board.personal) return;
      let bag, field;
      const inventory = () => bag ||= trade.getSweetPotatoInventory(check);
      const readPlots = () => field ||= plots(check);
      await reconcile(data.pending, board.personal, check, inventory, readPlots);
      const latest = read();
      if (!latest.policy.enabled || latest.revision !== data.revision) return;
      const selected = await choose(latest, board.personal, check, inventory, readPlots);
      if (!selected) return;
      const [action, input, before] = selected;
      let sent = false;
      try {
        const result = await trade.runSweetPotatoTrade(action, input, () => {
          checkMutation();
          return true;
        }, () => {
          checkMutation();
          const snapshot = read();
          if (snapshot.pending[action]) throw new Error('已有待核对操作');
          snapshot.pending[action] = { input, before };
          save(snapshot);
          sent = true;
        });
        record(action, 'confirmed', result.cost || 0);
      } catch (error) {
        if (sent && (error?.isGovernedRejection === true
          || (error?.isLocalRequestRejection === true && error.outcome === 'not_sent'))) {
          const unsubmitted = read();
          delete unsubmitted.pending[action];
          save(unsubmitted);
        } else if (sent) observe(action, 'unknown');
      } finally {
        if (sent) invalidate();
      }
    } finally {
      running = false;
    }
  }

  return { status, update, tick, assertManualAllowed };
}

let workerAutomation;
function getAutomation() {
  if (workerAutomation) return workerAutomation;
  const accountId = process.env.FARM_ACCOUNT_ID;
  if (!accountId) throw new Error('以薯换福托管尚未绑定账号');
  const key = crypto.createHash('sha256').update(accountId).digest('hex').slice(0, 24);
  const { getSweetPotatoActivity, sweetPotatoOutsideWindow } = require('./activity');
  const { log, getServerTimeSec } = require('../utils/utils');
  workerAutomation = createSweetPotatoAutomation({
    file: () => require('../config/runtime-paths').getDataFile(`sweet-potato-automation-${key}.json`),
    now: () => getServerTimeSec() * 1000,
    activity: getSweetPotatoActivity,
    allowWindow: () => !sweetPotatoOutsideWindow(),
    plots: require('./sweet-potato-plots').getSweetPotatoPlots,
    trade: require('./sweet-potato-trade'),
    observe: (action, state) => log('活动', `以薯换福自动${LABELS[action]}${state === 'unknown' ? '结果待核对' : '状态已核对'}`,
      { module: 'activity', event: 'sweet_potato_automation_result', action, automatic: true, result: state }),
  });
  return workerAutomation;
}

const { wrapBusinessFunction } = require('./business-state');
module.exports = {
  createSweetPotatoAutomation,
  getSweetPotatoAutomation: () => getAutomation().status(),
  updateSweetPotatoAutomation: policy => getAutomation().update(policy),
  assertSweetPotatoManualAllowed: action => getAutomation().assertManualAllowed(action),
  runSweetPotatoAutomation: wrapBusinessFunction('sweet-potato:automation', (allowed, invalidate) => getAutomation().tick(allowed, invalidate)),
};
