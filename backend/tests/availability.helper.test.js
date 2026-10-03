const { resolveDay, isFreeFor, weekdayOf } = require('../src/utils/availability.helper');

// 5 Oct 2026 is a Monday
const availability = {
    weekly: [
        { day: 1, from: '08:00', to: '20:00' },  // Mondays, daytime
        { day: 3 }                               // Wednesdays, all day
    ],
    validUntil: new Date('2026-11-30T18:29:00Z'), // 30 Nov IST
    exceptions: [
        { date: '2026-10-12', status: 'busy' },                       // a Monday off
        { date: '2026-10-10', status: 'free', from: '18:00', to: '23:59' } // an extra Saturday evening
    ]
};

describe('resolveDay', () => {
    it('knows the weekday of an IST date', () => {
        expect(weekdayOf('2026-10-05')).toBe(1);
    });

    it('uses the weekly pattern', () => {
        expect(resolveDay(availability, '2026-10-05')).toEqual({ status: 'free', from: '08:00', to: '20:00', source: 'weekly' });
        expect(resolveDay(availability, '2026-10-07').status).toBe('free');
    });

    it('lets an exception beat the pattern', () => {
        expect(resolveDay(availability, '2026-10-12')).toMatchObject({ status: 'busy', source: 'exception' });
        expect(resolveDay(availability, '2026-10-10')).toMatchObject({ status: 'free', from: '18:00', source: 'exception' });
    });

    it('says unknown for days the doctor said nothing about', () => {
        expect(resolveDay(availability, '2026-10-06').status).toBe('unknown');
        expect(resolveDay(null, '2026-10-06').status).toBe('unknown');
    });

    it('stops using the pattern after it expires', () => {
        expect(resolveDay(availability, '2026-11-30').status).toBe('free');      // last day, a Monday
        expect(resolveDay(availability, '2026-12-07').status).toBe('unknown');   // a Monday after expiry
    });
});

describe('isFreeFor', () => {
    it('needs the shift inside the hours given', () => {
        expect(isFreeFor(availability, '2026-10-05', '09:00', '17:00')).toBe(true);
        expect(isFreeFor(availability, '2026-10-05', '07:00', '15:00')).toBe(false);
        expect(isFreeFor(availability, '2026-10-05', '14:00', '22:00')).toBe(false);
    });

    it('treats a day without hours as free all day', () => {
        expect(isFreeFor(availability, '2026-10-07', '22:00', '06:00')).toBe(true);
    });

    it('handles an overnight shift from a free evening', () => {
        expect(isFreeFor(availability, '2026-10-10', '20:00', '06:00')).toBe(true);
    });

    it('is never free on a busy or unknown day', () => {
        expect(isFreeFor(availability, '2026-10-12', '09:00', '17:00')).toBe(false);
        expect(isFreeFor(availability, '2026-10-06', '09:00', '17:00')).toBe(false);
    });
});
