// MongoDB rejects a projection that names a field and one of its children
// ("Path collision"). Stubbed models in other tests can't catch that, so this
// builds the real projections Mongoose would send.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
jest.mock('../src/services/cache.service', () => ({
    acquireLock: async () => true, releaseLock: async () => true, get: async () => null, set: async () => true
}));

const Duty = require('../src/models/Duty');
const dutyOfferService = require('../src/services/dutyOffer.service');

function collisions(fields) {
    const paths = Object.keys(fields || {});
    return paths.filter(a => paths.some(b => b !== a && b.startsWith(`${a}.`)));
}

describe('query projections', () => {
    it('the offer widening job asks for a valid projection that includes the hidden lists', async () => {
        let captured;
        const realFind = Duty.find;
        Duty.find = function (filter) {
            const query = realFind.call(this, filter);
            query.exec = async function () { this._applyPaths(); captured = this._fields; return []; };
            query.then = function (resolve, reject) { return this.exec().then(resolve, reject); };
            return query;
        };
        try {
            await dutyOfferService.runDue();
        } finally {
            Duty.find = realFind;
        }
        expect(collisions(captured)).toEqual([]);
        expect(captured['offer.notifiedStaff']).not.toBe(0);
        expect(captured['offer.pendingStaff']).not.toBe(0);
    });

    it('the collision check itself spots a parent and child together', () => {
        expect(collisions({ offer: 1, 'offer.notifiedStaff': 1 })).toEqual(['offer']);
    });
});
