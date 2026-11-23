'use strict';

const http = require('http');
const WebSocket = require('ws');
const testServer = require('../helpers/test-server');
const config = require('../fixtures/simple-config/webpack.config');
const [devServerPort, backendPort] = require('../ports-map')[
  'proxy-web-socket-origin'
];

const WebSocketServer = WebSocket.Server;

const sameOrigin = `http://localhost:${devServerPort}`;
const crossOrigin = 'http://evil.example.com';

const delay = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// @see https://github.com/webpack/webpack-dev-server/security/advisories/GHSA-cfqc-fj3v-j925
describe('proxied websocket upgrade origin validation', () => {
  let backend;
  let backendWss;
  let backendSockets;
  let backendConnections;
  let backendUpgradeUrls;

  // A stand-in for a service the developer proxies over websockets
  const startBackend = () =>
    new Promise((resolve) => {
      backendConnections = 0;
      backendUpgradeUrls = [];
      backendSockets = [];

      backend = http.createServer((req, res) => {
        res.end('backend response');
      });
      backend.on('connection', (socket) => {
        backendSockets.push(socket);
      });

      backendWss = new WebSocketServer({ server: backend });
      backendWss.on('connection', (client, req) => {
        backendConnections += 1;
        backendUpgradeUrls.push(req.url);
        client.send('INTERNAL-SERVICE-SECRET');
      });

      backend.listen(backendPort, '127.0.0.1', resolve);
    });

  const setup = (devServerOptions) =>
    startBackend().then(
      () =>
        new Promise((resolve, reject) => {
          testServer.close(() => {
            testServer.start(
              config,
              Object.assign(
                {
                  port: devServerPort,
                  transportMode: 'ws',
                  proxy: [
                    {
                      context: '/api',
                      target: `http://127.0.0.1:${backendPort}`,
                      ws: true,
                      logLevel: 'warn',
                    },
                    {
                      context: '/other',
                      target: `http://127.0.0.1:${backendPort}`,
                      ws: true,
                      logLevel: 'warn',
                    },
                  ],
                },
                devServerOptions
              ),
              (err) => {
                if (err) {
                  reject(err);
                  return;
                }

                resolve();
              }
            );
          });
        })
    );

  const teardown = () =>
    new Promise((resolve) => {
      testServer.close(() => {
        backendWss.clients.forEach((client) => {
          client.terminate();
        });
        backendWss.close();
        backendSockets.forEach((socket) => {
          socket.destroy();
        });
        backend.close(() => {
          resolve();
        });
      });
    });

  // Send a plain HTTP request through the proxy middleware of the dev server
  const requestThroughProxy = () =>
    new Promise((resolve, reject) => {
      http
        .get(
          { host: 'localhost', port: devServerPort, path: '/api/hello' },
          (res) => {
            let body = '';

            res.setEncoding('utf8');
            res.on('data', (chunk) => {
              body += chunk;
            });
            res.on('end', () => {
              resolve({ status: res.statusCode, body });
            });
          }
        )
        .on('error', reject);
    });

  // Send a websocket upgrade request (as a browser page from `origin` would)
  // and report whether the dev server switched protocols
  const upgrade = (origin, extraHeaders) =>
    new Promise((resolve) => {
      let settled = false;

      const finish = (result) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      const req = http.request({
        host: 'localhost',
        port: devServerPort,
        path: '/api/socket',
        headers: Object.assign(
          {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version': '13',
          },
          typeof origin === 'string' ? { Origin: origin } : {},
          extraHeaders
        ),
      });

      req.setTimeout(8000, () => {
        req.abort();
        finish({ upgraded: false });
      });
      req.on('upgrade', (res, socket) => {
        socket.destroy();
        finish({ upgraded: true, status: res.statusCode });
      });
      req.on('response', (res) => {
        res.resume();
        finish({ upgraded: false, status: res.statusCode });
      });
      req.on('error', () => {
        finish({ upgraded: false });
      });
      req.end();
    });

  // A (wrongly) forwarding listener can still contact the backend after the
  // client receives the rejection, so let that forwarding finish first
  const expectRejected = (result) => {
    expect(result.upgraded).toBe(false);
    expect(result.status).toBe(403);

    return delay(100).then(() => {
      expect(backendConnections).toBe(0);
    });
  };

  const expectForwarded = (result) => {
    expect(result.upgraded).toBe(true);
    expect(result.status).toBe(101);
    expect(backendConnections).toBe(1);
  };

  const resetBackendConnections = () => {
    backendConnections = 0;
    backendUpgradeUrls = [];
  };

  describe('with the default options', () => {
    beforeAll(() => setup({}));

    afterAll(teardown);

    beforeEach(resetBackendConnections);

    it('should reject a cross-origin proxied websocket upgrade', () =>
      upgrade(crossOrigin).then(expectRejected));

    it('should allow a same-origin proxied websocket upgrade', () =>
      upgrade(sameOrigin).then(expectForwarded));

    it('should reject an upgrade with an invalid Host header', () =>
      upgrade(sameOrigin, { Host: 'evil.example.com' }).then(expectRejected));

    it('should reject an upgrade without an Origin header', () =>
      upgrade().then(expectRejected));

    it('should reject an upgrade from an IP address Origin that is not the Host', () =>
      upgrade('http://192.168.0.66').then(expectRejected));

    it('should allow a same-origin upgrade addressed by IP', () =>
      upgrade(`http://127.0.0.1:${devServerPort}`, {
        Host: `127.0.0.1:${devServerPort}`,
      }).then(expectForwarded));
  });

  // http-proxy-middleware subscribes itself to the server `upgrade` event on
  // the first request it sees when `ws: true` reaches it
  describe('after an HTTP request went through the proxy', () => {
    beforeAll(() =>
      setup({})
        .then(requestThroughProxy)
        .then((res) => {
          expect(res.status).toBe(200);
          expect(res.body).toBe('backend response');
        })
    );

    afterAll(teardown);

    beforeEach(resetBackendConnections);

    it('should not forward a rejected upgrade', () =>
      upgrade(crossOrigin).then(expectRejected));

    it('should allow a same-origin upgrade', () =>
      upgrade(sameOrigin).then(expectForwarded));
  });

  describe('with a proxy callback', () => {
    let proxyConfig;

    beforeAll(() => {
      proxyConfig = {
        context: ['/api'],
        target: `http://127.0.0.1:${backendPort}`,
        ws: false,
        pathRewrite: { '^/api': '/initial' },
        logLevel: 'warn',
      };

      return setup({
        proxy: [() => Object.assign({}, proxyConfig)],
      });
    });

    afterAll(teardown);

    it('should validate upgrades using the current proxy callback configuration', () =>
      requestThroughProxy()
        .then((res) => {
          expect(res.status).toBe(200);

          proxyConfig = Object.assign({}, proxyConfig, {
            ws: true,
            pathRewrite: { '^/api': '/updated' },
          });

          return requestThroughProxy();
        })
        .then((res) => {
          expect(res.status).toBe(200);

          resetBackendConnections();

          return upgrade(crossOrigin);
        })
        .then(expectRejected)
        .then(() => upgrade(sameOrigin))
        .then((result) => {
          expectForwarded(result);
          expect(backendUpgradeUrls).toEqual(['/updated/socket']);
        }));
  });

  describe('with the "allowedHosts" option', () => {
    beforeAll(() => setup({ allowedHosts: ['.example.test'] }));

    afterAll(teardown);

    beforeEach(resetBackendConnections);

    it('should allow an upgrade whose Host and Origin are allowed', () =>
      upgrade('http://dev.example.test', { Host: 'dev.example.test' }).then(
        expectForwarded
      ));

    it('should allow an upgrade from an allowed Origin through a reverse proxy', () =>
      upgrade('http://dev.example.test').then(expectForwarded));

    it('should still reject a cross-origin upgrade', () =>
      upgrade(crossOrigin).then(expectRejected));
  });

  describe('with the "disableHostCheck" option', () => {
    beforeAll(() => setup({ disableHostCheck: true }));

    afterAll(teardown);

    beforeEach(resetBackendConnections);

    it('should forward a cross-origin upgrade when the check is opted out of', () =>
      upgrade(crossOrigin).then(expectForwarded));
  });
});
