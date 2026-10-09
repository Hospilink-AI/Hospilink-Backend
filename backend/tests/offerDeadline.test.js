// Every offer has a deadline, and no doctor learns who else was invited.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
jest.mock('../src/services/cache.service', () => ({
    acquireLock: async () => true, releaseLock: async () => true, get: async () => null, set: async () => true, del: async () => true
}));

const mongoose = require('mongoose');
const Duty = require('../src/models/Duty');
const dutyOfferService = require('../src/services/dutyOffer.service');

describe('offer deadline', () => {
    it('is the end of the invite window for an invitee', () => {
        const windowEnd = new Date('2026-10-08T10:30:00Z');
        const duty = { date: new Date('2026-10-08T00:00:00Z'), startTime: '20:00', offer: { mode: 'invite', nextActionAt: windowEnd } };
        expect(dutyOfferService.offerExpiresAt(duty)).toEqual(windowEnd);
    });

    it('is the duty start for open offers, on the IST clock', () => {
        // Stored as UTC midnight or IST midnight of 8 Oct: both start 20:00 IST = 14:30 UTC
        for (const date of [new Date('2026-10-08T00:00:00Z'), new Date('2026-10-07T18:30:00Z')]) {
            expect(dutyOfferService.offerExpiresAt({ date, startTime: '20:00', offer: { mode: 'radius', nextActionAt: new Date() } }))
                .toEqual(new Date('2026-10-08T14:30:00Z'));
        }
    });

    it('is the duty start for an invite that never opens to others, and for duties without an offer', () => {
        const date = new Date('2026-10-08T00:00:00Z');
        expect(dutyOfferService.offerExpiresAt({ date, startTime: '09:15', offer: { mode: 'invite', nextActionAt: null } }))
            .toEqual(new Date('2026-10-08T03:45:00Z'));
        expect(dutyOfferService.offerExpiresAt({ date, startTime: '09:15' })).toEqual(new Date('2026-10-08T03:45:00Z'));
    });
});

describe('invitee privacy', () => {
    it('invited doctors are hidden from every duty read, like the notified list', () => {
        const id = new mongoose.Types.ObjectId();
        const query = Duty.findById(id);
        query._applyPaths();
        expect(query._fields['offer.invitedStaff']).toBe(0);
        expect(query._fields['offer.notifiedStaff']).toBe(0);
    });

    it('an explicit select still reads them', () => {
        const query = Duty.findById(new mongoose.Types.ObjectId()).select('+offer.invitedStaff');
        query._applyPaths();
        expect(query._fields['offer.invitedStaff']).not.toBe(0);
    });
});
