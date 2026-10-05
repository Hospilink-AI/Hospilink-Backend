jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
const mockCalls = { cancel: [], notify: [], withdraw: [], closeApps: [], cache: [], logout: [], revoke: [], email: [], logs: [] };
jest.mock('../src/services/cancellation.service', () => ({
    cancelDuty: async (id, actor, reason, text, options) => {
        mockCalls.cancel.push({ id, actor, reason, text, options });
        return { _id: id, hospital: { user: { _id: 'hospUser' } } };
    },
    _getMinutesUntilDutyStart: (d) => d.minutesAway
}));
jest.mock('../src/services/notificationEmitter', () => ({
    emitDutyCancelled: async (duty, actor, reason, text, to) => { mockCalls.notify.push({ id: duty._id, role: actor.role, to }); }
}));
jest.mock('../src/services/jobApplication.service', () => ({
    withdraw: async (id, userId, reason, text) => { mockCalls.withdraw.push({ id, reason, text }); }
}));
jest.mock('../src/services/jobVacancy.service', () => ({
    _closeOpenApplications: async (vacancy) => { mockCalls.closeApps.push(vacancy._id); }
}));
jest.mock('../src/services/cache.service', () => ({ del: async (k) => { mockCalls.cache.push(k); return true; } }));
jest.mock('../src/services/auth.service', () => ({ logout: async (token) => { mockCalls.logout.push(token); } }));
jest.mock('../src/services/dashboard.service', () => ({ revokeDashboardLocationPermission: async (id) => { mockCalls.revoke.push(id); } }));
jest.mock('../src/services/email.service', () => ({ sendAccountDeletionScheduledEmail: async (email) => { mockCalls.email.push(email); } }));
jest.mock('../src/services/activityLogEmitter', () => ({
    emitUserActivity: async (action) => { mockCalls.logs.push(action); },
    emitDutyActivity: async (action) => { mockCalls.logs.push(action); },
    actorFrom: (u) => ({ userId: u._id, name: u.name, role: u.role })
}));
jest.mock('../src/services/systemConfig.service', () => ({ getEffective: async () => 30 }));

const User = require('../src/models/User');
const Duty = require('../src/models/Duty');
const Hospital = require('../src/models/Hospital');
const MedicalStaff = require('../src/models/MedicalStaff');
const JobVacancy = require('../src/models/JobVacancy');
const JobApplication = require('../src/models/JobApplication');
const accountDeletion = require('../src/services/accountDeletion.service');

const chain = (value) => { const c = { select: () => c, populate: () => c, lean: async () => value, then: (r, j) => Promise.resolve(value).then(r, j) }; return c; };
let userUpdates, staffUpdates, savedDuties;

function setup({ role = 'staff', duties = [], applications = [], vacancies = [], passwordOk = true, deletion } = {}) {
    Object.keys(mockCalls).forEach(k => { mockCalls[k].length = 0; });
    userUpdates = []; staffUpdates = []; savedDuties = [];
    const user = { _id: 'u1', role, email: 'doc@x.com', name: 'Asha', deletion, comparePassword: async () => passwordOk };
    User.findById = () => chain(user);
    User.updateOne = async (q, u) => { userUpdates.push(u); return { modifiedCount: 1 }; };
    MedicalStaff.findOne = () => chain({ _id: 's1', fullName: 'Dr Asha' });
    MedicalStaff.updateOne = async (q, u) => { staffUpdates.push(u); };
    Hospital.findOne = () => chain({ _id: 'h1', hospitalLegalName: 'City Hospital' });
    Duty.find = () => chain(duties);
    Duty.findById = (id) => {
        const d = duties.find(x => x._id === id);
        const doc = { ...d, statusHistory: [], assignedTo: d.status === 'assigned' ? { user: 'staffUser' } : null, save: async () => { savedDuties.push(doc); } };
        return chain(doc);
    };
    JobApplication.find = () => chain(applications);
    JobVacancy.find = async () => vacancies.map(v => ({ ...v, save: async () => {} }));
    return user;
}

const req = { headers: { authorization: 'Bearer tok1' } };

describe('requesting account deletion', () => {
    it('refuses a wrong password and changes nothing', async () => {
        setup({ passwordOk: false });
        await expect(accountDeletion.request('u1', 'bad', null, req)).rejects.toThrow('Incorrect password');
        expect(userUpdates).toEqual([]);
    });

    it('refuses while a duty is under way', async () => {
        setup({ duties: [{ _id: 'd1', status: 'in-progress', minutesAway: -30 }] });
        await expect(accountDeletion.request('u1', 'pw', null, req)).rejects.toThrow('duty under way');
        expect(mockCalls.cancel).toEqual([]);
        expect(userUpdates).toEqual([]);
    });

    it('refuses when an accepted duty starts inside the cancel cutoff', async () => {
        setup({ duties: [{ _id: 'd1', status: 'assigned', minutesAway: 20 }] });
        await expect(accountDeletion.request('u1', 'pw', null, req)).rejects.toThrow('less than 30 minutes');
        expect(mockCalls.cancel).toEqual([]);
    });

    it('doctor: relists duties without a watchlist flag, withdraws applications, and locks the account', async () => {
        setup({
            duties: [{ _id: 'd1', status: 'assigned', minutesAway: 600 }, { _id: 'd2', status: 'assigned', minutesAway: 2000 }],
            applications: [{ _id: 'a1' }]
        });
        const before = Date.now();
        const result = await accountDeletion.request('u1', 'pw', 'moving abroad', req);

        expect(mockCalls.cancel.map(c => [c.id, c.reason, c.options])).toEqual([
            ['d1', 'other_staff', { skipWatchlist: true }],
            ['d2', 'other_staff', { skipWatchlist: true }]
        ]);
        expect(mockCalls.notify).toEqual([{ id: 'd1', role: 'staff', to: ['hospUser'] }, { id: 'd2', role: 'staff', to: ['hospUser'] }]);
        expect(mockCalls.withdraw).toEqual([{ id: 'a1', reason: 'other', text: 'Account deleted' }]);

        const { $set } = userUpdates[0];
        expect($set.fcmTokens).toEqual([]);
        expect($set.deletion.reason).toBe('moving abroad');
        const days = ($set.deletion.scheduledFor - $set.deletion.requestedAt) / 86400000;
        expect(days).toBe(7);
        expect($set.deletion.requestedAt.getTime()).toBeGreaterThanOrEqual(before);

        expect(mockCalls.cache).toEqual(expect.arrayContaining(['session:u1', 'user:doc@x.com']));
        expect(mockCalls.logout).toEqual(['tok1']);
        expect(staffUpdates).toEqual([{ $set: { isAvailable: false } }]);
        expect(mockCalls.revoke).toEqual(['u1']);
        expect(mockCalls.email).toEqual(['doc@x.com']);
        expect(mockCalls.logs).toContain('ACCOUNT_DELETION_REQUESTED');
        expect(result).toMatchObject({ scheduled: true, graceDays: 7, dutiesCancelled: 2, applicationsWithdrawn: 1 });
    });

    it('hospital: cancels open and filled duties, tells only the assigned doctor, and closes vacancies', async () => {
        setup({
            role: 'hospital',
            duties: [{ _id: 'd1', status: 'available', minutesAway: 10 }, { _id: 'd2', status: 'assigned', minutesAway: 600 }],
            vacancies: [{ _id: 'v1' }]
        });
        const result = await accountDeletion.request('u1', 'pw', null, req);

        expect(savedDuties.map(d => [d._id, d.status, d.cancellation.cancelledBy])).toEqual([
            ['d1', 'cancelled', 'hospital'],
            ['d2', 'cancelled', 'hospital']
        ]);
        expect(mockCalls.notify).toEqual([{ id: 'd2', role: 'hospital', to: ['staffUser'] }]);
        expect(mockCalls.closeApps).toEqual(['v1']);
        expect(mockCalls.revoke).toEqual([]);
        expect(result).toMatchObject({ dutiesCancelled: 2, vacanciesClosed: 1 });
    });

    it('refuses a second request', async () => {
        setup({ deletion: { requestedAt: new Date() } });
        await expect(accountDeletion.request('u1', 'pw', null, req)).rejects.toThrow('already scheduled');
    });
});

describe('signing in during the grace period', () => {
    it('cancels the deletion', async () => {
        const user = setup({ deletion: { requestedAt: new Date(), scheduledFor: new Date() } });
        expect(await accountDeletion.cancelOnSignin(user)).toBe(true);
        expect(userUpdates).toEqual([{ $unset: { deletion: 1 } }]);
        expect(mockCalls.logs).toContain('ACCOUNT_DELETION_CANCELLED');
    });

    it('does nothing when no deletion is scheduled', async () => {
        const user = setup();
        expect(await accountDeletion.cancelOnSignin(user)).toBe(false);
        expect(userUpdates).toEqual([]);
    });
});
