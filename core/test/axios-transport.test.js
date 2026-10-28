const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { createRequire } = require('node:module');
const { test, before, after } = require('node:test');
const axios = require('axios');
const pushRequire = createRequire(require.resolve('pushoo'));
const pushAxios = pushRequire('axios');
const { QRLoginSession, MiniProgramLoginSession } = require('../src/services/qrlogin');
const { sendPushooMessage } = require('../src/services/push');

// Every transport target and proxy in this suite is a loopback fixture.
const envKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'npm_config_proxy', 'npm_config_http_proxy', 'npm_config_https_proxy', 'npm_config_no_proxy'];
const savedEnv = new Map(envKeys.map(key => [key, process.env[key]]));
function clearProxyEnv() { for (const key of envKeys) delete process.env[key]; }
clearProxyEnv();
let base, secureBase, proxyBase, server, secureServer, proxyServer, ca;
let proxyRequests = 0; let tunnels = 0;
const requests = [];
const sockets = new Set();
const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function listen(instance) {
  instance.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise(resolve => instance.listen(0, '127.0.0.1', () => resolve(instance.address().port)));
}
function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function handler(req, res) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const url = new URL(req.url, base);
    requests.push({ path: url.pathname, method: req.method, headers: req.headers, body });
    if (url.pathname === '/redirect') { res.writeHead(302, { Location: '/image' }); res.end(); }
    else if (url.pathname === '/post-redirect') { res.writeHead(307, { Location: '/echo' }); res.end(); }
    else if (url.pathname === '/cross-host') {
      res.writeHead(302, { Location: `${base.replace('127.0.0.1', 'localhost')  }/echo` }); res.end();
    } else if (url.pathname === '/image' || url.pathname === '/ptqrshow') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Set-Cookie': ['qrsig=synthetic-signature; Path=/'] });
      res.end(image);
    } else if (url.pathname === '/ptqrlogin') {
      res.setHeader('Set-Cookie', ['session=synthetic; Path=/']);
      res.end("ptuiCB('0','0','https://example.invalid/done','0','成功','合成用户');");
    } else if (url.pathname.endsWith('/GetLoginCode')) json(res, { code: 0, data: { code: 'synthetic-code' } });
    else if (url.pathname.endsWith('/syncScanSateGetTicket')) {
      const code = url.searchParams.get('code');
      json(res, code === 'used' ? { code: -10001 } : code === 'error' ? { code: 9 }
        : { code: 0, data: { ok: code === 'wait' ? 0 : 1, ticket: 'synthetic-ticket', uin: '501', nick: '合成用户' } });
    } else if (url.pathname === '/ide/login') json(res, { code: 'synthetic-auth-code' });
    else if (url.pathname === '/push-ok') json(res, { code: 0, msg: '发送成功' });
    else if (url.pathname === '/push-fail') json(res, { code: 1, msg: '失败' });
    else if (url.pathname === '/error') json(res, { error: 'synthetic failure' }, 503);
    else if (url.pathname === '/timeout') { /* Client must terminate its own timed out request. */ }
    else json(res, { method: req.method, body, headers: req.headers });
  });
}

before(async () => {
  server = http.createServer(handler);
  base = `http://127.0.0.1:${await listen(server)}`;
  proxyServer = http.createServer((req, res) => {
    proxyRequests++;
    const target = new URL(req.url);
    assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname));
    assert.equal(target.port, new URL(base).port);
    const upstream = http.request({ hostname: '127.0.0.1', port: target.port,
      path: target.pathname + target.search, method: req.method, headers: req.headers }, reply => {
      res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  proxyServer.on('connect', (req, client, head) => {
    tunnels++;
    assert.equal(req.url, new URL(secureBase).host);
    const upstream = net.connect(Number(new URL(secureBase).port), '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  proxyBase = `http://127.0.0.1:${await listen(proxyServer)}`;
  const forge = require('node-forge');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 60000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  cert.setSubject([{ name: 'commonName', value: 'localhost' }]); cert.setIssuer(cert.subject.attributes);
  cert.setExtensions([{ name: 'basicConstraints', cA: true },
    { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  ca = forge.pki.certificateToPem(cert);
  secureServer = https.createServer({ key: forge.pki.privateKeyToPem(keys.privateKey), cert: ca }, handler);
  secureBase = `https://127.0.0.1:${await listen(secureServer)}`;
});
after(async () => {
  clearProxyEnv();
  for (const [key, value] of savedEnv) if (value !== undefined) process.env[key] = value;
  for (const socket of sockets) socket.destroy();
  await Promise.all([server, secureServer, proxyServer].filter(Boolean).map(instance => new Promise(resolve => instance.close(resolve))));
});

test('actual QR login consumers retain images, cookies, status parsing and JSON POST', async () => {
  const interceptor = axios.interceptors.request.use(config => {
    const url = new URL(config.url);
    assert.ok(['ssl.ptlogin2.qq.com', 'q.qq.com'].includes(url.hostname));
    config.url = base + url.pathname + url.search;
    config.proxy = false;
    return config;
  });
  try {
    const qr = await QRLoginSession.requestQRCode();
    assert.equal(qr.qrsig, 'synthetic-signature');
    assert.equal(qr.qrcode, `data:image/png;base64,${image.toString('base64')}`);
    const status = await QRLoginSession.checkStatus(qr.qrsig);
    assert.equal(status.ret, '0'); assert.equal(status.nickname, '合成用户');
    assert.deepEqual(status.cookie, ['session=synthetic; Path=/']);
    const mini = await MiniProgramLoginSession.requestLoginCode();
    assert.equal(mini.code, 'synthetic-code'); assert.match(mini.image, /^data:image\/png;base64,/);
    for (const [code, expected] of [['wait', 'Wait'], ['ok', 'OK'], ['used', 'Used'], ['error', 'Error']]) {
      assert.equal((await MiniProgramLoginSession.queryStatus(code)).status, expected);
    }
    assert.equal(await MiniProgramLoginSession.getAuthCode('synthetic-ticket'), 'synthetic-auth-code');
    const sent = requests.findLast(row => row.path === '/ide/login');
    assert.deepEqual(JSON.parse(sent.body), { appid: '1112386029', ticket: 'synthetic-ticket' });
  } finally { axios.interceptors.request.eject(interceptor); }
});

for (const [name, client] of [['direct', axios], ['pushoo', pushAxios]]) {
  test(`${name} Axios retains HTTP redirects, POST bodies, form parameters, errors and timeouts`, async () => {
    const redirect = await client.get(`${base  }/redirect`, { responseType: 'arraybuffer' });
    assert.deepEqual(Buffer.from(redirect.data), image);
    const post = await client.post(`${base  }/post-redirect`, { title: '合成标题', content: '**测试**' });
    assert.equal(post.data.method, 'POST');
    assert.deepEqual(JSON.parse(post.data.body), { title: '合成标题', content: '**测试**' });
    const form = await client.post(`${base  }/echo`, new URLSearchParams({ message: '中文 & 测试' }));
    assert.equal(new URLSearchParams(form.data.body).get('message'), '中文 & 测试');
    await assert.rejects(client.get(`${base  }/error`), error => error.response.status === 503);
    await assert.rejects(client.get(`${base  }/timeout`, { timeout: 100 }), error => /timeout/i.test(error.message));
  });

  test(`${name} Axios strips credentials on a cross-host redirect`, async () => {
    const result = await client.get(`${base  }/cross-host`, {
      headers: { Authorization: 'Bearer synthetic', Cookie: 'session=synthetic' },
      // The fixture proxy connects only to IPv4 loopback. This works even for
      // older Axios adapters that do not forward a custom DNS lookup function.
      proxy: { protocol: 'http', host: '127.0.0.1', port: Number(new URL(proxyBase).port) },
    });
    assert.equal(result.data.headers.authorization, undefined);
    assert.equal(result.data.headers.cookie, undefined);
  });

  test(`${name} Axios honors HTTP_PROXY and NO_PROXY`, async () => {
    clearProxyEnv();
    try {
      process.env.HTTP_PROXY = proxyBase;
      const beforeCount = proxyRequests;
      await client.get(`${base  }/echo`);
      assert.equal(proxyRequests, beforeCount + 1);
      process.env.NO_PROXY = '127.0.0.1';
      await client.get(`${base  }/echo`);
      assert.equal(proxyRequests, beforeCount + 1);
    } finally { clearProxyEnv(); }
  });
}

test('redirect library clears an explicitly registered custom credential header', async () => {
  const redirects = createRequire(require.resolve('axios'))('follow-redirects');
  const result = await new Promise((resolve, reject) => {
    const request = redirects.http.get(`${base  }/cross-host`, {
      headers: { 'X-API-Key': 'synthetic-key' }, sensitiveHeaders: ['X-API-Key'],
      lookup: (_host, options, done) => options.all
        ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4),
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('local fixture timeout')));
  });
  assert.equal(result.headers['x-api-key'], undefined);
});

test('direct Axios honors HTTPS_PROXY CONNECT and NO_PROXY with certificate verification', async () => {
  clearProxyEnv();
  const agent = new https.Agent({ ca });
  try {
    process.env.HTTPS_PROXY = proxyBase;
    const beforeCount = tunnels;
    assert.equal((await axios.get(`${secureBase  }/echo`, { httpsAgent: agent })).status, 200);
    assert.equal(tunnels, beforeCount + 1);
    process.env.NO_PROXY = '127.0.0.1';
    await axios.get(`${secureBase  }/echo`, { httpsAgent: agent });
    assert.equal(tunnels, beforeCount + 1);
  } finally { clearProxyEnv(); agent.destroy(); }
});

test('real pushoo webhook and application result parser preserve token and failure semantics', async () => {
  for (const token of ['', 'synthetic-token']) {
    const result = await sendPushooMessage({ channel: 'webhook', endpoint: `${base  }/push-ok`, token,
      title: '合成标题', content: '**中文测试**' });
    assert.equal(result.ok, true);
    const sent = JSON.parse(requests.at(-1).body);
    assert.equal(sent.content, '**中文测试**');
    assert.equal(sent.token, token || undefined);
  }
  assert.equal((await sendPushooMessage({ channel: 'webhook', endpoint: `${base  }/push-fail`,
    title: '合成标题', content: '合成内容' })).ok, false);
});

test('pushoo form and OneBot callers retain serialization, Bearer headers and timeout', async () => {
  const original = pushAxios.defaults.adapter;
  const sent = [];
  pushAxios.defaults.adapter = async config => {
    sent.push(config);
    return { data: { code: 0, retcode: 0 }, status: 200, statusText: 'OK', headers: {}, config };
  };
  try {
    const pushoo = require('pushoo').default;
    await pushoo('serverchan', { token: 'SCT-synthetic', title: '合成标题', content: '合成内容' });
    assert.match(sent[0].data, /title=/);
    assert.equal(new URLSearchParams(sent[0].data).get('desp'), '合成内容');
    await pushoo('onebot', { token: 'https://example.invalid/send_private_msg?user_id=501&access_token=synthetic',
      title: '合成标题', content: '合成内容' });
    assert.equal(sent[1].headers.Authorization, 'Bearer synthetic');
    assert.equal(sent[1].timeout, 5000);
    assert.equal(JSON.parse(sent[1].data).user_id, 501);
  } finally { pushAxios.defaults.adapter = original; }
});
