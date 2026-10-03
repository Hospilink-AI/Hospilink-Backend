const {
    parsePeriod,
    weekKey,
    bucketKey,
    bucketsBetween,
    seriesFromRows,
    ratio,
    deltaPct,
    percentile,
    median,
    countBy,
    scheduledStart,
    dutyHours
} = require('../src/utils/analytics.helper');

describe('parsePeriod', () => {
    it('defaults to the last 30 days with the 30 before as comparison', () => {
        const p = parsePeriod({}, '2026-10-31');
        expect(p.from).toBe('2026-10-02');
        expect(p.to).toBe('2026-10-31');
        expect(p.days).toBe(30);
        expect(p.granularity).toBe('day');
        expect(p.compareTo).toBe('2026-10-01');
        expect(p.compareFrom).toBe('2026-09-02');
    });

    it('starts and ends on IST midnight', () => {
        const p = parsePeriod({ from: '2026-10-01', to: '2026-10-01' });
        expect(p.start.toISOString()).toBe('2026-09-30T18:30:00.000Z');
        expect(p.end.toISOString()).toBe('2026-10-01T18:30:00.000Z');
    });

    it('picks a coarser granularity for long ranges', () => {
        expect(parsePeriod({ from: '2026-01-01', to: '2026-05-31' }).granularity).toBe('week');
        expect(parsePeriod({ from: '2025-10-01', to: '2026-09-30' }).granularity).toBe('month');
    });

    it('rejects bad input', () => {
        expect(parsePeriod({ from: '2026-10-05', to: '2026-10-01' }).error).toBeDefined();
        expect(parsePeriod({ from: '2024-01-01', to: '2026-01-01' }).error).toBeDefined();
        expect(parsePeriod({ from: '01-10-2026' }).error).toBeDefined();
        expect(parsePeriod({ granularity: 'year' }).error).toBeDefined();
    });
});

describe('buckets', () => {
    it('starts weeks on Monday', () => {
        expect(weekKey('2026-10-04')).toBe('2026-09-28'); // Sunday
        expect(weekKey('2026-10-05')).toBe('2026-10-05'); // Monday
    });

    it('labels by IST day, not UTC', () => {
        // 20:00 UTC on 1 Oct is 01:30 IST on 2 Oct
        expect(bucketKey(new Date('2026-10-01T20:00:00Z'), 'day')).toBe('2026-10-02');
        expect(bucketKey(new Date('2026-10-31T20:00:00Z'), 'month')).toBe('2026-11-01');
    });

    it('lists every bucket in a range', () => {
        expect(bucketsBetween('2026-01-15', '2026-03-02', 'month')).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
        expect(bucketsBetween('2026-10-01', '2026-10-14', 'week')).toEqual(['2026-09-28', '2026-10-05', '2026-10-12']);
    });

    it('zero-fills a series', () => {
        const period = parsePeriod({ from: '2026-10-01', to: '2026-10-03', granularity: 'day' });
        const rows = [
            { at: new Date('2026-10-01T05:00:00Z'), amount: 100 },
            { at: new Date('2026-10-03T05:00:00Z'), amount: 50 },
            { at: new Date('2026-10-03T06:00:00Z'), amount: 25 }
        ];
        const series = seriesFromRows(rows, r => r.at, period, { count: () => 1, amount: r => r.amount });
        expect(series).toEqual([
            { bucket: '2026-10-01', count: 1, amount: 100 },
            { bucket: '2026-10-02', count: 0, amount: 0 },
            { bucket: '2026-10-03', count: 2, amount: 75 }
        ]);
    });
});

describe('numbers', () => {
    it('divides safely', () => {
        expect(ratio(1, 4)).toBe(0.25);
        expect(ratio(1, 0)).toBeNull();
    });

    it('gives the change against the previous period', () => {
        expect(deltaPct(120, 100)).toBe(20);
        expect(deltaPct(5, 0)).toBeNull();
    });

    it('computes median and percentiles', () => {
        expect(median([5, 1, 3])).toBe(3);
        expect(median([1, 2, 3, 4])).toBe(2.5);
        expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9.1);
        expect(median([])).toBeNull();
    });

    it('counts by key, largest first', () => {
        expect(countBy([{ r: 'a' }, { r: 'b' }, { r: 'a' }, { r: null }], x => x.r)).toEqual([
            { key: 'a', count: 2 },
            { key: 'b', count: 1 }
        ]);
    });
});

describe('duty timing', () => {
    it('finds the scheduled start in IST', () => {
        const duty = { date: new Date('2026-10-05T00:00:00Z'), startTime: '09:30' };
        expect(scheduledStart(duty).toISOString()).toBe('2026-10-05T04:00:00.000Z');
    });

    it('derives booked hours from the stored total', () => {
        expect(dutyHours({ offeredRate: 500, totalPayment: 4000 })).toBe(8);
        expect(dutyHours({ offeredRate: 0, totalPayment: 4000 })).toBe(0);
    });
});
