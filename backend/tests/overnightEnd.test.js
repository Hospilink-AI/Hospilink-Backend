// A 20:00-08:00 duty ends the next morning. The end code and the move to
// "waiting for the hospital" must wait for that, not for 08:00 on the start date.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));

const Duty = require('../src/models/Duty');

const HOUR = 60 * 60 * 1000;
const day = new Date('2026-10-08T00:00:00.000Z');

function duty(fields) {
    return new Duty({ date: day, startTime: '20:00', endTime: '08:00', status: 'in-progress', ...fields });
}

afterEach(() => jest.useRealTimers());

describe('scheduled end of a duty', () => {
    it('ends the next day when the end time is at or before the start time', () => {
        expect(duty({}).endDayOffset()).toBe(1);
        expect(duty({ isOvernightDuty: true }).endDayOffset()).toBe(1);
        expect(duty({ startTime: '09:00', endTime: '17:00' }).endDayOffset()).toBe(0);
        expect(duty({ startTime: '09:00', endTime: '09:00' }).endDayOffset()).toBe(1);
    });

    it('uses a later endDate when there is one', () => {
        const twoDaysLater = new Date(day.getTime() + 48 * HOUR);
        expect(duty({ startTime: '09:00', endTime: '17:00', endDate: twoDaysLater }).endDayOffset()).toBe(2);
        expect(duty({ endDate: day }).endDayOffset()).toBe(1);
    });

    it('puts an overnight end 24 hours after the same clock time on the start date', () => {
        const sameDay = duty({ startTime: '07:00', endTime: '08:00' }).getScheduledEnd();
        expect(duty({}).getScheduledEnd() - sameDay).toBe(24 * HOUR);
    });

    it('refuses the end code an hour after an overnight duty starts', () => {
        const d = duty({});
        jest.useFakeTimers().setSystemTime(new Date(d.getScheduledEnd().getTime() - 11 * HOUR));
        expect(d.canRequestEndOtp().allowed).toBe(false);
    });

    it('allows the end code once the overnight duty has ended', () => {
        const d = duty({});
        jest.useFakeTimers().setSystemTime(new Date(d.getScheduledEnd().getTime() + 60 * 1000));
        expect(d.canRequestEndOtp().allowed).toBe(true);
    });

    it('keeps day duties as they were', () => {
        const d = duty({ startTime: '09:00', endTime: '17:00' });
        const end = d.getScheduledEnd();
        jest.useFakeTimers().setSystemTime(new Date(end.getTime() - 60 * 1000));
        expect(d.canRequestEndOtp().allowed).toBe(false);
        jest.setSystemTime(new Date(end.getTime()));
        expect(d.canRequestEndOtp().allowed).toBe(true);
    });
});

describe('moving duties to pending confirmation', () => {
    const DutyService = require('../src/services/duty.service');

    function stubFind(duties, captured) {
        Duty.find = (filter) => {
            captured.filter = filter;
            const chain = { populate: () => chain, then: (res, rej) => Promise.resolve(duties).then(res, rej) };
            return chain;
        };
    }

    it('looks back to yesterday and skips an overnight duty that has not ended', async () => {
        const realFind = Duty.find;
        const realBulk = Duty.bulkWrite;
        const captured = {};
        let bulkOps = null;
        Duty.bulkWrite = async (ops) => { bulkOps = ops; return { modifiedCount: ops.length }; };
        const d = duty({});
        d.endOtp = { status: 'NONE' };
        jest.useFakeTimers().setSystemTime(new Date(d.getScheduledEnd().getTime() - 11 * HOUR));
        stubFind([d], captured);
        try {
            await DutyService.moveDutiesToPendingConfirmation();
        } finally {
            Duty.find = realFind;
            Duty.bulkWrite = realBulk;
        }
        const from = captured.filter.date.$gte;
        const to = captured.filter.date.$lt;
        expect(to - from).toBe(48 * HOUR);
        expect(bulkOps === null || bulkOps.length === 0).toBe(true);
    });

    it('moves an overnight duty once its next-morning end and the grace period have passed', async () => {
        const realFind = Duty.find;
        const realBulk = Duty.bulkWrite;
        let bulkOps = null;
        Duty.bulkWrite = async (ops) => { bulkOps = ops; return { modifiedCount: ops.length }; };
        const d = duty({});
        d.endOtp = { status: 'NONE' };
        jest.useFakeTimers().setSystemTime(new Date(d.getScheduledEnd().getTime() + 31 * 60 * 1000));
        stubFind([d], {});
        try {
            await DutyService.moveDutiesToPendingConfirmation();
        } catch (e) {
            // notifications after the write are not under test here
        } finally {
            Duty.find = realFind;
            Duty.bulkWrite = realBulk;
        }
        expect(bulkOps).toHaveLength(1);
        expect(bulkOps[0].updateOne.filter.status).toBe('in-progress');
    });
});
