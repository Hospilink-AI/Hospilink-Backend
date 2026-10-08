// Before deleting, the app shows what would happen: duties cancelled,
// applications withdrawn, the deletion date, and anything blocking it today.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
const mockWrites = [];
jest.mock('../src/services/cancellation.service', () => ({
    cancelDuty: async () => { mockWrites.push('cancel'); },
    _getMinutesUntilDutyStart: (d) => d.minutesAway
}));
jest.mock('../src/services/cache.service', () => ({ del: async () => true, get: async () => null, set: async () => true }));
jest.mock('../src/services/systemConfig.service', () => ({ getEffective: async () => 30 }));

const User = require('../src/models/User');
const Duty = require('../src/models/Duty');
const Hospital = require('../src/models/Hospital');
const MedicalStaff = require('../src/models/MedicalStaff');
const JobVacancy = require('../src/models/JobVacancy');
const JobApplication = require('../src/models/JobApplication');
const accountDeletion = require('../src/services/accountDeletion.service');
const router = require('../src/routes/accountDeletion.routes');

const chain = (value) => { const c = { select: () => c, populate: () => c, lean: async () => value, then: (r, j) => Promise.resolve(value).then(r, j) }; return c; };

let user;
let duties;
beforeEach(() => {
    mockWrites.length = 0;
    user = { _id: 'u1', role: 'staff' };
    duties = [{ _id: 'd1', status: 'assigned', minutesAway: 600 }, { _id: 'd2', status: 'assigned', minutesAway: 3000 }];
    User.findById = () => chain(user);
    MedicalStaff.findOne = () => chain({ _id: 's1' });
    Hospital.findOne = () => chain({ _id: 'h1' });
    Duty.find = () => chain(duties);
    JobApplication.countDocuments = async () => 3;
    JobVacancy.countDocuments = async () => 2;
    User.updateOne = async () => { mockWrites.push('user'); };
});

describe('deletion preview', () => {
    it('counts what a doctor would lose and changes nothing', async () => {
        const preview = await accountDeletion.preview('u1');
        expect(preview).toMatchObject({
            upcomingDuties: 2, dutiesUnderWay: 0, activeApplications: 3, openVacancies: 0,
            canDeleteNow: true, blockedReason: null, alreadyScheduled: false, graceDays: 7
        });
        const days = (preview.scheduledFor - Date.now()) / (24 * 60 * 60 * 1000);
        expect(days).toBeGreaterThan(6.99);
        expect(mockWrites).toEqual([]);
    });

    it('says why a duty under way blocks it today', async () => {
        duties.push({ _id: 'd3', status: 'in-progress', minutesAway: -60 });
        const preview = await accountDeletion.preview('u1');
        expect(preview.dutiesUnderWay).toBe(1);
        expect(preview.canDeleteNow).toBe(false);
        expect(preview.blockedReason).toMatch(/under way/);
    });

    it('says why a duty starting soon blocks it', async () => {
        duties[0].minutesAway = 10;
        const preview = await accountDeletion.preview('u1');
        expect(preview.canDeleteNow).toBe(false);
        expect(preview.blockedReason).toMatch(/less than 30 minutes/);
    });

    it('counts open vacancies for a hospital', async () => {
        user.role = 'hospital';
        const preview = await accountDeletion.preview('u1');
        expect(preview).toMatchObject({ openVacancies: 2, activeApplications: 0 });
    });

    it('returns the date already set when deletion is scheduled', async () => {
        const scheduledFor = new Date('2026-10-15T00:00:00Z');
        user.deletion = { requestedAt: new Date(), scheduledFor };
        const preview = await accountDeletion.preview('u1');
        expect(preview).toMatchObject({ alreadyScheduled: true, canDeleteNow: false, scheduledFor });
    });

    it('is served at GET /preview', () => {
        expect(router.stack.some(l => l.route && l.route.path === '/preview' && l.route.methods.get)).toBe(true);
    });
});
