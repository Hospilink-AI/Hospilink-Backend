// Socket.IO is ready before the server takes connections, sockets hold only
// what they need, and the server stops cleanly behind the AWS load balancer.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
jest.mock('../src/services/cache.service', () => ({ getStrict: async () => null, get: async () => null, set: async () => true }));

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../src/models/User');
const MedicalStaff = require('../src/models/MedicalStaff');
const authMiddleware = require('../src/socket/authMiddleware');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

describe('server start and stop', () => {
    it('waits for Socket.IO before listening and hands the real server to the notification manager', () => {
        const awaitAt = server.indexOf('const io = await initializeSocket(server);');
        expect(awaitAt).toBeGreaterThan(-1);
        expect(server.indexOf('websocketManager.setIO(io);')).toBeGreaterThan(awaitAt);
        expect(server.indexOf('server.listen(')).toBeGreaterThan(awaitAt);
    });

    it('keeps connections open longer than the load balancer does', () => {
        expect(server).toMatch(/server\.keepAliveTimeout = .*\|\| 65000;/);
        expect(server).toContain('server.headersTimeout = server.keepAliveTimeout + 1000;');
    });

    it('closes sockets, the server and the databases on SIGTERM, with a time limit', () => {
        expect(server).toContain("['SIGTERM', 'SIGINT']");
        expect(server).toContain('io.close(async () => {');
        expect(server).toContain("require('mongoose').connection.close()");
        expect(server).toContain('force.unref()');
    });
});

describe('socket sign-in', () => {
    const userId = new mongoose.Types.ObjectId();
    let user;
    let selects;

    const chain = (value) => {
        const c = { select: (f) => { selects.push(f); return c; }, lean: async () => value };
        return c;
    };

    beforeEach(() => {
        selects = [];
        user = { _id: userId, role: 'staff', name: 'TEST' };
        User.findById = () => chain(user);
        MedicalStaff.findOne = () => chain({ _id: new mongoose.Types.ObjectId(), jobRole: 'rmo', isSuspended: false });
    });

    function connect() {
        const token = jwt.sign({ id: String(userId) }, process.env.JWT_SECRET);
        const socket = { handshake: { auth: { token }, headers: {} } };
        return new Promise((resolve) => authMiddleware(socket, (err) => resolve({ err, socket })));
    }

    it('keeps plain, minimal user and profile objects with an id', async () => {
        const { err, socket } = await connect();
        expect(err).toBeUndefined();
        expect(socket.user.id).toBe(String(userId));
        expect(socket.medicalStaff.jobRole).toBe('rmo');
        expect(selects).toEqual(['_id role name isActive deletion', '_id jobRole isSuspended suspensionReason']);
        expect(typeof socket.user.save).toBe('undefined');
    });

    it('refuses an account scheduled for deletion, like the HTTP sign-in', async () => {
        user.deletion = { requestedAt: new Date() };
        const { err } = await connect();
        expect(err.message).toMatch(/scheduled for deletion/);
    });

    it('refuses a deactivated admin', async () => {
        Object.assign(user, { role: 'admin', isActive: false });
        const { err } = await connect();
        expect(err.message).toMatch(/deactivated/);
    });
});
