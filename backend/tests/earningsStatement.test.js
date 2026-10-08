// The history summary, the statement and the receipt must cover every completed
// duty, not the latest page of ten, and must carry the payment the hospital recorded.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
jest.mock('../src/services/cache.service', () => ({
    acquireLock: async () => true, releaseLock: async () => true, get: async () => null, set: async () => true, del: async () => true
}));
jest.mock('../src/utils/pdf.puppeteer', () => ({
    generateEarningsPDF: jest.fn(async (res, data) => data),
    generateDutyReceiptPDF: jest.fn(async (res, data) => data)
}));

const mongoose = require('mongoose');
const Duty = require('../src/models/Duty');
const MedicalStaff = require('../src/models/MedicalStaff');
const User = require('../src/models/User');
const reviewService = require('../src/services/review.service');
const DutyService = require('../src/services/duty.service');
const { generateEarningsPDF, generateDutyReceiptPDF } = require('../src/utils/pdf.puppeteer');

const staffId = new mongoose.Types.ObjectId();

// Twelve completed duties of 8 hours at 1,000 each, in October 2026
const completed = Array.from({ length: 12 }, (_, i) => ({
    _id: new mongoose.Types.ObjectId(),
    status: 'completed',
    date: new Date(Date.UTC(2026, 9, i + 1)),
    completedAt: new Date(Date.UTC(2026, 9, i + 1, 12)),
    startTime: '09:00',
    endTime: '17:00',
    isOvernightDuty: false,
    staffRole: 'rmo',
    offeredRate: 125,
    totalPayment: 1000,
    isPaid: i < 5 ? true : (i < 8 ? false : null),
    paymentMethod: i < 5 ? 'upi' : (i < 8 ? 'will_pay_later' : null),
    hospital: { hospitalLegalName: 'TEST - Hospital' }
}));

// A chainable stand-in for a Mongoose query that resolves to `result`
function query(result, calls) {
    const chain = {};
    for (const m of ['select', 'populate', 'sort', 'skip', 'limit', 'lean']) {
        chain[m] = (...args) => { if (calls) calls.push([m, ...args]); return chain; };
    }
    chain.then = (res, rej) => Promise.resolve(result).then(res, rej);
    return chain;
}

let findFilters;
beforeEach(() => {
    findFilters = [];
    generateEarningsPDF.mockClear();
    generateDutyReceiptPDF.mockClear();
    MedicalStaff.findOne = () => query({ _id: staffId });
    User.findById = () => query({ name: 'TEST - Doctor', email: 'test@example.com', role: 'staff' });
    reviewService.getVisibleReviewPairsForDuties = async () => new Map();
    Duty.countDocuments = async () => 15;
    Duty.find = (filter) => {
        findFilters.push(filter);
        let rows = completed;
        if (filter.$or) {
            const range = filter.$or[0].completedAt;
            rows = completed.filter(d => (!range.$gte || d.completedAt >= range.$gte) && (!range.$lt || d.completedAt < range.$lt));
        }
        return query(rows);
    };
    Duty.findOne = (filter) => query(completed.find(d => String(d._id) === String(filter._id)) || null);
});

describe('history summary', () => {
    it('adds up every completed duty, not the current page', async () => {
        Duty.find = (filter) => {
            findFilters.push(filter);
            // the page query asks for terminal statuses and gets just two rows
            return query(filter.status === 'completed' ? completed : completed.slice(0, 2));
        };
        const result = await DutyService.getCompletedDutiesForStaff('user-1', 1, 2);
        expect(result.summary.totalDutiesCompleted).toBe(12);
        expect(result.summary.totalEarnings).toBe(12000);
        expect(result.summary.totalHours).toBe('96h 0m');
        expect(result.summary.paidEarnings).toBe(5000);
        expect(result.summary.pendingEarnings).toBe(3000);
        expect(result.duties).toHaveLength(2);
    });

    it('sends the payment on each item', async () => {
        const result = await DutyService.getCompletedDutiesForStaff('user-1', 1, 12);
        const [paid] = result.duties;
        expect(paid.paymentMethod).toBe('upi');
        expect(paid.isPaid).toBe(true);
        expect(paid.paymentStatus).toBe('paid');
        expect(result.duties[6].paymentStatus).toBe('pending');
        expect(result.duties[10].paymentStatus).toBe('unconfirmed');
        expect(result.duties[10].isPaid).toBeNull();
    });
});

describe('statement', () => {
    it('lists all twelve duties of the month, completed only', async () => {
        await DutyService.generateStatement('user-1', { startDate: '2026-10-01', endDate: '2026-10-31' }, {});
        const data = generateEarningsPDF.mock.calls[0][1];
        expect(data.totalDuties).toBe(12);
        expect(data.totalEarnings).toBe(12000);
        expect(data.totalHours).toBe('96h 0m');
        expect(findFilters[0].status).toBe('completed');
        expect(data.data[0].rate).toBe(125);
        expect(data.data[0].paymentStatus).toBe('paid');
    });

    it('includes the last day of the range', async () => {
        await DutyService.generateStatement('user-1', { startDate: '2026-10-12', endDate: '2026-10-12' }, {});
        expect(generateEarningsPDF.mock.calls[0][1].totalDuties).toBe(1);
    });

    it('covers all time without a range', async () => {
        await DutyService.generateStatement('user-1', {}, {});
        const data = generateEarningsPDF.mock.calls[0][1];
        expect(data.period).toBe('All Time');
        expect(data.totalDuties).toBe(12);
        expect(findFilters[0].$or).toBeUndefined();
    });
});

describe('receipt', () => {
    it('works for a duty older than the latest ten', async () => {
        const oldest = completed[11];
        await DutyService.generateStatement('user-1', { dutyId: String(oldest._id) }, {});
        expect(generateDutyReceiptPDF).toHaveBeenCalledTimes(1);
    });

    it('prints the payment the hospital recorded', async () => {
        await DutyService.generateStatement('user-1', { dutyId: String(completed[0]._id) }, {});
        const data = generateDutyReceiptPDF.mock.calls[0][1];
        expect(data.payment.method).toBe('upi');
        expect(data.payment.status).toBe('Paid');
        expect(data.rate).toBe(125);
        expect(data.time.duration).toBe('8h 0m');
    });

    it('is refused for a duty that is not the doctor\'s completed duty', async () => {
        await expect(DutyService.generateStatement('user-1', { dutyId: String(new mongoose.Types.ObjectId()) }, {}))
            .rejects.toThrow('Duty not found');
    });
});
