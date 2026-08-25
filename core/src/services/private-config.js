const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { getDataFile } = require('../config/runtime-paths');

const PRIVATE_CONFIG_FILE = 'private-config.json';

function getPrivateConfigPath(options = {}) {
  const configured = options.file || process.env.FARM_PRIVATE_CONFIG_FILE;
  return configured ? path.resolve(String(configured)) : getDataFile(PRIVATE_CONFIG_FILE);
}

function protectPrivateFile(filePath) {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // 某些只读或非 POSIX 文件系统不支持 chmod；读取仍可继续。
  }
}

function readPrivateConfig(options = {}) {
  const filePath = getPrivateConfigPath(options);
  try {
    if (!fs.existsSync(filePath)) return {};
    protectPrivateFile(filePath);
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function getPrivateValue(key, envName, options = {}) {
  const env = options.env || process.env;
  const fromEnv = envName ? String(env[envName] || '').trim() : '';
  if (fromEnv) return fromEnv;
  const config = options.config || readPrivateConfig(options);
  return String(config[key] || '').trim();
}

module.exports = {
  PRIVATE_CONFIG_FILE,
  getPrivateConfigPath,
  protectPrivateFile,
  readPrivateConfig,
  getPrivateValue,
};
