// Entries go through the real logging service and model validation. A null
// target type, or a target id that isn't a database id, used to fail
// validation and the entry was silently dropped.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));

const ActivityLog = require('../src/models/ActivityLog');
const activityLogService = require('../src/services/activityLog.service');
const { ACTIVITY_ACTIONS: A } = require('../src/utils/activityLog.constants');

const saved = [];
beforeAll(() => {
    ActivityLog.prototype.save = async function () {
        await this.validate();
        saved.push(this.toObject());
        return this;
    };
});
beforeEach(() => { saved.length = 0; });

const admin = { userId: '000000000000000000000001', name: 'Asha', role: 'admin', email: 'a@x' };

describe('activity log entries are saved', () => {
    it('saves entries with no target (security, system, admin sign-in)', async () => {
        await activityLogService.logActivity({ userId: null, name: 'Unknown', role: 'system' }, A.USER_LOGIN_FAILED, {}, { reason: 'bad password' });
        await activityLogService.logSystemActivity(A.CRON_JOB_EXECUTED, { jobName: 'expiry' });
        await activityLogService.logActivity(admin, A.ADMIN_LOGIN, {}, {});
        expect(saved.map(s => s.action)).toEqual(['USER_LOGIN_FAILED', 'CRON_JOB_EXECUTED', 'ADMIN_LOGIN']);
    });

    it('keeps a non-database target id as the name and in details', async () => {
        await activityLogService.logActivity(admin, A.SYSTEM_SETTINGS_CHANGED, { type: 'setting', id: 'offer.startRadiusKm' }, { value: 25 });
        expect(saved[0].target).toEqual({ type: 'setting', name: 'offer.startRadiusKm' });
        expect(saved[0].details).toMatchObject({ value: 25, targetRef: 'offer.startRadiusKm' });
    });

    it('keeps a database target id as the id', async () => {
        await activityLogService.logActivity(admin, A.VACANCY_CLOSED, { type: 'vacancy', id: '000000000000000000000009', name: 'Night RMO' });
        expect(String(saved[0].target.id)).toBe('000000000000000000000009');
        expect(saved[0].target.name).toBe('Night RMO');
        expect(saved[0].category).toBe('RECRUITMENT');
    });
});
