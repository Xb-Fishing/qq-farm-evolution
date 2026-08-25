const crypto = require('node:crypto');

const DEVICE_POOL = [
  {
    brand: 'Apple',
    model: 'iPhone 15 Pro',
    os: 'iOS',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.56',
  },
  {
    brand: 'Apple',
    model: 'iPhone 14',
    os: 'iOS',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.54',
  },
  {
    brand: 'Apple',
    model: 'iPhone 13',
    os: 'iOS',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.53',
  },
  {
    brand: 'Xiaomi',
    model: 'Xiaomi 14',
    os: 'Android',
    ua: 'Mozilla/5.0 (Linux; Android 14; 24031PN0DC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.56',
  },
  {
    brand: 'Huawei',
    model: 'Mate 60',
    os: 'Android',
    ua: 'Mozilla/5.0 (Linux; Android 12; ALN-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.54',
  },
  {
    brand: 'OPPO',
    model: 'Find X6',
    os: 'Android',
    ua: 'Mozilla/5.0 (Linux; Android 13; PGFM10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.55',
  },
  {
    brand: 'vivo',
    model: 'X100',
    os: 'Android',
    ua: 'Mozilla/5.0 (Linux; Android 14; V2309A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.56',
  },
  {
    brand: 'HONOR',
    model: 'Magic6',
    os: 'Android',
    ua: 'Mozilla/5.0 (Linux; Android 14; BVL-AN16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.55',
  },
  {
    brand: 'samsung',
    model: 'SM-S9180',
    os: 'Android',
    ua: 'Mozilla/5.0 (Linux; Android 14; SM-S9180) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.54',
  },
  {
    brand: 'OnePlus',
    model: 'PJZ110',
    os: 'Android',
    ua: 'Mozilla/5.0 (Linux; Android 14; PJZ110) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.56',
  },
  {
    brand: 'Apple',
    model: 'iPhone 12',
    os: 'iOS',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.52',
  },
  {
    brand: 'Xiaomi',
    model: 'Redmi K70',
    os: 'Android',
    ua: 'Mozilla/5.0 (Linux; Android 14; 23113RKC6C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.53',
  },
];

function hashHex(seed) {
  return crypto.createHash('sha256').update(String(seed)).digest('hex');
}

function macFromHex(hex) {
  const bytes = hex.slice(0, 12);
  const parts = [];
  for (let i = 0; i < 12; i += 2) parts.push(bytes.slice(i, i + 2));
  parts[0] = (parseInt(parts[0], 16) & 0xfe | 0x02).toString(16).padStart(2, '0');
  return parts.join(':');
}

/** 同一 accountId 永远得到同一台机；不要每次登录重算覆盖已落盘的值。 */
function buildStableDeviceProtocol(accountId) {
  const hex = hashHex(`qq-farm-device:${String(accountId)}`);
  const profile = DEVICE_POOL[parseInt(hex.slice(0, 8), 16) % DEVICE_POOL.length];
  return {
    enabled: true,
    userAgent: profile.ua,
    deviceBrand: profile.brand,
    deviceModel: profile.model,
    deviceId: hex.slice(0, 16).toUpperCase(),
    deviceMac: macFromHex(hex.slice(16, 28)),
    imei: String(parseInt(hex.slice(28, 40), 16)).padStart(15, '0').slice(0, 15),
  };
}

module.exports = {
  DEVICE_POOL,
  buildStableDeviceProtocol,
};
