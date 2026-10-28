const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createMitmProxyManager } = require('../src/capture/mitm-proxy');

for (const { method, body } of [{ method: 'GET', body: '' }, { method: 'POST', body: 'proxy-check-body' }]) {
  test(`capture proxy forwards ${method} using a valid HTTP request line`, async (t) => {
    const upstream = http.createServer((req, res) => {
      let received = '';
      req.on('data', chunk => { received += chunk; });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ method: req.method, url: req.url, body: received }));
      });
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => upstream.close(resolve)));
    const targetPort = upstream.address().port;
    const manager = createMitmProxyManager({
      config: { proxyBind: ['127.0.0.1'], proxyPortFrom: 0, proxyPortTo: 0, autoStopSec: 60, captureHosts: [] },
      sessionStore: { addCode() { throw new Error('Unexpected game authorization'); } },
    });
    const session = { id: `http-proxy-test-${method}` };
    const proxy = await manager.startForSession(session);
    t.after(() => manager.stopForSession(session));
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: proxy.port, method,
        path: `http://127.0.0.1:${targetPort}/health?check=proxy`,
        headers: { Host: `127.0.0.1:${targetPort}`, 'Content-Length': Buffer.byteLength(body), Connection: 'close' },
        agent: false,
      }, res => {
        let responseBody = '';
        res.on('data', chunk => { responseBody += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: responseBody }));
      });
      req.on('error', reject);
      req.setTimeout(3000, () => req.destroy(new Error('Proxy request timed out')));
      req.end(body);
    });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), { method, url: '/health?check=proxy', body });
  });
}
