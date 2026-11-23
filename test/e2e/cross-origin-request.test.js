'use strict';

const http = require('http');
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
