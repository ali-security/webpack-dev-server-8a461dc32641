'use strict';

const http = require('http');
const net = require('net');
const url = require('url');
const WebSocket = require('ws');
const testServer = require('../helpers/test-server');
const config = require('../fixtures/client-config/webpack.config');
const runBrowser = require('../helpers/run-browser');
const [port1, port2] = require('../ports-map')['cross-origin-request'];

describe('cross-origin requests', () => {
  const devServerPort = port1;
  const htmlServerPort = port2;
  const htmlServerHost = '127.0.0.1';

  // Serves a page from another site (127.0.0.1) that includes the dev server
  // bundle (localhost) using a script tag, and resolves with the status code
  // of the response the browser got for that script.
  function loadScriptFromAnotherSite(scriptAttributes) {
    let htmlServer;
    let browser;

    const cleanup = () =>
      Promise.resolve(browser ? browser.close() : null).then(
        () =>
          new Promise((resolve) => {
            if (!htmlServer) {
              resolve();
              return;
            }

            htmlServer.close(() => {
              resolve();
            });
          })
      );

    return new Promise((resolve, reject) => {
      htmlServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <head>
              <script src="http://localhost:${devServerPort}/main.js"${scriptAttributes}></script>
            </head>
            <body></body>
          </html>
        `);
      });
      htmlServer.on('error', reject);
      htmlServer.listen(htmlServerPort, htmlServerHost, resolve);
    })
      .then(() => runBrowser())
      .then((launched) => {
        browser = launched.browser;

        const { page } = launched;
        const scriptTagRequest = page.waitForResponse(
          `http://localhost:${devServerPort}/main.js`
        );

        return page
          .goto(`http://${htmlServerHost}:${htmlServerPort}/`)
          .then(() => scriptTagRequest);
      })
      .then((response) => response.status())
      .then(
        (status) => cleanup().then(() => status),
        (error) =>
          cleanup().then(() => {
            throw error;
          })
      );
  }

  describe('with the default options', () => {
    beforeAll((done) => {
      testServer.startAwaitingCompilation(
        config,
        {
          port: devServerPort,
          host: '0.0.0.0',
        },
        done
      );
    });

    afterAll(testServer.close);

    it('should return 403 for cross-origin no-cors non-module script tag requests', () =>
      loadScriptFromAnotherSite('').then((status) => {
        expect(status).toBe(403);
      }));
  });

  describe('with the "headers" option allowing cross-origin requests', () => {
    beforeAll((done) => {
      testServer.startAwaitingCompilation(
        config,
        {
          port: devServerPort,
          host: '0.0.0.0',
          headers: {
            'Access-Control-Allow-Origin': '*',
          },
        },
        done
      );
    });

    afterAll(testServer.close);

    it('should return 200 for cross-origin cors non-module script tag requests', () =>
      loadScriptFromAnotherSite(' crossorigin').then((status) => {
        expect(status).toBe(200);
      }));
  });

  describe('with the "disableHostCheck" option', () => {
    beforeAll((done) => {
      testServer.startAwaitingCompilation(
        config,
        {
          port: devServerPort,
          host: '0.0.0.0',
          disableHostCheck: true,
        },
        done
      );
    });

    afterAll(testServer.close);

    it('should return 200 for cross-origin no-cors non-module script tag requests', () =>
      loadScriptFromAnotherSite('').then((status) => {
        expect(status).toBe(200);
      }));
  });

  describe('with the "allowedHosts" option and the "localhost" value', () => {
    beforeAll((done) => {
      testServer.startAwaitingCompilation(
        config,
        {
          port: devServerPort,
          host: '0.0.0.0',
          allowedHosts: ['localhost'],
        },
        done
      );
    });

    afterAll(testServer.close);

    it('should return 200 for cross-origin no-cors non-module script tag requests', () =>
      loadScriptFromAnotherSite('').then((status) => {
        expect(status).toBe(200);
      }));
  });
});

// @see https://github.com/webpack/webpack-dev-server/security/advisories/GHSA-79cf-xcqc-c78w
describe('cross-origin resource policy header', () => {
  const devServerPort = port1;

  function startServer(options, done) {
    testServer.startAwaitingCompilation(
      config,
      Object.assign({ port: devServerPort, host: '0.0.0.0' }, options),
      done
    );
  }

  // Sends a request without any Sec-Fetch-* headers, which is what browsers
  // send for a `<script src>` tag when the page is served over plain HTTP.
  function request(path, headers) {
    return new Promise((resolve, reject) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port: devServerPort,
          path,
          headers: Object.assign(
            { host: `localhost:${devServerPort}` },
            headers
          ),
        },
        (res) => {
          let body = '';

          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            resolve({ status: res.statusCode, headers: res.headers, body });
          });
        }
      );

      req.on('error', reject);
    });
  }

  describe('with the default options', () => {
    beforeAll((done) => {
      startServer({}, done);
    });

    afterAll(testServer.close);

    it('should set Cross-Origin-Resource-Policy: same-origin by default', () =>
      request('/main.js').then((res) => {
        expect(res.status).toBe(200);
        expect(res.headers['cross-origin-resource-policy']).toBe(
          'same-origin'
        );
      }));

    it('should set CORP header for a cross-origin script tag request over plain HTTP (no Sec-Fetch-* headers)', () =>
      request('/main.js', {
        // the dev server reached through a LAN IP from a page on another site
        host: `192.168.1.10:${devServerPort}`,
        referer: 'http://attacker.example.com/',
        accept: '*/*',
      }).then((res) => {
        expect(res.status).toBe(200);
        expect(res.headers['cross-origin-resource-policy']).toBe(
          'same-origin'
        );
      }));

    it('should set CORP header for the client bundles', () =>
      request('/__webpack_dev_server__/live.bundle.js', {
        referer: 'http://attacker.example.com/',
      }).then((res) => {
        expect(res.status).toBe(200);
        expect(res.headers['cross-origin-resource-policy']).toBe(
          'same-origin'
        );
      }));
  });

  describe('with the "disableHostCheck" option', () => {
    beforeAll((done) => {
      startServer({ disableHostCheck: true }, done);
    });

    afterAll(testServer.close);

    it('should NOT set CORP header when the host check is disabled', () =>
      request('/main.js').then((res) => {
        expect(res.status).toBe(200);
        expect(res.headers['cross-origin-resource-policy']).toBeUndefined();
      }));
  });

  describe('with the "headers" option and a wildcard Access-Control-Allow-Origin', () => {
    beforeAll((done) => {
      startServer(
        {
          headers: { 'Access-Control-Allow-Origin': '*' },
        },
        done
      );
    });

    afterAll(testServer.close);

    it('should NOT set CORP header when user configures wildcard CORS', () =>
      request('/main.js').then((res) => {
        expect(res.status).toBe(200);
        expect(res.headers['access-control-allow-origin']).toBe('*');
        expect(res.headers['cross-origin-resource-policy']).toBeUndefined();
      }));
  });

  describe('with the "headers" option and a specific-origin Access-Control-Allow-Origin', () => {
    beforeAll((done) => {
      startServer(
        {
          headers: {
            'Access-Control-Allow-Origin': 'http://foo.example.com',
          },
        },
        done
      );
    });

    afterAll(testServer.close);

    it('should set CORP header when user configures a specific-origin Access-Control-Allow-Origin (no-cors embedding is not governed by CORS)', () =>
      request('/main.js').then((res) => {
        expect(res.status).toBe(200);
        expect(res.headers['cross-origin-resource-policy']).toBe(
          'same-origin'
        );
      }));
  });

  describe('with the "headers" option and a specific-origin Access-Control-Allow-Origin array value', () => {
    beforeAll((done) => {
      startServer(
        {
          headers: {
            'Access-Control-Allow-Origin': ['http://foo.example.com'],
          },
        },
        done
      );
    });

    afterAll(testServer.close);

    it('should set CORP header when user configures Access-Control-Allow-Origin via an array value with a specific origin', () =>
      request('/main.js').then((res) => {
        expect(res.status).toBe(200);
        expect(res.headers['cross-origin-resource-policy']).toBe(
          'same-origin'
        );
      }));
  });

  describe('with the "headers" option and a wildcard Access-Control-Allow-Origin array value', () => {
    beforeAll((done) => {
      startServer(
        {
          headers: { 'access-control-allow-origin': ['*'] },
        },
        done
      );
    });

    afterAll(testServer.close);

    it('should NOT set CORP header when user configures wildcard Access-Control-Allow-Origin via an array value', () =>
      request('/main.js').then((res) => {
        expect(res.status).toBe(200);
        expect(res.headers['cross-origin-resource-policy']).toBeUndefined();
      }));
  });

  describe('with the "allowedHosts" option', () => {
    beforeAll((done) => {
      startServer({ allowedHosts: ['localhost'] }, done);
    });

    afterAll(testServer.close);

    it('should NOT set CORP header when host is in allowedHosts', () =>
      request('/main.js').then((res) => {
        expect(res.status).toBe(200);
        expect(res.headers['cross-origin-resource-policy']).toBeUndefined();
      }));
  });
});

// CVE-2026-14620
describe('cross-site request forgery on state-changing endpoints', () => {
  const devServerPort = port1;
  const endpoint = '/webpack-dev-server/invalidate';

  function startServer(options, done) {
    return testServer.startAwaitingCompilation(
      config,
      Object.assign({ port: devServerPort, host: '0.0.0.0' }, options),
      done
    );
  }

  function request(path, headers) {
    return new Promise((resolve, reject) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port: devServerPort,
          path,
          headers: Object.assign(
            { host: `localhost:${devServerPort}` },
            headers
          ),
        },
        (res) => {
          let body = '';

          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            resolve({ status: res.statusCode, body });
          });
        }
      );

      req.on('error', reject);
    });
  }

  describe('with the default options', () => {
    let server;
    let invalidateSpy;

    beforeAll((done) => {
      server = startServer({}, done);
    });

    afterAll(testServer.close);

    beforeEach(() => {
      invalidateSpy = jest
        .spyOn(server, 'invalidate')
        .mockImplementation(() => {});
    });

    afterEach(() => {
      invalidateSpy.mockRestore();
    });

    it(`should block cross-site requests to ${endpoint}`, () =>
      request(endpoint, {
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'cross-site',
      }).then((res) => {
        expect(res.status).toBe(403);
        expect(res.body).toBe('Cross-Origin request blocked');
        expect(invalidateSpy).not.toHaveBeenCalled();
      }));

    it(`should allow same-origin requests to ${endpoint}`, () =>
      request(endpoint, {
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
      }).then((res) => {
        expect(res.status).toBe(200);
        expect(invalidateSpy).toHaveBeenCalledTimes(1);
      }));

    it(`should allow user-initiated navigations to ${endpoint}`, () =>
      request(endpoint, { 'sec-fetch-site': 'none' }).then((res) => {
        expect(res.status).toBe(200);
        expect(invalidateSpy).toHaveBeenCalledTimes(1);
      }));

    it('should block requests with a cross-origin Origin and no Sec-Fetch metadata', () =>
      request(endpoint, { origin: 'http://evil.example' }).then((res) => {
        expect(res.status).toBe(403);
        expect(res.body).toBe('Cross-Origin request blocked');
        expect(invalidateSpy).not.toHaveBeenCalled();
      }));

    it('should allow requests with a same-origin Origin and no Sec-Fetch metadata', () =>
      request(endpoint, { origin: `http://localhost:${devServerPort}` }).then(
        (res) => {
          expect(res.status).toBe(200);
          expect(invalidateSpy).toHaveBeenCalledTimes(1);
        }
      ));

    it('should allow requests without Sec-Fetch metadata or Origin (e.g. curl)', () =>
      request(endpoint).then((res) => {
        expect(res.status).toBe(200);
        expect(invalidateSpy).toHaveBeenCalledTimes(1);
      }));
  });

  describe('with the "allowedHosts" option', () => {
    let server;
    let invalidateSpy;

    beforeAll((done) => {
      server = startServer({ allowedHosts: ['localhost'] }, done);
    });

    afterAll(testServer.close);

    beforeEach(() => {
      invalidateSpy = jest
        .spyOn(server, 'invalidate')
        .mockImplementation(() => {});
    });

    afterEach(() => {
      invalidateSpy.mockRestore();
    });

    it(`should block cross-site no-cors requests to ${endpoint}`, () =>
      request(endpoint, {
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-site': 'cross-site',
      }).then((res) => {
        expect(res.status).toBe(403);
        expect(res.body).toBe('Cross-Origin request blocked');
        expect(invalidateSpy).not.toHaveBeenCalled();
      }));

    it(`should allow same-origin requests to ${endpoint}`, () =>
      request(endpoint, {
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
      }).then((res) => {
        expect(res.status).toBe(200);
        expect(invalidateSpy).toHaveBeenCalledTimes(1);
      }));
  });
});

// CVE-2026-14631
describe('malformed Host/Origin headers', () => {
  const devServerPort = port1;
  // an invalid IPv6 literal: `url.parse()` throws `ERR_INVALID_URL` for it on
  // Node >= 18, which used to take down the whole dev-server process (older
  // runtimes return a mangled hostname instead)
  const malformedHost = '[::1';
  const malformedOrigin = 'http://[::1/';
  // a host-less URL: `url.parse()` returns a `null` hostname for it, which used
  // to crash the wildcard check of the "allowedHosts" option
  const hostlessUrl = 'javascript://evil.example.com';
  const options = {
    port: devServerPort,
    host: '0.0.0.0',
    allowedHosts: ['.example.com'],
  };

  let parseSpy;

  afterEach(() => {
    if (parseSpy) {
      parseSpy.mockRestore();
      parseSpy = null;
    }
  });

  // makes `url.parse()` throw for the malformed values, like Node >= 18 does
  function throwOnMalformedUrls() {
    const parse = url.parse;

    parseSpy = jest.spyOn(url, 'parse').mockImplementation((...args) => {
      const input = args[0];

      if (input === `//${malformedHost}` || input === malformedOrigin) {
        const error = new TypeError(`Invalid URL: ${input}`);

        error.code = 'ERR_INVALID_URL';

        throw error;
      }

      return parse.apply(url, args);
    });
  }

  function request(path, headers) {
    return new Promise((resolve, reject) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port: devServerPort,
          path,
          headers: Object.assign(
            { host: `localhost:${devServerPort}` },
            headers
          ),
        },
        (res) => {
          let body = '';

          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            resolve({ status: res.statusCode, body });
          });
        }
      );

      req.on('error', reject);
    });
  }

  // The server must still be alive: a normal request still succeeds.
  function expectServerAlive() {
    return request('/main.js').then((res) => {
      expect(res.status).toBe(200);
    });
  }

  // Sent over a raw socket so the malformed `Host` reaches the server as-is,
  // resolves with the raw response.
  function rawRequest(path, hostHeader) {
    return new Promise((resolve) => {
      let response = '';

      const socket = net.connect(devServerPort, '127.0.0.1', () => {
        socket.write(
          [
            `GET ${path} HTTP/1.1`,
            `Host: ${hostHeader}`,
            'Connection: close',
            '',
            '',
          ].join('\r\n')
        );
      });

      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        response += chunk;
      });
      socket.on('error', () => {});
      socket.on('close', () => {
        resolve(response);
      });
    });
  }

  // Connects a raw web socket client to the dev server socket server with the
  // given headers, and resolves with every message received until it closes.
  function connectSocket(path, headers) {
    return new Promise((resolve) => {
      const messages = [];
      const client = new WebSocket(`ws://localhost:${devServerPort}${path}`, {
        headers,
      });
      const timer = setTimeout(() => {
        client.terminate();
      }, 5000);

      client.on('message', (data) => {
        try {
          messages.push(JSON.parse(data));
        } catch (error) {
          messages.push(data);
        }
      });

      client.on('error', () => {});

      client.on('close', () => {
        clearTimeout(timer);
        resolve(messages);
      });
    });
  }

  const socketModes = [
    {
      title: 'sockjs',
      transportMode: 'sockjs',
      sockPath: '/sockjs-node/websocket',
    },
    {
      title: 'ws',
      transportMode: 'ws',
      sockPath: '/sockjs-node',
    },
  ];

  socketModes.forEach((mode) => {
    describe(`using the "${mode.title}" transport mode`, () => {
      let server;

      beforeAll((done) => {
        server = testServer.startAwaitingCompilation(
          config,
          Object.assign({ transportMode: mode.transportMode }, options),
          done
        );
      });

      afterAll(testServer.close);

      function expectRejected(messages) {
        expect(messages).toEqual([
          { type: 'error', data: 'Invalid Host/Origin header' },
        ]);
        expect(server.sockets.length).toBe(0);
      }

      it('should reject a WebSocket upgrade with a malformed Origin header without crashing', () =>
        connectSocket(mode.sockPath, {
          host: `localhost:${devServerPort}`,
          origin: malformedOrigin,
        })
          .then(expectRejected)
          .then(expectServerAlive));

      it('should reject a WebSocket upgrade with a malformed Origin header the url parser throws on without crashing', () => {
        throwOnMalformedUrls();

        return connectSocket(mode.sockPath, {
          host: `localhost:${devServerPort}`,
          origin: malformedOrigin,
        })
          .then(expectRejected)
          .then(expectServerAlive);
      });

      it('should reject a WebSocket upgrade with a malformed Host header the url parser throws on without crashing', () => {
        throwOnMalformedUrls();

        return connectSocket(mode.sockPath, {
          host: malformedHost,
          origin: `http://localhost:${devServerPort}`,
        })
          .then(expectRejected)
          .then(expectServerAlive);
      });

      it('should reject a WebSocket upgrade with a host-less Origin header without crashing', () =>
        connectSocket(mode.sockPath, {
          host: `localhost:${devServerPort}`,
          origin: hostlessUrl,
        })
          .then(expectRejected)
          .then(expectServerAlive));

      it('should reject a WebSocket upgrade with a host-less Host header without crashing', () =>
        connectSocket(mode.sockPath, {
          host: hostlessUrl,
          origin: `http://localhost:${devServerPort}`,
        })
          .then(expectRejected)
          .then(expectServerAlive));
    });
  });

  describe('on plain HTTP requests', () => {
    let server;

    beforeAll((done) => {
      server = testServer.startAwaitingCompilation(config, options, done);
    });

    afterAll(testServer.close);

    it('should handle a request with a malformed Host header without crashing', () =>
      rawRequest('/main.js', malformedHost)
        .then((response) => {
          expect(response).toMatch(/^HTTP\/1\.1 \d{3} /);
          expect(response).not.toMatch(/^HTTP\/1\.1 500 /);
        })
        .then(expectServerAlive));

    it('should reject a request with a malformed Host header the url parser throws on', () => {
      throwOnMalformedUrls();

      return rawRequest('/main.js', malformedHost)
        .then((response) => {
          expect(response).toMatch(/^HTTP\/1\.1 200 /);
          expect(response).toMatch(/\r\n\r\nInvalid Host header$/);
        })
        .then(expectServerAlive);
    });

    it('should reject a request with a host-less Host header', () =>
      rawRequest('/main.js', hostlessUrl)
        .then((response) => {
          expect(response).toMatch(/^HTTP\/1\.1 200 /);
          expect(response).toMatch(/\r\n\r\nInvalid Host header$/);
        })
        .then(expectServerAlive));

    describe('to /webpack-dev-server/invalidate', () => {
      let invalidateSpy;

      beforeEach(() => {
        invalidateSpy = jest
          .spyOn(server, 'invalidate')
          .mockImplementation(() => {});
      });

      afterEach(() => {
        invalidateSpy.mockRestore();
      });

      it('should block a request with a malformed Origin header the url parser throws on', () => {
        throwOnMalformedUrls();

        return request('/webpack-dev-server/invalidate', {
          origin: malformedOrigin,
        })
          .then((res) => {
            expect(res.status).toBe(403);
            expect(res.body).toBe('Cross-Origin request blocked');
            expect(invalidateSpy).not.toHaveBeenCalled();
          })
          .then(expectServerAlive);
      });
    });
  });
});
