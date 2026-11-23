'use strict';

const request = require('supertest');
const testServer = require('../helpers/test-server');
const config = require('../fixtures/simple-config/webpack.config');
const port = require('../ports-map')['cross-origin-header-check'];

// headers sent by browsers for a classic `<script src="...">` tag
// (without the `crossorigin` attribute) loaded from another site
const crossSiteNoCorsHeaders = {
  'sec-fetch-mode': 'no-cors',
  'sec-fetch-site': 'cross-site',
};

describe('cross origin header check', () => {
  let server;
  let req;

  describe('with the default options', () => {
    beforeAll((done) => {
      server = testServer.start(config, { port }, done);
      req = request(server.app);
    });

    afterAll(testServer.close);

    it('should return 403 for a cross-site no-cors request of the bundle', (done) => {
      req
        .get('/main.js')
        .set('host', `localhost:${port}`)
        .set(crossSiteNoCorsHeaders)
        .expect(403, 'Cross-Origin request blocked', done);
    });

    it('should return 403 for a cross-site no-cors request using an IP address host', (done) => {
      req
        .get('/main.js')
        .set('host', `127.0.0.1:${port}`)
        .set(crossSiteNoCorsHeaders)
        .expect(403, 'Cross-Origin request blocked', done);
    });

    it('should return 403 for a cross-site no-cors request of the client bundles', (done) => {
      req
        .get('/webpack-dev-server.js')
        .set('host', `localhost:${port}`)
        .set(crossSiteNoCorsHeaders)
        .expect(403, 'Cross-Origin request blocked', (error) => {
          if (error) {
            done(error);
            return;
          }

          req
            .get('/__webpack_dev_server__/live.bundle.js')
            .set('host', `localhost:${port}`)
            .set(crossSiteNoCorsHeaders)
            .expect(403, 'Cross-Origin request blocked', done);
        });
    });

    it('should return 403 for a cross-site no-cors POST request', (done) => {
      req
        .post('/main.js')
        .set('host', `localhost:${port}`)
        .set(crossSiteNoCorsHeaders)
        .expect(403, 'Cross-Origin request blocked', done);
    });

    it('should return 200 for a request without fetch metadata headers', (done) => {
      req
        .get('/main.js')
        .set('host', `localhost:${port}`)
        .expect(200, done);
    });

    it('should return 200 for a same-origin no-cors request', (done) => {
      req
        .get('/main.js')
        .set('host', `localhost:${port}`)
        .set('sec-fetch-mode', 'no-cors')
        .set('sec-fetch-site', 'same-origin')
        .expect(200, done);
    });

    it('should return 200 for a same-site no-cors request', (done) => {
      req
        .get('/main.js')
        .set('host', `localhost:${port}`)
        .set('sec-fetch-mode', 'no-cors')
        .set('sec-fetch-site', 'same-site')
        .expect(200, done);
    });

    it('should return 200 for a cross-site cors request', (done) => {
      req
        .get('/main.js')
        .set('host', `localhost:${port}`)
        .set('sec-fetch-mode', 'cors')
        .set('sec-fetch-site', 'cross-site')
        .expect(200, done);
    });
  });

  describe('with the "allowedHosts" option', () => {
    beforeAll((done) => {
      server = testServer.start(
        config,
        {
          port,
          allowedHosts: ['localhost', '.example.com'],
        },
        done
      );
      req = request(server.app);
    });

    afterAll(testServer.close);

    it('should return 200 for a cross-site no-cors request to an allowed host', (done) => {
      req
        .get('/main.js')
        .set('host', `localhost:${port}`)
        .set(crossSiteNoCorsHeaders)
        .expect(200, done);
    });

    it('should return 200 for a cross-site no-cors request to an allowed subdomain', (done) => {
      req
        .get('/main.js')
        .set('host', `app.example.com:${port}`)
        .set(crossSiteNoCorsHeaders)
        .expect(200, done);
    });

    it('should return 403 for a cross-site no-cors request to a host that is not allowed', (done) => {
      req
        .get('/main.js')
        .set('host', `127.0.0.1:${port}`)
        .set(crossSiteNoCorsHeaders)
        .expect(403, 'Cross-Origin request blocked', done);
    });
  });

  describe('with the "public" option', () => {
    beforeAll((done) => {
      server = testServer.start(
        config,
        {
          port,
          public: `myhost.test:${port}`,
        },
        done
      );
      req = request(server.app);
    });

    afterAll(testServer.close);

    it('should return 200 for a cross-site no-cors request to the public host', (done) => {
      req
        .get('/main.js')
        .set('host', `myhost.test:${port}`)
        .set(crossSiteNoCorsHeaders)
        .expect(200, done);
    });

    it('should return 403 for a cross-site no-cors request to another host', (done) => {
      req
        .get('/main.js')
        .set('host', `localhost:${port}`)
        .set(crossSiteNoCorsHeaders)
        .expect(403, 'Cross-Origin request blocked', done);
    });
  });

  describe('with the "disableHostCheck" option', () => {
    beforeAll((done) => {
      server = testServer.start(
        config,
        {
          port,
          disableHostCheck: true,
        },
        done
      );
      req = request(server.app);
    });

    afterAll(testServer.close);

    it('should return 200 for a cross-site no-cors request', (done) => {
      req
        .get('/main.js')
        .set('host', `localhost:${port}`)
        .set(crossSiteNoCorsHeaders)
        .expect(200, done);
    });
  });
});
