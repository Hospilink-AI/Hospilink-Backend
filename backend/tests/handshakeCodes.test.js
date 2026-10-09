// The start code is texted to the hospital and the end code to the doctor.
// Neither may come back in an API response, or each side could skip the other.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));

const mongoose = require('mongoose');
const Duty = require('../src/models/Duty');

function projectionOf(query) {
    query._applyPaths();
    return query._fields || {};
}

describe('duty handshake codes', () => {
    it('are left out of every duty query by default', () => {
        const id = new mongoose.Types.ObjectId();
        for (const query of [Duty.findById(id), Duty.find({}), Duty.findOne({ _id: id }), Duty.find({}).lean()]) {
            const fields = projectionOf(query);
            expect(fields['startOtp.code']).toBe(0);
            expect(fields['endOtp.code']).toBe(0);
        }
    });

    it('are hidden in the schema, so populated duties skip them too', () => {
        expect(Duty.schema.path('startOtp.code').options.select).toBe(false);
        expect(Duty.schema.path('endOtp.code').options.select).toBe(false);
    });

    it('are removed from JSON even when a path selected them', () => {
        const duty = new Duty({
            startOtp: { code: '123456', status: 'PENDING', expiresAt: new Date() },
            endOtp: { code: '654321', status: 'PENDING', expiresAt: new Date() }
        });
        const json = JSON.parse(JSON.stringify(duty));
        expect(json.startOtp.code).toBeUndefined();
        expect(json.endOtp.code).toBeUndefined();
        expect(json.startOtp.status).toBe('PENDING');
        expect(json.endOtp.status).toBe('PENDING');
        expect(json.startOtp.expiresAt).toBeDefined();
    });

    it('are selected only where the server checks or resends them', () => {
        const fs = require('fs');
        const path = require('path');
        const source = fs.readFileSync(path.join(__dirname, '../src/services/duty.service.js'), 'utf8');
        const body = (name) => {
            const start = source.indexOf(`    async ${name}(`);
            const end = source.indexOf('\n    async ', start + 10);
            return source.slice(start, end);
        };
        expect(body('verifyStartOtp')).toContain("select('+startOtp.code')");
        expect(body('requestEndOtp')).toContain("select('+endOtp.code')");
        expect(body('verifyEndOtp')).toContain("select('+endOtp.code')");
        expect(source.match(/\+startOtp\.code|\+endOtp\.code/g)).toHaveLength(3);
    });
});
