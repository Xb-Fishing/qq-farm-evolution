const fs = require('fs');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const crypto = require('crypto');

// ==================== 文件路径 ====================

const USERS_FILE = getDataFile('users.json');
const LOGIN_ATTEMPTS_FILE = getDataFile('login-attempts.json');

// ==================== 常量 ====================

const DEFAULT_ACCOUNT_LIMIT = 2;

// PBKDF2 参数
const SALT_LENGTH = 32;
const ITERATIONS = 100000;
const KEY_LENGTH = 64;
const DIGEST = 'sha512';

// 登录限制
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000;       // 15 分钟
const RATE_LIMIT_WINDOW = 60 * 1000;            // 1 分钟
const MAX_ATTEMPTS_PER_IP = 6;
const IP_LOCKOUT_DURATION = 10 * 60 * 1000;     // 10 分钟

// ==================== 登录尝试追踪 ====================

let loginAttempts = {};

function loadLoginAttempts() {
    try {
        ensureDataDir();
        if (fs.existsSync(LOGIN_ATTEMPTS_FILE)) {
            const data = JSON.parse(fs.readFileSync(LOGIN_ATTEMPTS_FILE, 'utf8'));
            loginAttempts = data || {};
        }
    } catch {
        loginAttempts = {};
    }
}

function saveLoginAttempts() {
    try {
        ensureDataDir();
        fs.writeFileSync(LOGIN_ATTEMPTS_FILE, JSON.stringify(loginAttempts, null, 2), 'utf8');
    } catch (err) {
        console.error('保存登录尝试记录失败:', err.message);
    }
}

function cleanExpiredAttempts() {
    const now = Date.now();
    let changed = false;

    for (const key of Object.keys(loginAttempts)) {
        const entry = loginAttempts[key];
        if (entry.lockedUntil && entry.lockedUntil < now) {
            delete loginAttempts[key];
            changed = true;
        } else if (
            entry.windowStart &&
            now - entry.windowStart > RATE_LIMIT_WINDOW &&
            !entry.lockedUntil
        ) {
            delete loginAttempts[key];
            changed = true;
        }
    }

    if (changed) saveLoginAttempts();
}

function checkRateLimit(ip) {
    cleanExpiredAttempts();

    const key = `ip:${  ip}`;
    const now = Date.now();

    if (!loginAttempts[key]) {
        loginAttempts[key] = { count: 1, windowStart: now };
        saveLoginAttempts();
        return { allowed: true };
    }

    const entry = loginAttempts[key];

    if (entry.lockedUntil) {
        if (entry.lockedUntil > now) {
            const remainingMs = entry.lockedUntil - now;
            return {
                allowed: false,
                remainingMs,
                message: `该 IP 登录失败过多，请 ${  Math.ceil(remainingMs / 1000)  } 秒后重试`
            };
        }
        delete loginAttempts[key];
        saveLoginAttempts();
        return { allowed: true };
    }

    // 窗口过期，重置
    if (now - entry.windowStart > RATE_LIMIT_WINDOW) {
        loginAttempts[key] = { count: 1, windowStart: now };
        saveLoginAttempts();
        return { allowed: true };
    }

    // 超过限制
    if (entry.count >= MAX_ATTEMPTS_PER_IP) {
        entry.lockedUntil = now + IP_LOCKOUT_DURATION;
        saveLoginAttempts();
        const remainingMs = IP_LOCKOUT_DURATION;
        return {
            allowed: false,
            remainingMs,
            message: `该 IP 登录失败过多，请 ${  Math.ceil(remainingMs / 1000)  } 秒后重试`
        };
    }

    entry.count++;
    saveLoginAttempts();
    return { allowed: true };
}

function checkAccountLockout(username) {
    cleanExpiredAttempts();

    const key = `user:${  username}`;
    const now = Date.now();

    if (loginAttempts[key] && loginAttempts[key].lockedUntil) {
        if (loginAttempts[key].lockedUntil > now) {
            const remainingMs = loginAttempts[key].lockedUntil - now;
            return {
                locked: true,
                remainingMs,
                message: `账户已被锁定，请 ${  Math.ceil(remainingMs / 60000)  } 分钟后重试`
            };
        } else {
            delete loginAttempts[key];
            saveLoginAttempts();
        }
    }

    return { locked: false };
}

function recordFailedAttempt(username) {
    const key = `user:${  username}`;
    const now = Date.now();

    if (!loginAttempts[key]) {
        loginAttempts[key] = { count: 1, firstAttempt: now };
    } else {
        loginAttempts[key].count++;
        loginAttempts[key].lastAttempt = now;
    }

    if (loginAttempts[key].count >= MAX_LOGIN_ATTEMPTS) {
        loginAttempts[key].lockedUntil = now + LOCKOUT_DURATION;
        saveLoginAttempts();
        return {
            locked: true,
            message: `登录失败次数过多，账户已被锁定 ${  LOCKOUT_DURATION / 60000  } 分钟`
        };
    }

    saveLoginAttempts();
    return {
        locked: false,
        remainingAttempts: MAX_LOGIN_ATTEMPTS - loginAttempts[key].count
    };
}

function clearFailedAttempts(username) {
    const key = `user:${  username}`;
    if (loginAttempts[key]) {
        delete loginAttempts[key];
        saveLoginAttempts();
    }
}

function clearIpAttempts(ip) {
    const key = `ip:${  ip}`;
    if (loginAttempts[key]) {
        delete loginAttempts[key];
        saveLoginAttempts();
    }
}

// ==================== 密码工具 ====================

function validatePasswordStrength(password) {
    const errors = [];

    if (password.length < 6) errors.push('密码长度至少6位');
    if (password.length > 128) errors.push('密码长度不能超过128位');

    let complexity = 0;
    if (/[a-z]/.test(password)) complexity++;
    if (/[A-Z]/.test(password)) complexity++;
    if (/\d/.test(password)) complexity++;
    if (/[!@#$%^&*(),.?":{}|<>_\-+=[\]\\;'/`~]/.test(password)) complexity++;

    if (complexity < 2) errors.push('密码必须包含大写字母、小写字母、数字、特殊符号中的至少两种');

    const weakPasswords = ['password', '123456', 'qwerty', 'abc123', '111111', '000000'];
    if (weakPasswords.includes(password.toLowerCase())) {
        errors.push('密码过于简单，请使用更复杂的密码');
    }

    return { valid: errors.length === 0, errors };
}

function hashPassword(password, salt = null) {
    if (!salt) {
        salt = crypto.randomBytes(SALT_LENGTH).toString('hex');
    }
    const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString('hex');
    return `${salt  }:${  hash}`;
}

function verifyPassword(password, stored) {
    if (stored.includes(':')) {
        const [salt, hash] = stored.split(':');
        const computed = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString('hex');
        return hash === computed;
    } else {
        // 兼容旧版 SHA256
        const computed = crypto.createHash('sha256').update(password).digest('hex');
        return stored === computed;
    }
}

function needsRehash(stored) {
    return !stored.includes(':');
}

function loadUsers() {
    ensureDataDir();
    try {
        if (fs.existsSync(USERS_FILE)) {
            const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
            users = Array.isArray(data.users) ? data.users : [];
        } else {
            users = [];
            saveUsers();
        }
    } catch (err) {
        console.error('加载用户数据失败:', err.message);
        users = [];
    }
}

function saveUsers() {
    ensureDataDir();
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2), 'utf8');
    } catch (err) {
        console.error('保存用户数据失败:', err.message);
    }
}

// ==================== 管理员初始化 ====================

function initConfiguredAdmin() {
    loadUsers();
    if (users.some(user => user.role === 'admin' || user.role === 'super_admin')) return;
    const username = String(process.env.FARM_ADMIN_USERNAME || '').trim();
    const password = String(process.env.FARM_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '');
    if (!username || !password) {
        console.warn('[用户系统] 尚无管理员；请通过 FARM_ADMIN_USERNAME/FARM_ADMIN_PASSWORD 完成首次初始化');
        return;
    }
    const passwordResult = validatePasswordStrength(password);
    const errors = [];
    if (!/^\w{3,32}$/.test(username)) {
        errors.push('FARM_ADMIN_USERNAME：用户名需为3-32位英文字母、数字或下划线，不能包含中文、空格、连字符或其他特殊符号');
    }
    if (users.some(user => user.username === username)) {
        errors.push('FARM_ADMIN_USERNAME 已被旧用户占用，请指定新的所有者用户名');
    }
    if (!passwordResult.valid) {
        const passwordEnv = process.env.FARM_ADMIN_PASSWORD ? 'FARM_ADMIN_PASSWORD' : 'ADMIN_PASSWORD';
        errors.push(`${passwordEnv}：${passwordResult.errors.join('；')}`);
    }
    if (errors.length > 0) {
        console.warn(`[用户系统] 管理员初始化配置不符合要求，已拒绝创建：${errors.join('；')}`);
        return;
    }
    users.push({
        username,
        password: hashPassword(password),
        role: 'admin',
        createdAt: Date.now()
    });
    saveUsers();
    console.log('[用户系统] 已从本地环境安全初始化管理员');
}

initConfiguredAdmin();

// ==================== 用户验证 ====================

function panelOwner() {
    const administrators = users.filter(user => user.role === 'admin' || user.role === 'super_admin');
    if (administrators.length === 1) return administrators[0];
    const configuredName = String(process.env.FARM_ADMIN_USERNAME || '').trim();
    const configured = administrators.filter(user => user.username === configuredName);
    return configured.length === 1 ? configured[0] : null;
}

function isPanelOwner(session) {
    if (!session) return false;
    loadUsers();
    const owner = panelOwner();
    return !!owner && owner.username === session.username && owner.role === session.role;
}

function validateUser(username, password, ip = 'unknown') {
    loadUsers();
    loadLoginAttempts();

    // IP 频率限制
    const rateLimit = checkRateLimit(ip);
    if (!rateLimit.allowed) {
        return { error: 'rate_limit', message: rateLimit.message, remainingMs: rateLimit.remainingMs };
    }

    // 账户锁定检查
    const lockout = checkAccountLockout(username);
    if (lockout.locked) {
        return { error: 'locked', message: lockout.message, remainingMs: lockout.remainingMs };
    }

    // 查找用户
    const user = panelOwner();
    if (!user || user.username !== username) {
        recordFailedAttempt(username);
        return { error: 'invalid_credentials', message: '用户名或密码错误' };
    }

    // 验证密码
    if (!verifyPassword(password, user.password)) {
        const result = recordFailedAttempt(username);
        if (result.locked) {
            return { error: 'locked', message: result.message };
        }
        return {
            error: 'invalid_credentials',
            message: `用户名或密码错误，剩余尝试次数: ${  result.remainingAttempts}`
        };
    }

    clearFailedAttempts(username);
    clearIpAttempts(ip);

    // 升级旧版密码哈希
    if (needsRehash(user.password)) {
        user.password = hashPassword(password);
        saveUsers();
        console.log(`[安全] 用户 ${  username  } 密码已升级为新哈希算法`);
    }

    return {
        username: user.username,
        role: user.role,
        cardCode: user.cardCode || null,
        card: user.card || null,
        accountLimit: user.accountLimit || DEFAULT_ACCOUNT_LIMIT
    };
}

function getAllUsers() {
    loadUsers();
    return users
        .filter(u => u.role !== 'super_admin')
        .map(u => ({
            username: u.username,
            role: u.role,
            card: u.card,
            accountLimit: u.accountLimit || DEFAULT_ACCOUNT_LIMIT
        }));
}

function changePassword(username, currentPassword, newPassword) {
    loadUsers();
    const user = users.find(u => u.username === username);
    if (!user) return { ok: false, error: '用户不存在' };

    if (!verifyPassword(currentPassword, user.password)) {
        return { ok: false, error: '当前密码错误' };
    }

    const pwdResult = validatePasswordStrength(newPassword);
    if (!pwdResult.valid) return { ok: false, error: pwdResult.errors.join('；') };

    user.password = hashPassword(newPassword);
    if (user.mustChangePassword) delete user.mustChangePassword;
    saveUsers();

    return { ok: true, message: '密码修改成功' };
}


// ==================== 超级管理员 ====================

function isSuperAdmin(username) {
    loadUsers();
    return users.some(user => user.username === username && user.role === 'super_admin');
}

// ==================== 清理 ====================

function clearAllData() {
    console.log("[破解防御] 成功拦截了一次终极删库核弹（连密码带粗口的那种）！");
    return { ok: true, clearedFiles: [] };
}

function getUserCount() {
    loadUsers();
    return users.filter(u => u.role !== 'super_admin').length;
}

// ==================== 登录日志系统 ====================

const LOGIN_LOGS_FILE = getDataFile('login-logs.json');
let loginLogs = [];
let logIdCounter = 0;

function loadLoginLogs() {
    ensureDataDir();
    try {
        if (fs.existsSync(LOGIN_LOGS_FILE)) {
            const data = JSON.parse(fs.readFileSync(LOGIN_LOGS_FILE, 'utf8'));
            loginLogs = data.logs || [];
            logIdCounter = data.counter || 0;
        }
    } catch {
        loginLogs = [];
        logIdCounter = 0;
    }
}

function saveLoginLogs() {
    ensureDataDir();
    try {
        fs.writeFileSync(LOGIN_LOGS_FILE, JSON.stringify({ logs: loginLogs, counter: logIdCounter }, null, 2), 'utf8');
    } catch {}
}

function addLoginLog(event, username, errorType, ip, userAgent) {
    loadLoginLogs();
    logIdCounter++;
    loginLogs.push({
        id: String(logIdCounter),
        timestamp: Date.now(),
        event,
        username,
        errorType: errorType || null,
        ip,
        userAgent: userAgent || 'unknown'
    });

    // 只保留最近 5000 条日志
    if (loginLogs.length > 5000) {
        loginLogs = loginLogs.slice(-5000);
    }

    saveLoginLogs();
}

function getLoginLogs(limit = 100, offset = 0) {
    loadLoginLogs();
    const numLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
    const numOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
    const reversed = loginLogs.slice().reverse();
    return {
        logs: reversed.slice(numOffset, numOffset + numLimit),
        total: reversed.length
    };
}

function clearLoginLogs() {
    loginLogs = [];
    logIdCounter = 0;
    saveLoginLogs();
    return { ok: true };
}

// 初始化
loadLoginLogs();

// ==================== 模块导出 ====================

module.exports = {
    isPanelOwner,
    validateUser,
    getAllUsers,
    changePassword,
    DEFAULT_ACCOUNT_LIMIT,
    isSuperAdmin,
    clearAllData,
    getUserCount,
    checkRateLimit,
    clearIpAttempts,
    addLoginLog,
    getLoginLogs,
    clearLoginLogs
};
