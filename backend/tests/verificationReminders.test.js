// New doctors missing documents get a push and an email on days 1, 3 and 7
// after sign-up, from 10:00 IST, and never again after that.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
jest.mock('../src/services/cache.service', () => ({ get: async () => null, set: async () => true, del: async () => true }));

const mongoose = require('mongoose');
const MedicalStaff = require('../src/models/MedicalStaff');
const User = require('../src/models/User');
const notificationEmitter = require('../src/services/notificationEmitter');
const EmailService = require('../src/services/email.service');
const reminders = require('../src/services/verificationReminder.service');
const { describe: describeNotification } = require('../src/utils/notificationDisplay');

const DAY = 24 * 60 * 60 * 1000;
// 11:00 IST on 20 Oct 2026
const now = new Date('2026-10-20T05:30:00.000Z');

function staff(daysAgo, sentDays = []) {
    const createdAt = new Date(now.getTime() - daysAgo * DAY);
    return {
        _id: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        fullName: 'TEST - Doctor',
        createdAt,
        reminders: sentDays.length
            ? { documents: sentDays.flatMap(d => [{ at: new Date(createdAt.getTime() + d * DAY), channel: 'push' }, { at: new Date(createdAt.getTime() + d * DAY), channel: 'email' }]) }
            : undefined
    };
}

let rows;
let usersWithoutDeletion;
let pushes;
let emails;
let updates;
let findFilter;

beforeEach(() => {
    pushes = [];
    emails = [];
    updates = [];
    MedicalStaff.find = (filter) => {
        findFilter = filter;
        return { select: () => ({ lean: async () => rows }) };
    };
    MedicalStaff.updateOne = async (filter, change) => { updates.push({ filter, change }); };
    User.find = (filter) => ({
        select: () => ({
            lean: async () => filter._id.$in
                .filter(id => usersWithoutDeletion === undefined || usersWithoutDeletion.includes(String(id)))
                .map(id => ({ _id: id, email: 'test@example.com', name: 'TEST' }))
        })
    });
    usersWithoutDeletion = undefined;
    notificationEmitter.emitDocumentsReminder = async (userId) => { pushes.push(userId); };
    EmailService.sendDocumentsReminderEmail = async (email) => { emails.push(email); return true; };
});

describe('documents reminders', () => {
    it('reminds on day 1, day 3 and day 7', async () => {
        rows = [staff(1), staff(3, [1]), staff(7, [1, 3])];
        expect(await reminders.runDue(now)).toBe(3);
        expect(pushes).toHaveLength(3);
        expect(emails).toHaveLength(3);
        expect(updates[0].change.$push['reminders.documents'].$each.map(r => r.channel)).toEqual(['push', 'email']);
    });

    it('does not repeat a reminder on the days between', async () => {
        rows = [staff(2, [1]), staff(5, [1, 3]), staff(0)];
        expect(await reminders.runDue(now)).toBe(0);
    });

    it('stops after the third', async () => {
        rows = [staff(7, [1, 3, 7]), staff(8, [1, 3])];
        expect(await reminders.runDue(now)).toBe(0);
    });

    it('catches up once on a missed day, without sending two', async () => {
        rows = [staff(4)];
        expect(await reminders.runDue(now)).toBe(1);
    });

    it('asks only for unverified doctors without documents, from the last 8 days', async () => {
        rows = [];
        await reminders.runDue(now);
        expect(findFilter).toMatchObject({
            verificationStatus: { $ne: 'verified' },
            isDocumentsUploaded: { $ne: true },
            isDemo: { $ne: true }
        });
        expect(now - findFilter.createdAt.$gte).toBe(8 * DAY);
    });

    it('skips doctors who asked to delete their account', async () => {
        const kept = staff(1);
        rows = [kept, staff(1)];
        usersWithoutDeletion = [String(kept.user)];
        expect(await reminders.runDue(now)).toBe(1);
        expect(pushes).toEqual([String(kept.user)]);
    });

    it('waits until 10:00 IST', async () => {
        rows = [staff(1)];
        expect(await reminders.runDue(new Date('2026-10-20T03:00:00.000Z'))).toBe(0);
    });

    it('records only the push when the email fails', async () => {
        rows = [staff(1)];
        EmailService.sendDocumentsReminderEmail = async () => false;
        await reminders.runDue(now);
        expect(updates[0].change.$push['reminders.documents'].$each.map(r => r.channel)).toEqual(['push']);
    });

    it('opens Documents in the app', () => {
        expect(describeNotification('DOCUMENTS_REMINDER', {}).action.screen).toBe('documents');
    });
});
