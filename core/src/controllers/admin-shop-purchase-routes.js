const { toNum } = require("../utils/utils");
const { shopGoodsQuote, quoteFingerprint, decimalOf } = require("../services/manual-commerce");

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

function normalizeItemChanges(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    id: toNum(item.id),
    count: toNum(item.count),
    countDec: decimalOf(item.count),
  }));
}

function registerAdminShopPurchaseRoutes({
  app,
  provider,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
}) {
  app.post("/api/shop/buy", async (req, res) => {
    const accountId = getAuthorizedAccountId({
      req,
      res,
      getAccountIdFromRequest,
      canAccessAccount,
    });
    if (!accountId) return;

    try {
      const { shopKind, goodsId, count, quoteFingerprint, operationId } = req.body || {};
      if (!shopKind || !goodsId || !count || !quoteFingerprint) {
        return res.status(400).json({ ok: false, error: "参数不完整" });
      }

      // 面板手动购买：confirmed 报价快照随请求传递，Worker 守护写前 fresh 复核。
      const buyResult = await provider.buyGoods(accountId, {
        shopKind,
        goodsId,
        count,
        quoteFingerprint,
        operationId,
      });
      res.json({
        ok: true,
        data: {
          goods: buyResult?.goods,
          getItems: normalizeItemChanges(buyResult?.get_items),
          costItems: normalizeItemChanges(buyResult?.cost_items),
        },
      });
    } catch (error) {
      sendProviderError(res, error);
    }
  });
}

module.exports = {
  registerAdminShopPurchaseRoutes,
  // 供种子/宠物商店路由计算条目报价指纹（与服务端 fresh 复核同一实现）。
  shopGoodsQuote,
  quoteFingerprint,
  decimalOf,
};
