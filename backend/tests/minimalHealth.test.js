// The public health check says only that the process is up
jest.mock('../src/services/email.service', () => ({}));
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY || 'test-key';
const app = require('../src/app');


test('GET /health returns just the status', async () => {
    const layer = app._router.stack.find(l => l.route && l.route.path === '/health');
    const handler = layer.route.stack[0].handle;
    let status;
    let body;
    const headers = {};
    const res = {
        set: (k, v) => { headers[k] = v; return res; },
        status: (s) => { status = s; return res; },
        json: (b) => { body = b; return res; }
    };
    handler({}, res);
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'OK' });
    expect(headers['Cache-Control']).toBe('no-store');
});
