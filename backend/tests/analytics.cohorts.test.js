const { buildCohorts } = require('../src/services/analytics/cohorts');

const at = (iso) => new Date(`${iso}T10:00:00+05:30`);

describe('buildCohorts', () => {
    const firstSeen = new Map([
        ['a', at('2026-07-03')],
        ['b', at('2026-07-20')],
        ['c', at('2026-08-11')],
        ['old', at('2025-01-05')]
    ]);
    const activity = [
        { id: 'a', at: at('2026-07-03') },
        { id: 'b', at: at('2026-07-20') },
        { id: 'a', at: at('2026-08-02') },
        { id: 'a', at: at('2026-09-15') },
        { id: 'b', at: at('2026-09-01') },
        { id: 'c', at: at('2026-08-11') },
        { id: 'old', at: at('2026-09-02') }
    ];

    const result = buildCohorts(firstSeen, activity, '2026-09', 3);

    it('lists one row per month in the window', () => {
        expect(result.rows.map(r => r.cohort)).toEqual(['2026-07', '2026-08', '2026-09']);
    });

    it('measures the share of each cohort active N months later', () => {
        const july = result.rows[0];
        expect(july.size).toBe(2);
        expect(july.retention).toEqual([1, 0.5, 1]);
        expect(result.rows[1].retention).toEqual([1, 0]);
    });

    it('leaves out entities first seen before the window', () => {
        expect(result.rows.reduce((total, r) => total + r.size, 0)).toBe(3);
    });

    it('marks empty cohorts as null rather than 0%', () => {
        expect(result.rows[2]).toEqual({ cohort: '2026-09', size: 0, retention: [null] });
    });

    it('buckets by IST month', () => {
        // 20:00 UTC on 31 Aug is 1 Sep in IST
        const r = buildCohorts(new Map([['x', new Date('2026-08-31T20:00:00Z')]]), [], '2026-09', 2);
        expect(r.rows.map(row => row.size)).toEqual([0, 1]);
    });
});
