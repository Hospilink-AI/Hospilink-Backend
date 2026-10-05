jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
const mockCache = new Map();
const mockDeleted = [];
jest.mock('../src/services/cache.service', () => ({
    get: async (k) => (mockCache.has(k) ? mockCache.get(k) : null),
    set: async (k, v) => { mockCache.set(k, v); return true; },
    del: async (k) => { mockDeleted.push(k); mockCache.delete(k); return true; },
    invalidatePattern: async () => true,
    invalidateUserProfiles: async () => true,
    invalidateProfileStatus: async () => true
}));
const mockRedis = { stored: [], deleted: [] };
jest.mock('../src/config/redis', () => ({
    getClientAsync: async () => ({
        get: async () => 'true',
        setex: async (k) => { mockRedis.stored.push(k); },
        del: async (k) => { mockRedis.deleted.push(k); },
        geoadd: async () => { mockRedis.stored.push('geo'); },
        zrem: async () => { mockRedis.deleted.push('geo'); }
    })
}));
jest.mock('../src/services/block.service', () => ({ staffHiddenFrom: async () => [], isBlocked: async () => false }));

const User = require('../src/models/User');
const Hospital = require('../src/models/Hospital');
const MedicalStaff = require('../src/models/MedicalStaff');
const Duty = require('../src/models/Duty');
const staffLocator = require('../src/services/staffLocator.service');
const dutyOfferService = require('../src/services/dutyOffer.service');
const dutyInviteService = require('../src/services/dutyInvite.service');
const dashboardService = require('../src/services/dashboard.service');
const demoAccounts = require('../src/services/demoAccount.service');
const { dutyFilter } = require('../src/services/analytics/dutyData');

const lean = (v) => ({ select: () => ({ lean: async () => v }), lean: async () => v });

beforeEach(() => {
    mockCache.clear();
    mockDeleted.length = 0;
    mockRedis.stored.length = 0;
    mockRedis.deleted.length = 0;
});

describe('demo and real accounts never meet', () => {
    it('staff search finds only real doctors for real hospitals and only demo doctors for demo ones', () => {
        expect(staffLocator._eligibleFilter('Doctor').isDemo).toEqual({ $ne: true });
        expect(staffLocator._eligibleFilter('Doctor', true).isDemo).toBe(true);
    });

    it('a doctor can only open or accept duties on their own side', async () => {
        const real = { _id: 's1' };
        const demo = { _id: 's2', isDemo: true };
        expect(await dutyOfferService.isEligible({ hospital: 'h1', isDemo: true }, real)).toBe(false);
        expect(await dutyOfferService.isEligible({ hospital: 'h1' }, demo)).toBe(false);
        expect(await dutyOfferService.isEligible({ hospital: 'h1', isDemo: true }, demo)).toBe(true);
        expect(await dutyOfferService.isEligible({ hospital: 'h1' }, real)).toBe(true);
    });

    it('a real hospital cannot invite a demo doctor', async () => {
        Hospital.findById = () => lean({ _id: 'h1' });
        let query;
        MedicalStaff.find = (q) => { query = q; return lean([]); };
        await expect(dutyInviteService.resolveInvitees(['s2'], 'Doctor', { hospitalId: 'h1' })).rejects.toThrow('not verified or no longer active');
        expect(query.isDemo).toEqual({ $ne: true });
    });

    it('analytics leave demo duties out', async () => {
        expect((await dutyFilter({})).isDemo).toEqual({ $ne: true });
    });
});

describe('demo doctor location', () => {
    it('keeps a demo doctor at their profile address', async () => {
        MedicalStaff.exists = async () => ({ _id: 's2' });
        await dashboardService.setDashboardLocationViaSocket('u2', 37.77, -122.41);
        expect(mockRedis.stored).toEqual([]);
    });

    it('stores a real doctor\'s live position as before', async () => {
        MedicalStaff.exists = async () => null;
        await dashboardService.setDashboardLocationViaSocket('u1', 18.52, 73.85);
        expect(mockRedis.stored).toEqual(expect.arrayContaining(['dashboard:location:u1', 'geo']));
    });
});

describe('marking demo accounts', () => {
    let updates;
    beforeEach(() => {
        updates = [];
        User.updateOne = async (q, u) => { updates.push(['user', u]); };
        Hospital.updateOne = async (q, u) => { updates.push(['hospital', u]); };
        MedicalStaff.updateOne = async (q, u) => { updates.push(['staff', u]); };
        Duty.updateMany = async (q, u) => { updates.push(['duties', q, u]); };
        Hospital.findOne = () => lean({ _id: 'h9' });
        MedicalStaff.findOne = () => lean({ _id: 's9' });
    });

    it('a demo hospital is verified without documents and its duties become demo', async () => {
        User.findById = () => lean({ _id: 'u9', role: 'hospital', email: 'review.hospital@x.com' });
        await demoAccounts.set('u9', true);
        expect(updates).toEqual(expect.arrayContaining([
            ['user', { $set: { isEmailVerified: true } }],
            ['duties', { hospital: 'h9' }, { $set: { isDemo: true } }]
        ]));
        const profile = updates.find(u => u[0] === 'hospital')[1].$set;
        expect(profile).toMatchObject({ isDemo: true, verificationStatus: 'verified', isDocumentsUploaded: true });
        expect(mockDeleted).toEqual(expect.arrayContaining(['hospital_verification:u9', 'session:u9']));
    });

    it('a demo doctor loses any live position', async () => {
        User.findById = () => lean({ _id: 'u8', role: 'staff', email: 'review.doctor@x.com' });
        await demoAccounts.set('u8', true);
        expect(mockRedis.deleted).toEqual(expect.arrayContaining(['dashboard:location:u8', 'geo']));
        expect(mockDeleted).toContain('demo:staff:u8');
    });

    it('unmarking sends the account back to pending verification', async () => {
        User.findById = () => lean({ _id: 'u8', role: 'staff', email: 'review.doctor@x.com' });
        await demoAccounts.set('u8', false);
        expect(updates).toEqual([['staff', { $unset: { isDemo: 1, verifiedAt: 1 }, $set: { verificationStatus: 'pending' } }]]);
    });

    it('refuses admins, missing profiles and accounts being deleted', async () => {
        User.findById = () => lean({ _id: 'a1', role: 'admin' });
        await expect(demoAccounts.set('a1', true)).rejects.toThrow('not found');
        User.findById = () => lean({ _id: 'u7', role: 'staff' });
        MedicalStaff.findOne = () => lean(null);
        await expect(demoAccounts.set('u7', true)).rejects.toThrow('create its profile');
        User.findById = () => lean({ _id: 'u6', role: 'staff', deletion: { requestedAt: new Date() } });
        await expect(demoAccounts.set('u6', true)).rejects.toThrow('being deleted');
        expect(updates).toEqual([]);
    });
});
