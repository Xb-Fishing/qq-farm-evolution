const { getItemById, getItemImageById } = require("../config/gameConfig");
const { toNum } = require("../utils/utils");
// 官方静态分类目录（本轮 CDN 已解表生成；只作分类/佐证，不制造可买库存）
const mallCatalog = require("../gameConfig/MallCatalog.json");

// 展示用既有商品图（原 MALL_GOODS_META；价格硬编码覆盖已移除——
// 面板一律展示服务端当前价格/免费/限购/已购，购买前由守护 fresh 复核）。
const MALL_GOODS_META = {
  1002: {
    images: [
      "/game-config/seed_images_named/80011_organic_1.png",
      "/game-config/seed_images_named/80013_organic_8.png",
    ],
    layout: "horizontal",
  },
  1003: {
    images: [
      "/game-config/seed_images_named/80001_ordinary_1.png",
      "/game-config/seed_images_named/80003_ordinary_8.png",
    ],
    layout: "horizontal",
  },
  1006: {
    images: [
      "/game-config/seed_images_named/90004_dog_food_1.png",
      "/game-config/seed_images_named/90005_dog_food_3.png",
      "/game-config/seed_images_named/90006_dog_food_5.png",
    ],
    layout: "triangle",
  },
};

// 静态目录分类（goods_id → 官方 slot_type/zone）；仅用于展示分区与限购佐证。
function classifyMallGoods(goodsId) {
  const id = toNum(goodsId) || 0;
  const entry = (mallCatalog.goods || []).find((row) => row.id === id) || null;
  return {
    catalogMapped: !!entry,
    zone: entry ? entry.zone : null,
    slotType: entry ? entry.slotType : "",
  };
}

// 服务端条目 → 面板展示条目（附加图/余额可见性；不改价格语义）。
function decorateMallEntry(entry, status) {
  const meta = MALL_GOODS_META[toNum(entry.goodsId)] || {};
  const itemIds = (entry.items || []).map((item) => item.id);
  const dynamicImages = itemIds.map(getItemImageById).filter(Boolean);
  const currencyId = toNum(entry.price && entry.price.currencyId);
  const { walletBalance } = require('../services/manual-commerce');
  const wallet = walletBalance(currencyId, status?.status);
  const balanceKnown = wallet.known;
  const currencyBalance = wallet.amount;
  const currencyName = entry.price?.currencyName || getItemById(currencyId)?.name || '';
  const amountDec = entry.price?.amountDec || '';
  const affordable = entry.isFree || balanceKnown && amountDec !== '' && BigInt(currencyBalance) >= BigInt(amountDec);
  const unlimited = !entry.limit?.present && entry.catalogRestricted === null;
  const limitKnown = unlimited || entry.limit?.present && entry.limit?.remainingDec !== null;
  const canBuy = !entry.expired && !entry.soldOut && entry.enabled && !entry.invalidReason && entry.catalogMapped && limitKnown && affordable;

  return {
    ...entry,
    images: meta.images || dynamicImages,
    layout: meta.layout || "single",
    currencyName,
    currencyBalance,
    balanceKnown,
    affordable,
    canBuy,
    purchaseBlockedReason: entry.invalidReason || (!limitKnown ? "限购余量未知" : !affordable ? "余额不足或未知" : !entry.enabled || entry.expired ? "未开放或已过期" : null),
  };
}

function getAuthorizedAccountId({
  req,
  res,
  getAccountIdFromRequest,
  canAccessAccount,
}) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    res.status(400).json({ ok: false, error: "Missing\x20x-account-id" });
    return null;
  }
  if (!canAccessAccount(req, accountId)) {
    res.status(403).json({ ok: false, error: "无权访问此账号" });
    return null;
  }
  return accountId;
}

// 充值区：官方 PayDiamond 八档静态展示。首充资格未知、无假跳转 URL、
// 不代付；真实支付只能在游戏内「充值商店」完成。
function buildRechargeZone() {
  const tiers = (mallCatalog.payDiamond?.tiers || []).map((tier) => ({
    id: tier.id,
    priceYuan: (Number(tier.price) / 100).toFixed(Number(tier.price) % 100 === 0 ? 0 : 2),
    priceFen: tier.price,
    gainDiamond: tier.gain,
    firstChargeBonusDiamond: tier.bonus,
    firstChargeEligibility: "unknown",
  }));
  return {
    key: "recharge",
    title: "充值",
    tiers,
    notes: mallCatalog.payDiamond?.notes || [],
    guidance: [
      "充值需在游戏内打开「充值商店」选择档位完成支付。",
      "面板不代付、不跳转；每个档位首次充值按档位赠送钻石，首充资格以游戏内展示为准。",
    ],
  };
}

function registerAdminMallRoutes({
  app,
  provider,
  adminLogger,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
}) {
  app.get("/api/shop/mall", async (req, res) => {
    const accountId = getAuthorizedAccountId({
      req,
      res,
      getAccountIdFromRequest,
      canAccessAccount,
    });
    if (!accountId) return;

    try {
      const status = provider.getStatus(accountId);
      if (!status || !status.connection || !status.connection.connected) {
        return res.json({
          ok: false,
          error: "获取道具商城失败:\x20账号未运行",
        });
      }

      const catalog = await provider.getMallCatalog(accountId);
      const decorate = (entry) => decorateMallEntry(entry, status);
      const zones = {
        featured: (catalog.zones.featured || []).map(decorate),
        packages: (catalog.zones.packages || []).map(decorate),
        // 未映射进官方目录的商品：独立分区展示「未知，禁止购买」。
        unknown: (catalog.zones.unknown || []).map(decorate),
      };
      res.json({
        ok: true,
        data: {
          zones,
          malformedCount: catalog.malformedCount || 0,
          unmappedCount: catalog.unmappedCount || 0,
          fetchedAt: catalog.fetchedAt,
          rpcSlotRead: catalog.rpcSlotRead || 1,
        },
        userTicket: status?.status?.coupon || 0,
        userDiamond: status?.status?.diamond || 0,
      });
    } catch (error) {
      adminLogger.error("获取道具商城失败", {
        error: error.message,
        stack: error.stack,
      });
      const message = error.message || "未知错误";
      res.json({ ok: false, error: `获取道具商城失败:\x20${  message}` });
    }
  });

  app.get("/api/shop/mall/recharge", async (req, res) => {
    // 静态只读：无需账号连接，不受账号授权外的任何写。
    const accountId = getAuthorizedAccountId({
      req,
      res,
      getAccountIdFromRequest,
      canAccessAccount,
    });
    if (!accountId) return;
    res.json({ ok: true, data: buildRechargeZone() });
  });

  app.get("/api/shop/mall/monthcard", async (req, res) => {
    const accountId = getAuthorizedAccountId({
      req,
      res,
      getAccountIdFromRequest,
      canAccessAccount,
    });
    if (!accountId) return;

    try {
      const data = await provider.getMonthCardPanel(accountId);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/shop/mall/buy", async (req, res) => {
    const accountId = getAuthorizedAccountId({
      req,
      res,
      getAccountIdFromRequest,
      canAccessAccount,
    });
    if (!accountId) return;

    try {
      const { goodsId, count, quoteFingerprint, operationId } = req.body || {};
      if (!goodsId || !count || !quoteFingerprint) {
        return res.status(400).json({ ok: false, error: "参数不完整" });
      }

      const data = await provider.buyMallGoods(accountId, { goodsId, count, quoteFingerprint, operationId });
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });
}

module.exports = {
  classifyMallGoods,
  decorateMallEntry,
  buildRechargeZone,
  registerAdminMallRoutes,
};
