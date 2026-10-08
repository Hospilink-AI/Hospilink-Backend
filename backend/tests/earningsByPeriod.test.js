// Earnings by week or month, with what the hospitals have paid and what is pending.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
jest.mock('../src/services/cache.service', () => ({
    acquireLock: async () => true, releaseLock: async () => true, get: async () => null, set: async () => true, del: async () => true
}));

const mongoose = require('mongoose');
const Duty = require('../src/models/Duty');
const DashboardService = require('../src/services/dashboard.service');
const { validateEarningsQuery } = require('../src/middleware/validation.middleware');

const staffId = new mongoose.Types.ObjectId();
let aggregateCalls;
let findFilter;

const duty = (completedAt, totalPayment, isPaid, paymentMethod = null) => ({ completedAt: new Date(completedAt), totalPayment, isPaid, paymentMethod });

beforeEach(() => {
    aggregateCalls = 0;
    Duty.aggregate = async () => {
        aggregateCalls++;
        return [{
            allTime: [{ total: 9000, count: 6 }],
            thisMonth: [{ total: 3000, count: 2 }],
            lastMonth: [{ total: 1500, count: 1 }],
            payment: [{ paid: 6000, pending: 2000 }]
        }];
    };
    Duty.find = (filter) => {
        findFilter = filter;
        const rows = [
            duty('2026-08-10T06:00:00Z', 1500, true, 'upi'),
            duty('2026-09-05T06:00:00Z', 1500, false, 'will_pay_later'),
            duty('2026-10-01T06:00:00Z', 2000, true, 'cash'),
            duty('2026-10-06T06:00:00Z', 1000, null, null),
            duty('2026-10-07T20:00:00Z', 500, false, null) // 8 Oct in IST
        ];
        return { select: () => ({ lean: async () => rows }) };
    };
});

describe('earnings', () => {
    it('keeps the old fields and adds paid and pending, in one query', async () => {
        const result = await DashboardService.getEarnings(staffId);
        expect(aggregateCalls).toBe(1);
        expect(result).toMatchObject({
            totalEarnings: 9000,
            completedDutiesCount: 6,
            averagePerDuty: 1500,
            thisMonthEarnings: 3000,
            lastMonthEarnings: 1500,
            growth: { percent: 100, trend: 'up', label: '+100%' },
            paid: 6000,
            pending: 2000
        });
        expect(result.series).toBeUndefined();
    });

    it('builds a month series with empty months and the period split', async () => {
        const result = await DashboardService.getEarnings(staffId, { period: 'month', from: '2026-07-01', to: '2026-10-31' });
        expect(result.series).toEqual([
            { key: '2026-07-01', label: 'Jul 2026', earnings: 0, duties: 0 },
            { key: '2026-08-01', label: 'Aug 2026', earnings: 1500, duties: 1 },
            { key: '2026-09-01', label: 'Sep 2026', earnings: 1500, duties: 1 },
            { key: '2026-10-01', label: 'Oct 2026', earnings: 3500, duties: 3 }
        ]);
        expect(result.paid).toBe(3500);
        expect(result.pending).toBe(2000);
        expect(findFilter.status).toBe('completed');
    });

    it('builds a week series on IST days', async () => {
        const result = await DashboardService.getEarnings(staffId, { period: 'week', from: '2026-10-05', to: '2026-10-11' });
        expect(result.series).toEqual([{ key: '2026-10-05', label: '5 Oct', earnings: 1500, duties: 2 }]);
    });

    it('defaults to the last 6 months or 8 weeks', () => {
        expect(DashboardService.earningsRange('month', undefined, '2026-10-08')).toEqual({ from: '2026-05-01', to: '2026-10-08' });
        expect(DashboardService.earningsRange('week', undefined, '2026-10-08')).toEqual({ from: '2026-08-14', to: '2026-10-08' });
    });
});

describe('earnings query', () => {
    function validate(query) {
        let passed = false;
        let body = null;
        const res = { status: () => res, json: (b) => { body = b; return res; } };
        validateEarningsQuery({ query }, res, () => { passed = true; });
        return { passed, errors: body ? body.errors : [] };
    }

    it('accepts the old call and the new periods', () => {
        expect(validate({}).passed).toBe(true);
        expect(validate({ period: 'week' }).passed).toBe(true);
        expect(validate({ period: 'month', from: '2026-01-01', to: '2026-10-31' }).passed).toBe(true);
    });

    it.each([
        [{ period: 'day' }, 'period must be week or month'],
        [{ from: '2026-01-01' }, 'from and to need a period'],
        [{ period: 'month', from: '2026-13-01' }, 'from must be a date in YYYY-MM-DD format'],
        [{ period: 'month', from: '2026-10-31', to: '2026-10-01' }, 'from cannot be after to'],
        [{ period: 'month', from: '2024-01-01', to: '2026-10-01' }, 'The range cannot be longer than 400 days']
    ])('refuses %j', (query, message) => {
        expect(validate(query).errors).toContain(message);
    });
});
