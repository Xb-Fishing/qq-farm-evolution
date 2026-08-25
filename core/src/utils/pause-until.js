'use strict';

// 旧版 Web 保存的是不带时区的 datetime-local 字符串，而 Bot 服务器运行在 UTC。
// 项目所有定时策略均按北京时间展示，因此旧值按北京时间解释；新值统一为 ISO 绝对时间。
const LEGACY_BEIJING_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/;

function parsePauseUntilMs(raw) {
    const text = String(raw || '').trim();
    if (!text) return Number.NaN;
    if (LEGACY_BEIJING_LOCAL_RE.test(text)) {
        return Date.parse(`${text}+08:00`);
    }
    return Date.parse(text);
}

function normalizePauseUntil(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    const ts = parsePauseUntilMs(text);
    return Number.isFinite(ts) ? new Date(ts).toISOString() : '';
}

module.exports = {
    parsePauseUntilMs,
    normalizePauseUntil
};
