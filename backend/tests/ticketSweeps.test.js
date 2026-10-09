// The ticket SLA sweeps load only some fields. They must load
// resolutionClass (its validator depends on it), check only what they
// changed, and never let one ticket stop the rest.
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/activityLogEmitter', () => ({ emitSystemActivity: async () => {} }));

const fs = require('fs');
const path = require('path');
const Ticket = require('../src/models/Ticket');
const ticketService = require('../src/services/ticket.service');

const source = fs.readFileSync(path.join(__dirname, '../src/services/ticket.service.js'), 'utf8');

test('every sweep loads resolutionClass and saves with modified-only validation', () => {
    const sweeps = source.slice(source.indexOf('async sweepRespondentWindow()'), source.indexOf('// ─── Decision, approval'));
    expect(sweeps.match(/\.select\('ticketId resolutionClass /g)).toHaveLength(3);
    expect(sweeps).not.toMatch(/ticket\.save\(\)/);
    expect(source).toContain('const SWEEP_SAVE = { validateModifiedOnly: true };');
});

test('one ticket that fails to save does not stop the others', async () => {
    const saved = [];
    const ticket = (id, fail) => ({
        ticketId: id,
        priority: 'P3',
        claimedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        pushHistory() {},
        async save(options) {
            if (fail) throw new Error('validation failed');
            saved.push({ id, options });
        }
    });
    Ticket.find = () => ({ select: async () => [ticket('HL-1', true), ticket('HL-2', false)] });
    const result = await ticketService.sweepClaimTimeout();
    expect(result.returned).toBe(1);
    expect(saved).toEqual([{ id: 'HL-2', options: { validateModifiedOnly: true } }]);
});
