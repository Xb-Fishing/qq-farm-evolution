// Optional local module provider. The ordinary application works without one.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDataDir } = require('../config/runtime-paths');
const ROOT = path.resolve(__dirname, '../../..');
function load() {
  const file = path.join(getDataDir(), 'local-module-provider.json');
  if (!fs.existsSync(file)) return null;
  if (!fs.lstatSync(file).isFile()) throw new Error('module_provider_invalid');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (config.enabled === false) return null;
  if (config.version !== 1 || !path.isAbsolute(config.packageRoot || '')) throw new Error('module_provider_invalid');
  let root = fs.realpathSync(config.packageRoot);
  let update;
  try { update = JSON.parse(fs.readFileSync(path.join(getDataDir(), 'program-update.json'), 'utf8')); } catch { /* No matching update transaction. */ }
  if (update?.phase === 'applying' && [update.target?.runtimeRoot, update.taskRoot].includes(ROOT) && update.overlay?.previousRoot === root) root = fs.realpathSync(update.overlay.root);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const loader = path.join(root, 'preload.cjs');
  if (!fs.lstatSync(loader).isFile() || crypto.createHash('sha256').update(fs.readFileSync(loader)).digest('hex') !== manifest.privatePreloadSha256) throw new Error('module_provider_changed');
  return require(loader);
}
function start() {
  const provider = load();
  if (!provider) return false;
  if (typeof provider.start !== 'function' || provider.start(ROOT, process.env.FARM_WORKER === '1' || process.env.FARM_SESSION_BUSINESS === '1' ? 'business' : 'manager') !== true) throw new Error('module_provider_unavailable');
  return true;
}
function attach(module) {
  const provider = load();
  if (!provider) return false;
  if (typeof provider.attach !== 'function' || provider.attach(module, ROOT) !== true) throw new Error('module_provider_unavailable');
  return true;
}
module.exports = { start, attach };
