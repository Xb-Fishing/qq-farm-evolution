/**
 * Proto 加载与消息类型管理
 *
 * 生命周期规则（2026-09-18 启动竞态修复）：
 * - loadProto 并发调用共享同一次加载；完整加载并解析全部类型成功后才发布就绪。
 *   旧实现把加载开头创建的 root 当成就绪判据，协议加载窗口内（约 55ms）的
 *   面板读取会在本地编码前抛 TypeError——「协议已就绪」从来不等同于「加载完成」。
 * - 加载或类型解析失败时，本次调用与所有等待者统一以本地错误结束，并保持
 *   未就绪状态（root 不发布、types 不被半成品污染）；失败后不自动重试，
 *   只有再次显式调用 loadProto 才发起一次新尝试。
 * - waitForProtoReady 只等待「已经发起」的那次真实加载；尚未开始加载或上次
 *   加载已失败时立即抛出本地错误，不替调用者启动加载，也不留下悬挂等待。
 *   注意：协议就绪不等于登录/连接就绪，调用方仍需各自校验连接状态。
 */

const protobuf = require('protobufjs');
const { getResourcePath } = require('../config/runtime-paths');
const { log } = require('./utils');

// Proto 根对象与所有消息类型。types 是唯一导出的稳定引用，只做原地填充，
// 不整体替换（farm-api 等模块持有同一引用）。
let root = null;
const types = {};

// 当前（或最近一次）加载：成功后保留供复用；失败后 loadError 记录原因。
let loadPromise = null;
let loadError = null;

/** 真实执行一次加载：成功后才发布 root 并原地填充 types；任何失败整体抛出。 */
async function performLoad() {
    const resolved = Object.create(null);
    const newRoot = new protobuf.Root();
    await newRoot.load([
        getResourcePath('proto', 'game.proto'),
        getResourcePath('proto', 'userpb.proto'),
        getResourcePath('proto', 'plantpb.proto'),
        getResourcePath('proto', 'corepb.proto'),
        getResourcePath('proto', 'shoppb.proto'),
        getResourcePath('proto', 'friendpb.proto'),
        getResourcePath('proto', 'visitpb.proto'),
        getResourcePath('proto', 'notifypb.proto'),
        getResourcePath('proto', 'taskpb.proto'),
        getResourcePath('proto', 'itempb.proto'),
        getResourcePath('proto', 'emailpb.proto'),
        getResourcePath('proto', 'mallpb.proto'),
        getResourcePath('proto', 'redpacketpb.proto'),
        getResourcePath('proto', 'qqvippb.proto'),
        getResourcePath('proto', 'sharepb.proto'),
        getResourcePath('proto', 'illustratedpb.proto'),
        getResourcePath('proto', 'interactpb.proto'),
        getResourcePath('proto', 'dogpb.proto'),
        getResourcePath('proto', 'activitypb.proto'),
        getResourcePath('proto', 'pet-diary.proto'),
        getResourcePath('proto', 'mysteryshoppb.proto'),
        getResourcePath('proto', 'acepb.proto'),
        getResourcePath('proto', 'careerpb.proto'),
    ], { keepCase: true });

    // 网关
    resolved.GateMessage = newRoot.lookupType('gatepb.Message');
    resolved.GateMeta = newRoot.lookupType('gatepb.Meta');
    resolved.EventMessage = newRoot.lookupType('gatepb.EventMessage');

    // 用户
    resolved.LoginRequest = newRoot.lookupType('gamepb.userpb.LoginRequest');
    resolved.LoginReply = newRoot.lookupType('gamepb.userpb.LoginReply');
    resolved.HeartbeatRequest = newRoot.lookupType('gamepb.userpb.HeartbeatRequest');
    resolved.HeartbeatReply = newRoot.lookupType('gamepb.userpb.HeartbeatReply');
    resolved.BatchBasicInfoRequest = newRoot.lookupType('gamepb.userpb.BatchBasicInfoRequest');
    resolved.BatchBasicInfoReply = newRoot.lookupType('gamepb.userpb.BatchBasicInfoReply');
    resolved.ReportArkClickRequest = newRoot.lookupType('gamepb.userpb.ReportArkClickRequest');
    resolved.ReportArkClickReply = newRoot.lookupType('gamepb.userpb.ReportArkClickReply');
    resolved.AntiDataRequest = newRoot.lookupType('gamepb.acepb.AntiDataRequest');
    resolved.AntiDataReply = newRoot.lookupType('gamepb.acepb.AntiDataReply');
    resolved.CareerInfoGetRequest = newRoot.lookupType('gamepb.careerpb.CareerInfoGetRequest');
    resolved.CareerInfoGetReply = newRoot.lookupType('gamepb.careerpb.CareerInfoGetReply');

    // 农场
    resolved.AllLandsRequest = newRoot.lookupType('gamepb.plantpb.AllLandsRequest');
    resolved.AllLandsReply = newRoot.lookupType('gamepb.plantpb.AllLandsReply');
    resolved.HarvestRequest = newRoot.lookupType('gamepb.plantpb.HarvestRequest');
    resolved.HarvestReply = newRoot.lookupType('gamepb.plantpb.HarvestReply');
    resolved.WaterLandRequest = newRoot.lookupType('gamepb.plantpb.WaterLandRequest');
    resolved.WaterLandReply = newRoot.lookupType('gamepb.plantpb.WaterLandReply');
    resolved.FarmingRequest = newRoot.lookupType('gamepb.plantpb.FarmingRequest');
    resolved.FarmingReply = newRoot.lookupType('gamepb.plantpb.FarmingReply');
    resolved.WeedOutRequest = newRoot.lookupType('gamepb.plantpb.WeedOutRequest');
    resolved.WeedOutReply = newRoot.lookupType('gamepb.plantpb.WeedOutReply');
    resolved.InsecticideRequest = newRoot.lookupType('gamepb.plantpb.InsecticideRequest');
    resolved.InsecticideReply = newRoot.lookupType('gamepb.plantpb.InsecticideReply');
    resolved.RemovePlantRequest = newRoot.lookupType('gamepb.plantpb.RemovePlantRequest');
    resolved.RemovePlantReply = newRoot.lookupType('gamepb.plantpb.RemovePlantReply');
    resolved.PutInsectsRequest = newRoot.lookupType('gamepb.plantpb.PutInsectsRequest');
    resolved.PutInsectsReply = newRoot.lookupType('gamepb.plantpb.PutInsectsReply');
    resolved.PutWeedsRequest = newRoot.lookupType('gamepb.plantpb.PutWeedsRequest');
    resolved.PutWeedsReply = newRoot.lookupType('gamepb.plantpb.PutWeedsReply');
    resolved.PutSocialItemRequest = newRoot.lookupType('gamepb.plantpb.PutSocialItemRequest');
    resolved.PutSocialItemReply = newRoot.lookupType('gamepb.plantpb.PutSocialItemReply');
    resolved.UpgradeLandRequest = newRoot.lookupType('gamepb.plantpb.UpgradeLandRequest');
    resolved.UpgradeLandReply = newRoot.lookupType('gamepb.plantpb.UpgradeLandReply');
    resolved.UnlockLandRequest = newRoot.lookupType('gamepb.plantpb.UnlockLandRequest');
    resolved.UnlockLandReply = newRoot.lookupType('gamepb.plantpb.UnlockLandReply');
    resolved.CheckCanOperateRequest = newRoot.lookupType('gamepb.plantpb.CheckCanOperateRequest');
    resolved.CheckCanOperateReply = newRoot.lookupType('gamepb.plantpb.CheckCanOperateReply');
    resolved.FertilizeRequest = newRoot.lookupType('gamepb.plantpb.FertilizeRequest');
    resolved.FertilizeReply = newRoot.lookupType('gamepb.plantpb.FertilizeReply');

    // 背包/仓库
    resolved.BagRequest = newRoot.lookupType('gamepb.itempb.BagRequest');
    resolved.BagReply = newRoot.lookupType('gamepb.itempb.BagReply');
    resolved.SellRequest = newRoot.lookupType('gamepb.itempb.SellRequest');
    resolved.SellReply = newRoot.lookupType('gamepb.itempb.SellReply');
    resolved.UseRequest = newRoot.lookupType('gamepb.itempb.UseRequest');
    resolved.UseReply = newRoot.lookupType('gamepb.itempb.UseReply');
    resolved.BatchUseRequest = newRoot.lookupType('gamepb.itempb.BatchUseRequest');
    resolved.BatchUseReply = newRoot.lookupType('gamepb.itempb.BatchUseReply');
    resolved.PlantRequest = newRoot.lookupType('gamepb.plantpb.PlantRequest');
    resolved.PlantReply = newRoot.lookupType('gamepb.plantpb.PlantReply');
    resolved.PlantItem = newRoot.lookupType('gamepb.plantpb.PlantItem');

    // 商店
    resolved.ShopProfilesRequest = newRoot.lookupType('gamepb.shoppb.ShopProfilesRequest');
    resolved.ShopProfilesReply = newRoot.lookupType('gamepb.shoppb.ShopProfilesReply');
    resolved.ShopInfoRequest = newRoot.lookupType('gamepb.shoppb.ShopInfoRequest');
    resolved.ShopInfoReply = newRoot.lookupType('gamepb.shoppb.ShopInfoReply');
    resolved.BuyGoodsRequest = newRoot.lookupType('gamepb.shoppb.BuyGoodsRequest');
    resolved.BuyGoodsReply = newRoot.lookupType('gamepb.shoppb.BuyGoodsReply');
    resolved.GetMonthCardInfosRequest = newRoot.lookupType('gamepb.mallpb.GetMonthCardInfosRequest');
    resolved.GetMonthCardInfosReply = newRoot.lookupType('gamepb.mallpb.GetMonthCardInfosReply');
    resolved.ClaimMonthCardRewardRequest = newRoot.lookupType('gamepb.mallpb.ClaimMonthCardRewardRequest');
    resolved.ClaimMonthCardRewardReply = newRoot.lookupType('gamepb.mallpb.ClaimMonthCardRewardReply');
    resolved.GetTodayClaimStatusRequest = newRoot.lookupType('gamepb.redpacketpb.GetTodayClaimStatusRequest');
    resolved.GetTodayClaimStatusReply = newRoot.lookupType('gamepb.redpacketpb.GetTodayClaimStatusReply');
    resolved.ClaimRedPacketRequest = newRoot.lookupType('gamepb.redpacketpb.ClaimRedPacketRequest');
    resolved.ClaimRedPacketReply = newRoot.lookupType('gamepb.redpacketpb.ClaimRedPacketReply');
    resolved.GetMallListBySlotTypeRequest = newRoot.lookupType('gamepb.mallpb.GetMallListBySlotTypeRequest');
    resolved.GetMallListBySlotTypeResponse = newRoot.lookupType('gamepb.mallpb.GetMallListBySlotTypeResponse');
    resolved.MallGoods = newRoot.lookupType('gamepb.mallpb.MallGoods');
    resolved.PurchaseRequest = newRoot.lookupType('gamepb.mallpb.PurchaseRequest');
    resolved.PurchaseResponse = newRoot.lookupType('gamepb.mallpb.PurchaseResponse');
    resolved.GetActiveMysteryNPCRequest = newRoot.lookupType('gamepb.mysteryshoppb.GetActiveNPCRequest');
    resolved.GetActiveMysteryNPCReply = newRoot.lookupType('gamepb.mysteryshoppb.GetActiveNPCReply');
    resolved.BuyMysteryShopRequest = newRoot.lookupType('gamepb.mysteryshoppb.BuyRequest');
    resolved.BuyMysteryShopReply = newRoot.lookupType('gamepb.mysteryshoppb.BuyReply');
    resolved.AbandonMysteryShopRequest = newRoot.lookupType('gamepb.mysteryshoppb.AbandonRequest');
    resolved.AbandonMysteryShopReply = newRoot.lookupType('gamepb.mysteryshoppb.AbandonReply');
    resolved.RefreshVipInfoRequest = newRoot.lookupType('gamepb.qqvippb.RefreshVipInfoRequest');
    resolved.RefreshVipInfoReply = newRoot.lookupType('gamepb.qqvippb.RefreshVipInfoReply');
    resolved.GetQQVipRewardsStatusRequest = newRoot.lookupType('gamepb.qqvippb.GetQQVipRewardsStatusRequest');
    resolved.GetQQVipRewardsStatusReply = newRoot.lookupType('gamepb.qqvippb.GetQQVipRewardsStatusReply');
    resolved.ClaimQQVipRewardsRequest = newRoot.lookupType('gamepb.qqvippb.ClaimQQVipRewardsRequest');
    resolved.ClaimQQVipRewardsReply = newRoot.lookupType('gamepb.qqvippb.ClaimQQVipRewardsReply');
    resolved.CheckCanShareRequest = newRoot.lookupType('gamepb.sharepb.CheckCanShareRequest');
    resolved.CheckCanShareReply = newRoot.lookupType('gamepb.sharepb.CheckCanShareReply');
    resolved.ReportShareRequest = newRoot.lookupType('gamepb.sharepb.ReportShareRequest');
    resolved.ReportShareReply = newRoot.lookupType('gamepb.sharepb.ReportShareReply');
    resolved.ClaimShareRewardRequest = newRoot.lookupType('gamepb.sharepb.ClaimShareRewardRequest');
    resolved.ClaimShareRewardReply = newRoot.lookupType('gamepb.sharepb.ClaimShareRewardReply');
    resolved.GetIllustratedListV2Request = newRoot.lookupType('gamepb.illustratedpb.GetIllustratedListV2Request');
    resolved.GetIllustratedListV2Reply = newRoot.lookupType('gamepb.illustratedpb.GetIllustratedListV2Reply');
    resolved.ClaimAllRewardsV2Request = newRoot.lookupType('gamepb.illustratedpb.ClaimAllRewardsV2Request');
    resolved.ClaimAllRewardsV2Reply = newRoot.lookupType('gamepb.illustratedpb.ClaimAllRewardsV2Reply');
    resolved.CoreItem = newRoot.lookupType('corepb.Item');

    // 活动
    resolved.ActivityGetGroupRequest = newRoot.lookupType('gamepb.activitypb.GetGroupRequest');
    resolved.ActivityGetGroupReply = newRoot.lookupType('gamepb.activitypb.GetGroupReply');
    resolved.ActivityOperateRequest = newRoot.lookupType('gamepb.activitypb.OperateRequest');
    resolved.ActivityOperateReply = newRoot.lookupType('gamepb.activitypb.OperateReply');
    // 萌宠成长日记（S3）操作协议，来自官方小程序 1.14.0.1 编码器（参考仓库只读对照移植）
    for (const name of ['PetDiaryOperateRequest', 'PetDiaryOperateReply', 'PetDiaryGetGroupReply']) {
        resolved[name] = newRoot.lookupType(`gamepb.activitypb.${name}`);
    }
    resolved.ActivityRandomShopInfo = newRoot.lookupType('gamepb.activitypb.RandomShopInfo');
    resolved.ActivityExchangeShopInfo = newRoot.lookupType('gamepb.activitypb.ExchangeShopInfo');
    resolved.ActivityExchangeShopOperateParams = newRoot.lookupType('gamepb.activitypb.ExchangeShopOperateParams');
    resolved.ActivityDrawInfo = newRoot.lookupType('gamepb.activitypb.DrawInfo');
    resolved.ActivityDrawResult = newRoot.lookupType('gamepb.activitypb.DrawResult');
    resolved.ActivityQingmeiClaimParams = newRoot.lookupType('gamepb.activitypb.QingmeiClaimParams');
    resolved.ActivityQingmeiWineStartParams = newRoot.lookupType('gamepb.activitypb.QingmeiWineStartParams');
    resolved.ActivityQingmeiWineBrewParams = newRoot.lookupType('gamepb.activitypb.QingmeiWineBrewParams');
    resolved.ActivityQingmeiWineSellParams = newRoot.lookupType('gamepb.activitypb.QingmeiWineSellParams');
    resolved.ActivityQingmeiPreviewResult = newRoot.lookupType('gamepb.activitypb.QingmeiPreviewResult');
    resolved.ActivityQingmeiBrewResult = newRoot.lookupType('gamepb.activitypb.QingmeiBrewResult');
    resolved.ActivityQingmeiSellResult = newRoot.lookupType('gamepb.activitypb.QingmeiSellResult');
    resolved.ActivityQingmeiClaimResult = newRoot.lookupType('gamepb.activitypb.QingmeiClaimResult');
    resolved.ActivityActivityInfo = newRoot.lookupType('gamepb.activitypb.ActivityInfo');
    resolved.ActivityListRequest = newRoot.lookupType('gamepb.activitypb.ListRequest');
    resolved.ActivityListReply = newRoot.lookupType('gamepb.activitypb.ListReply');
    resolved.ActivityStarRecordInfo = newRoot.lookupType('gamepb.activitypb.StarRecordInfo');
    resolved.ActivityStarRecordClaimResult = newRoot.lookupType('gamepb.activitypb.StarRecordClaimResult');

    // 好友
    resolved.GetAllFriendsRequest = newRoot.lookupType('gamepb.friendpb.GetAllRequest');
    resolved.GetAllFriendsReply = newRoot.lookupType('gamepb.friendpb.GetAllReply');
    resolved.GetApplicationsRequest = newRoot.lookupType('gamepb.friendpb.GetApplicationsRequest');
    resolved.GetApplicationsReply = newRoot.lookupType('gamepb.friendpb.GetApplicationsReply');
    resolved.AcceptFriendsRequest = newRoot.lookupType('gamepb.friendpb.AcceptFriendsRequest');
    resolved.AcceptFriendsReply = newRoot.lookupType('gamepb.friendpb.AcceptFriendsReply');
    resolved.SyncAllFriendsRequest = newRoot.lookupType('gamepb.friendpb.SyncAllRequest');
    resolved.SyncAllFriendsReply = newRoot.lookupType('gamepb.friendpb.SyncAllReply');
    resolved.GetGameFriendsRequest = newRoot.lookupType('gamepb.friendpb.GetGameFriendsRequest');
    resolved.DelFriendRequest = newRoot.lookupType('gamepb.friendpb.DelFriendRequest');
    resolved.DelFriendReply = newRoot.lookupType('gamepb.friendpb.DelFriendReply');

    // 访问
    resolved.VisitEnterRequest = newRoot.lookupType('gamepb.visitpb.EnterRequest');
    resolved.VisitEnterReply = newRoot.lookupType('gamepb.visitpb.EnterReply');
    resolved.VisitLeaveRequest = newRoot.lookupType('gamepb.visitpb.LeaveRequest');
    resolved.VisitLeaveReply = newRoot.lookupType('gamepb.visitpb.LeaveReply');
    resolved.BriefDogInfo = newRoot.lookupType('gamepb.visitpb.BriefDogInfo');
    resolved.GetDogInfoRequest = newRoot.lookupType('gamepb.dogpb.GetDogInfoRequest');
    resolved.GetDogInfoReply = newRoot.lookupType('gamepb.dogpb.GetDogInfoReply');
    resolved.ClaimSkillGiftsRequest = newRoot.lookupType('gamepb.dogpb.ClaimSkillGiftsRequest');
    resolved.ClaimSkillGiftsReply = newRoot.lookupType('gamepb.dogpb.ClaimSkillGiftsReply');
    resolved.PendingGiftCountNotify = newRoot.lookupType('gamepb.dogpb.PendingGiftCountNotify');


    // 任务
    resolved.TaskInfoRequest = newRoot.lookupType('gamepb.taskpb.TaskInfoRequest');
    resolved.TaskInfoReply = newRoot.lookupType('gamepb.taskpb.TaskInfoReply');
    resolved.ClaimTaskRewardRequest = newRoot.lookupType('gamepb.taskpb.ClaimTaskRewardRequest');
    resolved.ClaimTaskRewardReply = newRoot.lookupType('gamepb.taskpb.ClaimTaskRewardReply');
    resolved.BatchClaimTaskRewardRequest = newRoot.lookupType('gamepb.taskpb.BatchClaimTaskRewardRequest');
    resolved.BatchClaimTaskRewardReply = newRoot.lookupType('gamepb.taskpb.BatchClaimTaskRewardReply');
    resolved.ClaimDailyRewardRequest = newRoot.lookupType('gamepb.taskpb.ClaimDailyRewardRequest');
    resolved.ClaimDailyRewardReply = newRoot.lookupType('gamepb.taskpb.ClaimDailyRewardReply');

    // 邮箱
    resolved.GetEmailListRequest = newRoot.lookupType('gamepb.emailpb.GetEmailListRequest');
    resolved.GetEmailListReply = newRoot.lookupType('gamepb.emailpb.GetEmailListReply');
    resolved.ClaimEmailRequest = newRoot.lookupType('gamepb.emailpb.ClaimEmailRequest');
    resolved.ClaimEmailReply = newRoot.lookupType('gamepb.emailpb.ClaimEmailReply');
    resolved.BatchClaimEmailRequest = newRoot.lookupType('gamepb.emailpb.BatchClaimEmailRequest');
    resolved.BatchClaimEmailReply = newRoot.lookupType('gamepb.emailpb.BatchClaimEmailReply');

    // 服务器推送通知
    resolved.LandsNotify = newRoot.lookupType('gamepb.plantpb.LandsNotify');
    resolved.BasicNotify = newRoot.lookupType('gamepb.userpb.BasicNotify');
    resolved.KickoutNotify = newRoot.lookupType('gatepb.KickoutNotify');
    resolved.FriendApplicationReceivedNotify = newRoot.lookupType('gamepb.friendpb.FriendApplicationReceivedNotify');
    resolved.FriendAddedNotify = newRoot.lookupType('gamepb.friendpb.FriendAddedNotify');
    resolved.InteractRecordsRequest = newRoot.lookupType('gamepb.interactpb.InteractRecordsRequest');
    resolved.InteractRecordsReply = newRoot.lookupType('gamepb.interactpb.InteractRecordsReply');
    resolved.ItemNotify = newRoot.lookupType('gamepb.itempb.ItemNotify');
    resolved.GoodsUnlockNotify = newRoot.lookupType('gamepb.shoppb.GoodsUnlockNotify');
    resolved.TaskInfoNotify = newRoot.lookupType('gamepb.taskpb.TaskInfoNotify');

    // 完整加载与类型解析成功，才发布就绪：root 发布、types 原地填充（引用稳定）
    for (const key of Object.keys(resolved)) {
        types[key] = resolved[key];
    }
    root = newRoot;
    log('系统', 'Protobuf 定义加载完成');
}

/**
 * 加载协议定义。并发调用共享同一次加载；成功后再次调用直接复用结果；
 * 上次失败后再次调用会发起一次新尝试（不自动重试）。
 */
function loadProto() {
    if (loadPromise && !loadError) {
        return loadPromise;
    }
    loadError = null;
    log('系统', '正在加载 Protobuf 定义...');
    const attempt = performLoad();
    loadPromise = attempt;
    // 失败记账先于任何外部 awaiter 的回调执行：清除半成品就绪状态（root 不发布），
    // 保留错误供 waitForProtoReady 明确拒绝。成功路径无需额外处理。
    attempt.then(null, (err) => {
        if (loadPromise === attempt) {
            loadError = err;
        }
    });
    return attempt;
}

function getRoot() {
    return root;
}

async function waitForProtoReady() {
    if (loadError) {
        throw new Error(`Protobuf 定义加载失败: ${loadError.message}`);
    }
    if (loadPromise) {
        // 等待已发起的那次真实加载（成功即返回；失败会把底层错误抛给等待者）
        await loadPromise;
        return true;
    }
    throw new Error('Protobuf 定义尚未加载，请先调用 loadProto');
}

module.exports = { loadProto, types, getRoot, waitForProtoReady };
