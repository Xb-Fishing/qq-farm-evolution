'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
let activeCount = 0;
const failure = () => Object.assign(new Error('Own harvest priority scope is no longer eligible'), { code: 'OWN_PRIORITY_CANCELLED' });

async function run(scope, callback) {
  const value = { ...scope, active: true, phase: 'harvest', purchase: null };
  activeCount++;
  try { return await context.run(value, () => callback(value)); }
  finally { value.active = false; activeCount--; }
}
function setPurchase(plan) {
  const scope = context.getStore();
  if (scope?.active) scope.purchase = { goodsId: Number(plan.goodsId), seedId: Number(plan.seedId), count: Number(plan.count), price: Number(plan.price) };
}
function wrapSend(original) {
  return function (...args) {
    const [service, method, body, timeout, options] = args;
    const scope = context.getStore();
    if (!scope) return Reflect.apply(original, this, args);
    const store = require('../models/store');
    if (!scope.active || !store.isAutomationOn('farm') || !store.isAutomationOn('harvest')
      || (scope.phase === 'replant' && !store.isAutomationOn('plant'))) return Promise.reject(failure());
    const marker = { version: 1, accountId: String(process.env.FARM_ACCOUNT_ID || ''),
      phase: scope.phase, landIds: [...scope.landIds], ...(scope.purchase ? { purchase: scope.purchase } : {}) };
    const network = require('../utils/network');
    if (!require('../runtime/own-quiet-wire').admits({ service, method, body, marker,
      ownGid: network.getUserState().gid, accountId: marker.accountId, types: require('../utils/proto').types })) return Promise.reject(failure());
    if (service === 'gamepb.shoppb.ShopService' && method === 'BuyGoods') scope.onPurchaseAttempt?.();
    return Reflect.apply(original, this, [service, method, body, timeout, { ...options, ownFarmQuietPriority: marker }]);
  };
}
module.exports = { run, wrapSend, setPurchase, isActive: () => activeCount > 0, inScope: () => !!context.getStore()?.active };
