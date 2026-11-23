'use strict';

const http = require('http');
const path = require('path');
const request = require('supertest');
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const Server = require('../../lib/Server');
const WebsocketServer = require('../../lib/servers/WebsocketServer');
const SockJSServer = require('../../lib/servers/SockJSServer');
const testServer = require('../helpers/test-server');
const config = require('../fixtures/proxy-config/webpack.config');
const [port1, port2, port3, port4] = require('../ports-map')['proxy-option'];
const port5 = require('../ports-map')['proxy-option-hmr'];

const WebSocketServer = WebSocket.Server;
const contentBase = path.resolve(__dirname, '../fixtures/proxy-config');

const proxyOptionPathsAsProperties = {
  '/proxy1': {
    target: `http://localhost:${port1}`,
  },
  '/api/proxy2': {
    target: `http://localhost:${port2}`,
    pathRewrite: { '^/api': '' },
  },
  '/foo': {
    bypass(req) {
      if (/\.html$/.test(req.path)) {
        return '/index.html';
      }

      return null;
    },
  },
  '/proxyfalse': {
    bypass(req) {
      if (/\/proxyfalse$/.test(req.path)) {
        return false;
      }
    },
  },
};

const proxyOption = {
  context: () => true,
  target: `http://localhost:${port1}`,
};

const proxyOptionOfArray = [
  { context: '/proxy1', target: proxyOption.target },
  function proxy() {
    return {
      context: '/api/proxy2',
      target: `http://localhost:${port2}`,
      pathRewrite: { '^/api': '' },
    };
  },
];

function startProxyServers() {
  const listeners = [];
  const proxy1 = express();
  const proxy2 = express();

  proxy1.get('/proxy1', (req, res) => {
    res.send('from proxy1');
  });
  proxy1.get('/api', (req, res) => {
    res.send('api response from proxy1');
  });
  proxy2.get('/proxy2', (req, res) => {
    res.send('from proxy2');
  });

  listeners.push(proxy1.listen(port1));
  listeners.push(proxy2.listen(port2));

  // return a function to shutdown proxy servers
  return function proxy() {
    listeners.forEach((listener) => {
      listener.close();
    });
  };
}

describe('proxy option', () => {
  describe('as an object of paths with properties', () => {
    let server;
    let req;
    let closeProxyServers;

    beforeAll((done) => {
      closeProxyServers = startProxyServers();
      server = testServer.start(
        config,
        {
          contentBase,
          proxy: proxyOptionPathsAsProperties,
          port: port3,
        },
        done
      );
      req = request(server.app);
    });

    afterAll((done) => {
      testServer.close(() => {
        closeProxyServers();
        done();
      });
    });

    describe('target', () => {
      it('respects a proxy option when a request path is matched', (done) => {
        req.get('/proxy1').expect(200, 'from proxy1', done);
      });
    });

    describe('pathRewrite', () => {
      it('respects a pathRewrite option', (done) => {
        req.get('/api/proxy2').expect(200, 'from proxy2', done);
      });
    });

    describe('bypass', () => {
      it('can rewrite a request path', (done) => {
        req.get('/foo/bar.html').expect(200, /Hello/, done);
      });

      it('can rewrite a request path regardless of the target defined a bypass option', (done) => {
        req.get('/baz/hoge.html').expect(200, /Hello/, done);
      });

      it('should pass through a proxy when a bypass function returns null', (done) => {
        req.get('/foo.js').expect(200, /Hey/, done);
      });

      it('should not pass through a proxy when a bypass function returns false', (done) => {
        req.get('/proxyfalse').expect(404, done);
      });
    });
  });

  describe('as an option is an object', () => {
    let server;
    let req;
    let closeProxyServers;

    beforeAll((done) => {
      closeProxyServers = startProxyServers();
      server = testServer.start(
        config,
        {
          contentBase,
          proxy: proxyOption,
          port: port3,
        },
        done
      );
      req = request(server.app);
    });

    afterAll((done) => {
      testServer.close(() => {
        closeProxyServers();
        done();
      });
    });

    it('respects a proxy option', (done) => {
      req.get('/proxy1').expect(200, 'from proxy1', done);
    });
  });

  describe('as an array', () => {
    let server;
    let req;
    let closeProxyServers;

    beforeAll((done) => {
      closeProxyServers = startProxyServers();
      server = testServer.start(
        config,
        {
          contentBase,
          proxy: proxyOptionOfArray,
          port: port3,
        },
        done
      );
      req = request(server.app);
    });

    afterAll((done) => {
      testServer.close(() => {
        closeProxyServers();
        done();
      });
    });

    it('respects a proxy option', (done) => {
      req.get('/proxy1').expect(200, 'from proxy1', done);
    });

    it('respects a proxy option of function', (done) => {
      req.get('/api/proxy2').expect(200, 'from proxy2', done);
    });
  });

  describe('should sharing a proxy option', () => {
    let server;
    let req;
    let listener;
    const proxyTarget = {
      target: `http://localhost:${port1}`,
    };

    beforeAll((done) => {
      const proxy = express();

      proxy.get('*', (proxyReq, res) => {
        res.send('from proxy');
      });

      listener = proxy.listen(port1);

      server = testServer.start(
        config,
        {
          contentBase,
          proxy: {
            '/proxy1': proxyTarget,
            '/proxy2': proxyTarget,
          },
          port: port3,
        },
        done
      );
      req = request(server.app);
    });

    afterAll((done) => {
      testServer.close(() => {
        listener.close();
        done();
      });
    });

    it('respects proxy1 option', (done) => {
      req.get('/proxy1').expect(200, 'from proxy', done);
    });

    it('respects proxy2 option', (done) => {
      req.get('/proxy2').expect(200, 'from proxy', done);
    });
  });

  describe('should handles external websocket upgrade', () => {
    let ws;
    let wsServer;
    let responseMessage;

    const transportModes = ['sockjs', 'ws'];
    transportModes.forEach((transportMode) => {
      describe(`with transportMode: ${transportMode}`, () => {
        beforeAll((done) => {
          testServer.start(
            config,
            {
              contentBase,
              transportMode,
              proxy: [
                {
                  context: '/',
                  target: `http://localhost:${port4}`,
                  ws: true,
                },
              ],
              port: port3,
            },
            done
          );

          wsServer = new WebSocketServer({ port: port4 });
          wsServer.on('connection', (server) => {
            server.on('message', (message) => {
              server.send(message);
            });
          });
        });

        beforeEach((done) => {
          ws = new WebSocket(`ws://localhost:${port3}/proxy3/socket`);
          ws.on('message', (message) => {
            responseMessage = message;
            done();
          });
          ws.on('open', () => {
            ws.send('foo');
          });
        });

        it('Should receive response', () => {
          expect(responseMessage).toEqual('foo');
        });

        afterAll((done) => {
          wsServer.close();
          testServer.close(done);
        });
      });
    });
  });

  describe('should not forward the dev server socket upgrade to a user proxy', () => {
    let backend;
    let backendWss;
    let backendSockets;
    let backendUpgradeCount;
    let hpmLogs;

    // Capture the http-proxy-middleware logs (its logger is a singleton
    // writing to the console bound at load time)
    const hpmLogProvider = () => {
      const log = (message) => {
        hpmLogs.push(message);
      };

      return { log, debug: log, info: log, warn: log, error: log };
    };

    const getHpmUpgradeLogs = () =>
      hpmLogs.filter(
        (message) =>
          /\[HPM\]/.test(message) &&
          /Upgrading to WebSocket|Error occurred/.test(message)
      );

    // Start a backend (the user proxy target) and a dev server proxying
    // everything, websockets included, to it
    const setup = (devServerOptions, rejectBackendUpgrades) =>
      new Promise((resolve, reject) => {
        backendUpgradeCount = 0;
        backendSockets = [];
        hpmLogs = [];
        backendWss = null;

        backend = http.createServer((req, res) => {
          res.end('from backend');
        });
        backend.on('connection', (socket) => {
          backendSockets.push(socket);
        });

        if (rejectBackendUpgrades) {
          backend.on('upgrade', (req, socket) => {
            backendUpgradeCount += 1;
            socket.destroy();
          });
        } else {
          backendWss = new WebSocketServer({ server: backend });
          backendWss.on('connection', () => {
            backendUpgradeCount += 1;
          });
        }

        backend.listen(port5, () => {
          testServer.start(
            config,
            Object.assign(
              {
                contentBase,
                disableHostCheck: true,
                hot: true,
                inline: false,
                proxy: [
                  {
                    context: '/',
                    target: `http://localhost:${port5}`,
                    ws: true,
                    logLevel: 'info',
                    logProvider: hpmLogProvider,
                  },
                ],
                port: port3,
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
      });

    const teardown = () =>
      new Promise((resolve) => {
        if (backendWss) {
          backendWss.clients.forEach((client) => {
            client.terminate();
          });
          backendWss.close();
        }

        testServer.close(() => {
          backendSockets.forEach((socket) => {
            socket.destroy();
          });
          backend.close(() => {
            resolve();
          });
        });
      });

    // Send a plain HTTP request through the proxy middleware
    const requestThroughProxy = () =>
      new Promise((resolve, reject) => {
        http
          .get(
            { host: 'localhost', port: port3, path: '/from-backend' },
            (res) => {
              let body = '';

              res.setEncoding('utf8');
              res.on('data', (chunk) => {
                body += chunk;
              });
              res.on('end', () => {
                resolve(body);
              });
            }
          )
          .on('error', reject);
      });

    // Message types sent by the dev server over plain websockets
    // ('{"type":"hot"}') or SockJS frames ('a["{\"type\":\"hot\"}"]')
    const getMessageTypes = (raw) => {
      const data = raw.toString();
      const payloads = data[0] === 'a' ? JSON.parse(data.slice(1)) : [data];

      return payloads.map((payload) => {
        try {
          return JSON.parse(payload).type;
        } catch (e) {
          return null;
        }
      });
    };

    // Open a websocket to `urlPath` on the dev server and report whether the
    // handshake completed (`opened`), which dev server messages arrived and
    // whether the upgrade was forwarded to the backend (`forwarded`)
    const probe = (urlPath) =>
      new Promise((resolve) => {
        const before = backendUpgradeCount;
        const messageTypes = [];
        let opened = false;

        const ws = new WebSocket(`ws://localhost:${port3}${urlPath}`);

        ws.on('open', () => {
          opened = true;
        });
        ws.on('message', (raw) => {
          messageTypes.push.apply(messageTypes, getMessageTypes(raw));
        });
        ws.on('error', () => {
          // a rejected or mangled handshake is reported via `opened`
        });

        // let the dev server and a (wrongly) forwarding proxy finish their
        // work, so the outcome is deterministic
        setTimeout(() => {
          ws.terminate();

          resolve({
            opened,
            messageTypes,
            forwarded: backendUpgradeCount > before,
          });
        }, 800);
      });

    // SockJS serves its websocket transport under
    // `/<prefix>/<server>/<session>/websocket`, `ws` serves the bare socket path
    const transportModes = [
      {
        transportMode: 'sockjs',
        hmrPath: '/sockjs-node/000/abcd1234/websocket',
      },
      { transportMode: 'ws', hmrPath: '/sockjs-node' },
    ];

    transportModes.forEach(({ transportMode, hmrPath }) => {
      describe(`with transportMode: ${transportMode}`, () => {
        beforeAll(() => setup({ transportMode }));

        afterAll(teardown);

        it('serves the HMR upgrade locally and does not forward it to the proxy', () =>
          probe(hmrPath).then(({ opened, messageTypes, forwarded }) => {
            expect(opened).toBe(true);
            expect(messageTypes).toContain('hot');
            expect(forwarded).toBe(false);
            expect(getHpmUpgradeLogs()).toEqual([]);
          }));

        it('forwards a non-HMR upgrade to the user proxy', () =>
          probe('/not-hmr').then(({ forwarded }) => {
            expect(forwarded).toBe(true);
          }));
      });

      // http-proxy-middleware subscribes itself to the server `upgrade` event
      // on the first request it sees when `ws: true` reaches it
      describe(`with transportMode: ${transportMode}, after an HTTP request went through the proxy`, () => {
        beforeAll(() =>
          setup({ transportMode })
            .then(requestThroughProxy)
            .then((body) => {
              expect(body).toBe('from backend');
            })
        );

        afterAll(teardown);

        it('serves the HMR upgrade locally and does not forward it to the proxy', () =>
          probe(hmrPath).then(({ opened, messageTypes, forwarded }) => {
            expect(opened).toBe(true);
            expect(messageTypes).toContain('hot');
            expect(forwarded).toBe(false);
            expect(getHpmUpgradeLogs()).toEqual([]);
          }));

        it('forwards a non-HMR upgrade to the user proxy', () =>
          probe('/not-hmr').then(({ forwarded }) => {
            expect(forwarded).toBe(true);
          }));
      });
    });

    // Same comparison as `ws` does in `WebSocketServer#shouldHandle`: only the
    // socket path (query string stripped) is the HMR socket
    describe('with transportMode: ws, path matching is exact', () => {
      beforeAll(() => setup({ transportMode: 'ws' }));

      afterAll(teardown);

      it.each([
        ['exact path', '/sockjs-node'],
        ['path with query string', '/sockjs-node?token=1'],
      ])('treats %s (%s) as the HMR upgrade path', (label, urlPath) =>
        probe(urlPath).then(({ opened, forwarded }) => {
          expect(opened).toBe(true);
          expect(forwarded).toBe(false);
        })
      );

      it.each([
        ['leading double slash', '//sockjs-node'],
        ['trailing slash', '/sockjs-node/'],
        ['uppercase', '/SOCKJS-NODE'],
        ['percent-encoded path', '/%73ockjs-node'],
      ])('forwards %s (%s) to the user proxy', (label, urlPath) =>
        probe(urlPath).then(({ forwarded }) => {
          expect(forwarded).toBe(true);
        })
      );
    });

    // The HMR path is read from the `sockPath` option, not hardcoded
    describe('with transportMode: ws and a custom sockPath', () => {
      beforeAll(() =>
        setup({ transportMode: 'ws', sockPath: '/custom-hmr' })
      );

      afterAll(teardown);

      it('treats the configured path (/custom-hmr) as the HMR upgrade path', () =>
        probe('/custom-hmr').then(({ opened, messageTypes, forwarded }) => {
          expect(opened).toBe(true);
          expect(messageTypes).toContain('hot');
          expect(forwarded).toBe(false);
        }));

      it('forwards the default path (/sockjs-node) once it is no longer the HMR path', () =>
        probe('/sockjs-node').then(({ forwarded }) => {
          expect(forwarded).toBe(true);
        }));
    });

    describe('with a backend rejecting websocket upgrades', () => {
      beforeAll(() => setup({ transportMode: 'ws' }, true));

      afterAll(teardown);

      it('does not log any proxy error when the HMR client connects', () =>
        probe('/sockjs-node').then(({ opened, messageTypes, forwarded }) => {
          expect(opened).toBe(true);
          expect(messageTypes).toContain('hot');
          expect(forwarded).toBe(false);
          expect(getHpmUpgradeLogs()).toEqual([]);
        }));
    });

    describe('isSocketServerUpgrade', () => {
      const isSocketServerUpgrade = (socketServer, url) =>
        Server.prototype.isSocketServerUpgrade.call(
          { sockPath: '/sockjs-node', socketServer },
          { url }
        );

      it('matches the socket path exactly for the `ws` socket server', () => {
        const socketServer = Object.create(WebsocketServer.prototype);

        expect(isSocketServerUpgrade(socketServer, '/sockjs-node')).toBe(true);
        expect(isSocketServerUpgrade(socketServer, '/sockjs-node?t=1')).toBe(
          true
        );
        expect(isSocketServerUpgrade(socketServer, '/sockjs-node/')).toBe(
          false
        );
        expect(isSocketServerUpgrade(socketServer, '//sockjs-node')).toBe(
          false
        );
        expect(isSocketServerUpgrade(socketServer, '/SOCKJS-NODE')).toBe(
          false
        );
        expect(isSocketServerUpgrade(socketServer, '/not-hmr')).toBe(false);
        expect(isSocketServerUpgrade(socketServer, undefined)).toBe(false);
      });

      it('claims every url under the socket path for other socket servers', () => {
        [Object.create(SockJSServer.prototype), {}, undefined].forEach(
          (socketServer) => {
            expect(isSocketServerUpgrade(socketServer, '/sockjs-node')).toBe(
              true
            );
            expect(
              isSocketServerUpgrade(socketServer, '/sockjs-node/websocket')
            ).toBe(true);
            expect(
              isSocketServerUpgrade(
                socketServer,
                '/sockjs-node/000/abcd1234/websocket?t=1'
              )
            ).toBe(true);
            expect(
              isSocketServerUpgrade(socketServer, '/sockjs-nodefoo/websocket')
            ).toBe(false);
            expect(isSocketServerUpgrade(socketServer, '/not-hmr')).toBe(
              false
            );
            expect(isSocketServerUpgrade(socketServer, undefined)).toBe(false);
          }
        );
      });
    });
  });

  describe('should supports http methods', () => {
    let server;
    let req;
    let listener;
    const proxyTarget = {
      target: `http://localhost:${port1}`,
    };

    beforeAll((done) => {
      const proxy = express();

      // Parse application/x-www-form-urlencoded
      proxy.use(bodyParser.urlencoded({ extended: false }));

      // Parse application/json
      proxy.use(bodyParser.json());

      // This forces Express to try to decode URLs, which is needed for the test
      // associated with the middleware below.
      proxy.all('*', (_req, res, next) => {
        next();
      });
      // We must define all 4 params in order for this to be detected as an
      // error handling middleware.
      // eslint-disable-next-line no-unused-vars
      proxy.use((error, proxyReq, res, next) => {
        res.status(500);
        res.send('error from proxy');
      });

      proxy.get('/get', (proxyReq, res) => {
        res.send('GET method from proxy');
      });

      proxy.head('/head', (proxyReq, res) => {
        res.send('HEAD method from proxy');
      });

      proxy.post('/post-x-www-form-urlencoded', (proxyReq, res) => {
        const id = proxyReq.body.id;

        res.status(200).send(`POST method from proxy (id: ${id})`);
      });

      proxy.post('/post-application-json', (proxyReq, res) => {
        const id = proxyReq.body.id;

        res.status(200).send({ answer: `POST method from proxy (id: ${id})` });
      });

      proxy.delete('/delete', (proxyReq, res) => {
        res.send('DELETE method from proxy');
      });

      listener = proxy.listen(port1);

      server = testServer.start(
        config,
        {
          contentBase,
          proxy: {
            '**': proxyTarget,
          },
        },
        done
      );
      req = request(server.app);
    });

    afterAll((done) => {
      testServer.close(() => {
        listener.close();
        done();
      });
    });

    it('errors', (done) => {
      req.get('/%').expect(500, 'error from proxy', done);
    });

    it('GET method', (done) => {
      req.get('/get').expect(200, 'GET method from proxy', done);
    });

    it('HEAD method', (done) => {
      req.head('/head').expect(200, done);
    });

    it('POST method (application/x-www-form-urlencoded)', (done) => {
      req
        .post('/post-x-www-form-urlencoded')
        .send('id=1')
        .expect(200, 'POST method from proxy (id: 1)', done);
    });

    it('POST method (application/json)', (done) => {
      req
        .post('/post-application-json')
        .send({ id: '1' })
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(
          200,
          JSON.stringify({ answer: 'POST method from proxy (id: 1)' }),
          done
        );
    });

    it('DELETE method', (done) => {
      req.delete('/delete').expect(200, 'DELETE method from proxy', done);
    });
  });
});
