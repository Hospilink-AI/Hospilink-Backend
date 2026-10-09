// The ticket SLA sweeps against a real database. They load only some fields
// and save; MongoDB plus Mongoose validation is what failed before.
jest.setTimeout(180000);
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/services/notificationEmitter', () => new Proxy({}, { get: () => async () => {} }));
jest.mock('../../src/services/activityLogEmitter', () => new Proxy({}, { get: () => async () => {} }));

const mongoose = require('mongoose');
const db = require('./db');
const Ticket = require('../../src/models/Ticket');
const ticketService = require('../../src/services/ticket.service');
const logger = require('../../src/utils/logger');

const HOUR = 60 * 60 * 1000;
const party = () => ({ user: new mongoose.Types.ObjectId(), role: 'staff', name: 'TEST' });

function adjudicatedTicket(overrides = {}) {
    const now = Date.now();
    return {
        ticketId: `HL-TST-${Math.random().toString(36).slice(2, 8)}`,
        category: 'duty.no_show_staff',
        domain: 'duty',
        resolutionClass: 'ADJUDICATED',
        queue: 'OPERATIONS',
        status: 'AWAITING_RESPONDENT',
        priority: 'P3',
        raisedBy: party(),
        raisedAgainst: party(),
        description: 'TEST ticket',
        respondentNotifiedAt: new Date(now - 72 * HOUR),
        respondentDeadline: new Date(now - HOUR),
        respondentStatement: { submittedAt: null, lapsed: false },
        reminders: {},
        statusHistory: [],
        slaPausedMs: 0,
        createdAt: new Date(now - 72 * HOUR),
        ...overrides
    };
}

beforeAll(db.start);
afterAll(db.stop);
beforeEach(async () => {
    await db.clear();
    logger.error.mockClear();
});

test('an adjudicated ticket past its response window lapses and moves to review', async () => {
    const doc = adjudicatedTicket();
    await db.raw(Ticket, doc);

    const result = await ticketService.sweepRespondentWindow();

    expect(result.lapsed).toBe(1);
    expect(logger.error).not.toHaveBeenCalled();
    const stored = await Ticket.findOne({ ticketId: doc.ticketId }).lean();
    expect(stored.status).toBe('IN_REVIEW');
    expect(stored.respondentStatement.lapsed).toBe(true);
});

test('a claimed ticket left too long goes back to the queue', async () => {
    const doc = adjudicatedTicket({
        status: 'IN_REVIEW',
        assignedTo: new mongoose.Types.ObjectId(),
        claimedAt: new Date(Date.now() - 30 * 24 * HOUR),
        respondentNotifiedAt: null
    });
    await db.raw(Ticket, doc);

    const result = await ticketService.sweepClaimTimeout();

    expect(result.returned).toBe(1);
    const stored = await Ticket.findOne({ ticketId: doc.ticketId }).lean();
    expect(stored.status).toBe('NEW');
    expect(stored.assignedTo).toBeNull();
});
