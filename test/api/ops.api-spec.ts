import { createHarness, type Harness } from './harness';

let h: Harness;
beforeAll(async () => (h = await createHarness()));
afterAll(async () => h.close());
afterEach(() => (h.probe.up = true));

describe('GET /health', () => {
  it('is 200 even when the database is down (liveness touches nothing)', async () => {
    h.probe.up = false;
    await h.http.get('/health').expect(200, { status: 'ok' });
  });
});

describe('GET /ready', () => {
  it('is 200 when the database is reachable', async () => {
    await h.http.get('/ready').expect(200, { status: 'ready', checks: [{ name: 'database', status: 'up' }] });
  });

  it('is 503 when it is not', async () => {
    h.probe.up = false;
    await h.http.get('/ready').expect(503, { status: 'not_ready', checks: [{ name: 'database', status: 'down' }] });
  });
});

describe('GET /meta/min-app-version', () => {
  it('returns the configured version', async () => {
    await h.http.get('/meta/min-app-version').expect(200, { minAppVersion: h.env.MIN_APP_VERSION });
  });
});

describe('every response', () => {
  it('carries a request id, reusing a well-formed incoming one', async () => {
    const fresh = await h.http.get('/health');
    expect(fresh.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const echoed = await h.http.get('/health').set('x-request-id', 'trace-123');
    expect(echoed.headers['x-request-id']).toBe('trace-123');
    const replaced = await h.http.get('/health').set('x-request-id', 'bad id with spaces');
    expect(replaced.headers['x-request-id']).not.toBe('bad id with spaces');
  });

  it('is a JSON 404 for an unknown route', async () => {
    const res = await h.http.get('/nope').expect(404);
    expect(res.body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });
});
