const {
    istDateKey,
    isValidDateKey,
    istDayStart,
    addDaysToKey,
    daysBetweenKeys,
    istDayRange,
    hasDutyStarted,
    overnightContinuationKey
} = require('../src/utils/calendar.helper');

describe('istDateKey', () => {
    it('reads a date saved as UTC midnight as that IST day', () => {
        expect(istDateKey(new Date('2027-01-31T00:00:00Z'))).toBe('2027-01-31');
    });

    it('reads a date saved as IST midnight as that IST day', () => {
        expect(istDateKey(new Date('2027-01-30T18:30:00Z'))).toBe('2027-01-31');
    });
});

describe('isValidDateKey', () => {
    it('accepts real dates only', () => {
        expect(isValidDateKey('2026-10-05')).toBe(true);
        expect(isValidDateKey('2026-02-30')).toBe(false);
        expect(isValidDateKey('05-10-2026')).toBe(false);
        expect(isValidDateKey(undefined)).toBe(false);
    });
});

describe('date key arithmetic', () => {
    it('crosses month and year ends', () => {
        expect(addDaysToKey('2027-01-31', 1)).toBe('2027-02-01');
        expect(addDaysToKey('2026-12-31', 1)).toBe('2027-01-01');
        expect(daysBetweenKeys('2027-01-01', '2027-03-01')).toBe(59);
    });

    it('starts an IST day at 18:30 UTC the evening before', () => {
        expect(istDayStart('2026-10-05').toISOString()).toBe('2026-10-04T18:30:00.000Z');
    });

    it('builds an inclusive range that holds both storage forms', () => {
        const range = istDayRange('2027-01-31', '2027-01-31');
        for (const stored of ['2027-01-31T00:00:00Z', '2027-01-30T18:30:00Z']) {
            const d = new Date(stored);
            expect(d >= range.$gte && d < range.$lt).toBe(true);
        }
        expect(new Date('2027-02-01T00:00:00Z') < range.$lt).toBe(false);
    });
});

describe('overnight duty across a month boundary', () => {
    const duty = {
        date: new Date('2027-01-31T00:00:00Z'),
        endDate: new Date('2027-02-01T00:00:00Z'),
        startTime: '23:00',
        endTime: '07:00',
        isOvernightDuty: true
    };

    it('belongs to January and marks 1 February as a continuation', () => {
        expect(istDateKey(duty.date)).toBe('2027-01-31');
        expect(overnightContinuationKey(duty)).toBe('2027-02-01');
    });

    it('is counted once in January and only marked in February', () => {
        const january = istDayRange('2027-01-01', '2027-01-31');
        const february = istDayRange('2027-02-01', '2027-02-28');
        expect(duty.date >= january.$gte && duty.date < january.$lt).toBe(true);
        expect(duty.date >= february.$gte && duty.date < february.$lt).toBe(false);
        expect(overnightContinuationKey(duty) >= '2027-02-01').toBe(true);
    });

    it('falls back to the next day when endDate is missing', () => {
        expect(overnightContinuationKey({ ...duty, endDate: undefined })).toBe('2027-02-01');
    });

    it('gives a day duty no continuation', () => {
        expect(overnightContinuationKey({ ...duty, isOvernightDuty: false })).toBeNull();
    });
});

describe('hasDutyStarted', () => {
    const now = new Date(2026, 9, 5, 10, 0);

    it('treats a duty that started earlier today as started', () => {
        expect(hasDutyStarted({ date: new Date(2026, 9, 5), startTime: '09:30' }, now)).toBe(true);
    });

    it('treats a later start as not started', () => {
        expect(hasDutyStarted({ date: new Date(2026, 9, 5), startTime: '10:30' }, now)).toBe(false);
        expect(hasDutyStarted({ date: new Date(2026, 9, 5), startTime: '02:30 PM' }, now)).toBe(false);
    });
});
