const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

/** 是否被打包为 pkg 可执行文件 */
const isPackaged = !!process.pkg;

/** 获取资源根目录 */
function getResourceRoot() {
    return path.join(__dirname, '..');
}

/**
 * 获取资源文件路径
 * @param  {...string} segments - 路径片段
 */
function getResourcePath(...segments) {
    return path.join(getResourceRoot(), ...segments);
}

/** 获取可写文件的根目录（打包模式用 exe 同级，源码模式用上级目录） */
function getAppRootForWritable() {
    return isPackaged
        ? path.dirname(process.execPath)
        : path.join(__dirname, '../..');
}

/** 获取数据存储目录 */
function getDataDir() {
    if (process.env.FARM_DATA_DIR) {
        return path.resolve(process.env.FARM_DATA_DIR);
    }
    return path.join(getAppRootForWritable(), 'data');
}

/** 确保数据目录存在 */
function ensureDataDir() {
    const dir = getDataDir();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    try { fs.chmodSync(dir, 0o700); } catch {}
    return dir;
}

/**
 * 运行数据包含登录凭据、管理会话、日志和抓包 CA，启动时统一收紧权限。
 * 不跟随符号链接，避免越过 FARM_DATA_DIR 修改其他位置。
 */
function secureRuntimeDataTree() {
    const root = ensureDataDir();
    const pending = [root];
    while (pending.length > 0) {
        const current = pending.pop();
        let entries;
        try {
            fs.chmodSync(current, 0o700);
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const target = path.join(current, entry.name);
            try {
                if (entry.isDirectory()) pending.push(target);
                else if (entry.isFile()) fs.chmodSync(target, 0o600);
            } catch {}
        }
    }
    return root;
}

/**
 * 获取数据文件完整路径
 * @param {string} filename - 文件名
 */
function getDataFile(filename) {
    return path.join(getDataDir(), filename);
}

/** 获取分享文件路径 */
function getShareFilePath() {
    if (process.env.FARM_DATA_DIR) {
        return path.join(getDataDir(), 'share.txt');
    }
    return path.join(getAppRootForWritable(), 'share.txt');
}

module.exports = {
    isPackaged,
    getResourcePath,
    getDataDir,
    getDataFile,
    ensureDataDir,
    secureRuntimeDataTree,
    getShareFilePath
};
