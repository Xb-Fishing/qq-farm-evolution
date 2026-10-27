'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const KEY = Symbol.for('farm.ownQuietWire.v1');
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const ids = value => Array.isArray(value) && value.length > 0 && value.length <= 24
  && value.every(positive) && new Set(value.map(Number)).size === value.length;

// Check the encoded request, including the target of Harvest (also used by stealing).
function admits({ service, method, body, marker, ownGid, accountId, types }) {
  try {
    if (!marker || marker.version !== 1 || marker.accountId !== String(accountId)
      || !['harvest', 'replant', 'snapshot'].includes(marker.phase)
      || !positive(ownGid) || !ids(marker.landIds)) return false;
    const allowed = new Set(marker.landIds.map(Number));
    const contained = values => ids(values) && values.every(id => allowed.has(Number(id)));
    const self = value => String(value || 0) === String(ownGid);
    if (service === 'gamepb.plantpb.PlantService') {
      if (method === 'AllLands') {
        const request = types.AllLandsRequest.decode(body);
        return Number(request.host_gid || 0) === 0 || self(request.host_gid);
      }
      if (method === 'Harvest' && marker.phase === 'harvest') {
        const request = types.HarvestRequest.decode(body);
        return self(request.host_gid) && contained(request.land_ids);
      }
      if (method === 'RemovePlant' && marker.phase === 'replant') {
        return contained(types.RemovePlantRequest.decode(body).land_ids);
      }
      if (method === 'Plant' && marker.phase === 'replant') {
        const request = types.PlantRequest.decode(body);
        // Current callers use items; do not exempt unverified legacy encodings.
        return !Object.keys(request.land_and_seed || {}).length && request.items?.length > 0
          && request.items.length <= 24 && request.items.every(item => positive(item.seed_id) && contained(item.land_ids));
      }
    }
    if (marker.phase !== 'replant') return false;
    if (service === 'gamepb.itempb.ItemService' && method === 'Bag') return body.length === 0;
    if (service === 'gamepb.shoppb.ShopService' && method === 'ShopInfo') {
      return Number(types.ShopInfoRequest.decode(body).shop_id) === 2;
    }
    if (service === 'gamepb.shoppb.ShopService' && method === 'BuyGoods') {
      const request = types.BuyGoodsRequest.decode(body); const plan = marker.purchase;
      return plan && positive(plan.seedId) && positive(plan.goodsId) && positive(plan.count)
        && plan.count <= marker.landIds.length && Number.isSafeInteger(plan.price) && plan.price >= 0
        && Number(request.goods_id) === plan.goodsId && Number(request.num) === plan.count
        && Number(request.price) === plan.price;
    }
  } catch { /* Invalid protobuf or scope never acquires an exemption. */ }
  return false;
}

function install({ network, store, types, accountId }) {
  if (network[KEY]) return network[KEY];
  const scopes = new AsyncLocalStorage();
  const priorSend = network.sendMsgAsync; const priorPause = store.getWirePauseRemainMs;
  if (typeof priorSend !== 'function' || typeof priorPause !== 'function') throw new Error('Own quiet compatibility unavailable');
  function remaining(...args) {
    const original = Reflect.apply(priorPause, this, args); const scope = scopes.getStore();
    return scope?.active && String(args[0] || '') === String(accountId) ? 0 : original;
  }
  function send(...args) {
    const [service, method, body, , options] = args;
    const valid = admits({ service, method, body, marker: options?.ownFarmQuietPriority,
      ownGid: network.getUserState().gid, accountId, types });
    if (!valid) return Reflect.apply(priorSend, this, args);
    const scope = { active: true }; const receiver = this;
    return scopes.run(scope, async () => {
      try { return await Reflect.apply(priorSend, receiver, args); }
      finally { scope.active = false; }
    });
  }
  store.getWirePauseRemainMs = remaining; network.sendMsgAsync = send;
  const controller = { active: true, uninstall() {
    if (network.sendMsgAsync === send) network.sendMsgAsync = priorSend;
    if (store.getWirePauseRemainMs === remaining) store.getWirePauseRemainMs = priorPause;
    controller.active = false; delete network[KEY];
  } };
  Object.defineProperty(network, KEY, { configurable: true, value: controller });
  return controller;
}
module.exports = { install, admits };
