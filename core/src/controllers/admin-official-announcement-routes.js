const { getAuthorizedAccountId, requireConnectedAccount } = require('./admin-activity-route-helpers');

function registerAdminOfficialAnnouncementRoutes({ app, provider, getAccountIdFromRequest, canAccessAccount, sendProviderError }) {
    app.get('/api/activity/official-announcements', async (req, res) => {
        const accountId = getAuthorizedAccountId(req, res, { getAccountIdFromRequest, canAccessAccount });
        if (!accountId) return;
        try {
            if (!requireConnectedAccount(res, provider, accountId, '读取官方公告失败: 账号未运行')) return;
            const result = await provider.getOfficialAnnouncements(accountId);
            res.json({ ok: true, data: result });
        } catch (error) { sendProviderError(res, error); }
    });
}

module.exports = { registerAdminOfficialAnnouncementRoutes };
