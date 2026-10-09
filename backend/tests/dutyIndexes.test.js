// Every index the Duty model asks MongoDB for must be a valid key pattern,
// or the build fails at startup and the index silently doesn't exist.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
const Duty = require('../src/models/Duty');

const VALID = new Set([1, -1, 'text', '2dsphere', '2d', 'hashed']);

describe('duty indexes', () => {
    it('use only valid key types', () => {
        const bad = Duty.schema.indexes()
            .filter(([fields]) => Object.values(fields).some(v => !VALID.has(v)))
            .map(([fields]) => JSON.stringify(fields));
        expect(bad).toEqual([]);
    });
});
