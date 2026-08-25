/**
 * 飞书直推：裸飞书自定义机器人 webhook 直接 POST JSON（不走 pushoo）。
 * webhook 是用户私人的，不要写进任何公开输出。
 */
const { getPrivateValue } = require('./private-config');
const { redactExternalText } = require('./privacy-guard');

function isFeishuWebhook(url) {
    return /^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\//.test(String(url || '').trim());
}

/**
 * 发送文本消息到飞书自定义机器人。
 * @param {string} title
 * @param {string} content
 * @param {string} [webhook] 缺省读取环境变量或 ignored 的本地私密配置
 */
async function sendFeishuText(title, content, webhook = '') {
    const url = String(webhook || getPrivateValue('feishuWebhook', 'FEISHU_WEBHOOK')).trim();
    if (!isFeishuWebhook(url)) {
        throw new Error('未配置有效的飞书机器人 webhook');
    }
    const body = JSON.stringify({
        msg_type: 'text',
        content: { text: redactExternalText(`${title}\n${content}`).slice(0, 4000) },
    });
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
    });
    const data = await res.json().catch(() => ({}));
    if (data.code !== undefined && Number(data.code) !== 0) {
        throw new Error(`飞书返回错误: code=${data.code} msg=${data.msg || ''}`);
    }
    return { ok: true };
}

module.exports = { sendFeishuText, isFeishuWebhook };
