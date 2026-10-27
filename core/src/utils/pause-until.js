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

/** Remaining daily quiet time in Beijing; zero outside the saved HH:MM window. */
function getDailyQuietRemainMs(quiet, now = Date.now()) {
    if (!quiet?.enabled || !Number.isFinite(now)) return 0;
    const clock = value => {
        const match = /^(\d{1,2}):(\d{1,2})$/.exec(String(value || ''));
        if (!match) return null;
        const hour = Number(match[1]);
        const minute = Number(match[2]);
        return hour < 24 && minute < 60 ? hour * 60 + minute : null;
    };
    const start = clock(quiet.start);
    const end = clock(quiet.end);
    if (start === null || end === null) return 0;
    const dayMs = 86400000;
    const offset = 8 * 3600000;
    const day = Math.floor((now + offset) / dayMs) * dayMs - offset;
    const startAt = day + start * 60000;
    const endAt = day + end * 60000;
    if (start === end) return (endAt > now ? endAt : endAt + dayMs) - now;
    if (start < end) return now >= startAt && now < endAt ? endAt - now : 0;
    if (now >= startAt) return endAt + dayMs - now;
    return now < endAt ? endAt - now : 0;
}

module.exports = {
    getDailyQuietRemainMs,
    parsePauseUntilMs,
    normalizePauseUntil
};
