// One error handler: the right status for each kind of error, a safe message,
// and one log line (errors for 5xx, a short info line for 4xx)
const mockLog = [];
jest.mock('../src/utils/logger', () => ({
    info: (msg, ctx) => mockLog.push({ level: 'info', msg, ctx }),
    error: (msg, err, ctx) => mockLog.push({ level: 'error', msg, err, ctx }),
    warn: jest.fn(),
    debug: jest.fn()
}));

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { errorHandler, normalizeError, NotFoundError, UnprocessableEntityError } = require('../src/middleware/error.middleware');

function send(err, { production = false, headersSent = false } = {}) {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = production ? 'production' : 'development';
    let status;
    let body;
    const res = { headersSent, status(s) { status = s; return this; }, json(b) { body = b; return this; } };
    errorHandler(err, { requestId: 'r1', method: 'GET', originalUrl: '/api/x?token=secret' }, res, () => {});
    process.env.NODE_ENV = previous;
    return { status, body };
}

beforeEach(() => { mockLog.length = 0; });

describe('status for each kind of error', () => {
    it.each([
        ['our NotFoundError', new NotFoundError('Duty not found'), 404],
        ['a bad id', new mongoose.Error.CastError('ObjectId', 'abc', '_id'), 400],
        ['schema validation', (() => { const e = new mongoose.Error.ValidationError(); e.addError('name', new mongoose.Error.ValidatorError({ message: 'Name is required', path: 'name' })); return e; })(), 400],
        ['a duplicate', Object.assign(new Error('E11000'), { code: 11000, keyValue: { email: 'a@b.in' } }), 409],
        ['bad JSON', Object.assign(new SyntaxError('Unexpected token'), { type: 'entity.parse.failed', status: 400 }), 400],
        ['a large body', Object.assign(new Error('too large'), { type: 'entity.too.large', status: 413 }), 413],
        ['a large file', Object.assign(new Error('File too large'), { name: 'MulterError', code: 'LIMIT_FILE_SIZE' }), 413],
        ['an expired token', Object.assign(new Error('jwt expired'), { name: 'TokenExpiredError' }), 401],
        ['anything else', new Error('db exploded'), 500]
    ])('%s', (_, err, status) => {
        expect(normalizeError(err).status).toBe(status);
    });

    it('never echoes the duplicate value', () => {
        const { message } = normalizeError(Object.assign(new Error('E11000 dup key: { email: "a@b.in" }'), { code: 11000, keyValue: { email: 'a@b.in' } }));
        expect(message).toBe('A record with this email already exists');
    });
});

describe('responses and logs', () => {
    it('a 4xx keeps its message and code, and logs one short info line without the message or query', () => {
        const { status, body } = send(new UnprocessableEntityError('Upload your resume first', 'RESUME_REQUIRED'));
        expect(status).toBe(422);
        expect(body).toEqual({ success: false, message: 'Upload your resume first', code: 'RESUME_REQUIRED', requestId: 'r1' });
        expect(mockLog).toEqual([{ level: 'info', msg: 'Request refused', ctx: { requestId: 'r1', method: 'GET', path: '/api/x', status: 422, code: 'RESUME_REQUIRED' } }]);
    });

    it('a 5xx is logged with its error, and production replies hide the details', () => {
        const { status, body } = send(new Error('Cannot read properties of undefined'), { production: true });
        expect(status).toBe(500);
        expect(body).toEqual({ success: false, message: 'Internal server error', requestId: 'r1' });
        expect(mockLog[0]).toMatchObject({ level: 'error', msg: 'Request failed', ctx: { status: 500, path: '/api/x' } });
        expect(mockLog[0].err.message).toBe('Cannot read properties of undefined');
    });

    it('does not try to answer twice', () => {
        const { status } = send(new Error('late'), { headersSent: true });
        expect(status).toBeUndefined();
    });

    it('app.js uses this handler and leaves shutdown to server.js', () => {
        const app = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
        expect(app).toContain('require("./middleware/error.middleware").errorHandler');
        expect(app).not.toMatch(/process\.on\(["']SIG/);
        expect(app).not.toContain('process.exit(');
    });
});
