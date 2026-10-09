jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
const mockCleared = [];
jest.mock('../src/services/cache.service', () => ({
    invalidateAllNearbyStaff: async () => { mockCleared.push('nearby:staff'); },
    get: async () => null, set: async () => true, del: async () => true
}));
const mockTickets = [];
jest.mock('../src/services/ticket.service', () => ({
    createTicket: async (user, data) => { mockTickets.push({ user, data }); return { ticketId: 'HL-ACC-1', _id: 't1' }; }
}));

const Hospital = require('../src/models/Hospital');
const MedicalStaff = require('../src/models/MedicalStaff');
const Duty = require('../src/models/Duty');
const Review = require('../src/models/Review');
const blockService = require('../src/services/block.service');
const dutyOfferService = require('../src/services/dutyOffer.service');
const dutyInviteService = require('../src/services/dutyInvite.service');
const contentReport = require('../src/services/contentReport.service');

const lean = (v) => ({ select: () => ({ lean: async () => v }), lean: async () => v });

// h1 blocked s1; s2 blocked h2
const world = {
    hospitals: { h1: { _id: 'h1', user: 'hu1', blockedStaff: ['s1'] }, h2: { _id: 'h2', user: 'hu2', blockedStaff: [] } },
    staff: { s1: { _id: 's1', user: 'su1', blockedHospitals: [] }, s2: { _id: 's2', user: 'su2', blockedHospitals: ['h2'] } }
};
let updates;

beforeEach(() => {
    updates = [];
    mockCleared.length = 0;
    mockTickets.length = 0;
    Hospital.findById = (id) => lean(world.hospitals[id] || null);
    MedicalStaff.findById = (id) => lean(world.staff[id] || null);
    Hospital.find = (q) => ({ distinct: async () => Object.values(world.hospitals).filter(h => h.blockedStaff.includes(q.blockedStaff)).map(h => h._id) });
    MedicalStaff.find = (q) => ({ distinct: async () => Object.values(world.staff).filter(s => s.blockedHospitals.includes(q.blockedHospitals)).map(s => s._id) });
    Hospital.exists = async (q) => world.hospitals[q._id]?.blockedStaff.includes(q.blockedStaff) || null;
    MedicalStaff.exists = async (q) => world.staff[q._id]?.blockedHospitals.includes(q.blockedHospitals) || null;
    Hospital.findOne = (q) => lean(Object.values(world.hospitals).find(h => h.user === q.user) || null);
    MedicalStaff.findOne = (q) => lean(Object.values(world.staff).find(s => s.user === q.user) || null);
    Hospital.updateOne = async (q, u) => { updates.push(['hospital', q._id, u]); };
    MedicalStaff.updateOne = async (q, u) => { updates.push(['staff', q._id, u]); };
    Duty.countDocuments = async () => 1;
});

describe('who is hidden from whom', () => {
    it('works in both directions', async () => {
        expect(await blockService.staffHiddenFrom('h1')).toEqual(['s1']);
        expect(await blockService.staffHiddenFrom('h2')).toEqual(['s2']);
        expect(await blockService.hospitalsHiddenFrom('s1')).toEqual(['h1']);
        expect(await blockService.hospitalsHiddenFrom('s2')).toEqual(['h2']);
        expect(await blockService.isBlocked('h1', 's1')).toBe(true);
        expect(await blockService.isBlocked('h2', 's2')).toBe(true);
        expect(await blockService.isBlocked('h1', 's2')).toBe(false);
    });

    it('a blocked pair cannot see or accept each other\'s duties, old or staged', async () => {
        expect(await dutyOfferService.isEligible({ hospital: 'h1' }, { _id: 's1' })).toBe(false);
        expect(await dutyOfferService.isEligible({ hospital: { _id: 'h2' } }, { _id: 's2' })).toBe(false);
        expect(await dutyOfferService.isEligible({ hospital: 'h1' }, { _id: 's2' })).toBe(true);
    });
});

describe('blocking', () => {
    it('a doctor blocking a hospital also leaves its favourites and refreshes its map', async () => {
        const result = await blockService.blockHospital('su1', 'h2');
        expect(updates).toEqual([
            ['staff', 's1', { $addToSet: { blockedHospitals: 'h2' } }],
            ['hospital', 'h2', { $pull: { favouriteStaff: 's1' } }]
        ]);
        expect(mockCleared).toEqual(['nearby:staff']);
        expect(result.upcomingDuties).toBe(1);
    });

    it('a hospital blocking a doctor removes them from favourites', async () => {
        await blockService.blockStaff('hu2', 's1');
        expect(updates).toEqual([['hospital', 'h2', { $addToSet: { blockedStaff: 's1' }, $pull: { favouriteStaff: 's1' } }]]);
        expect(mockCleared).toEqual(['nearby:staff']);
    });

    it('stops at 500 blocked accounts', async () => {
        world.hospitals.h2.blockedStaff = Array.from({ length: 500 }, (_, i) => `x${i}`);
        await expect(blockService.blockStaff('hu2', 's1')).rejects.toThrow('up to 500');
        world.hospitals.h2.blockedStaff = [];
    });
});

describe('invites', () => {
    it('refuses to invite a blocked doctor', async () => {
        await expect(dutyInviteService.resolveInvitees(['s1'], 'Doctor', { hospitalId: 'h1' }))
            .rejects.toThrow('can no longer be invited');
    });
});

describe('reporting a review', () => {
    it('opens a rating challenge against the author', async () => {
        Review.findById = () => lean({ _id: 'r1', duty: 'd1', reviewType: 'hospital_to_staff', hospital: 'h1', medicalStaff: 's1' });
        const result = await contentReport.reportReview({ _id: 'su1', role: 'staff' }, 'r1', ' rude and untrue ');
        expect(mockTickets[0].data).toEqual({
            category: 'account.rating_challenge',
            subjectType: 'DUTY',
            subjectId: 'd1',
            raisedAgainst: { userId: 'hu1', role: 'hospital' },
            text: 'Reported review r1: rude and untrue'
        });
        expect(result.ticketId).toBe('HL-ACC-1');
    });

    it('refuses your own review, a hidden review, and an empty reason', async () => {
        Review.findById = () => lean({ _id: 'r1', duty: 'd1', reviewType: 'staff_to_hospital', hospital: 'h1', medicalStaff: 's1' });
        await expect(contentReport.reportReview({ _id: 'su1', role: 'staff' }, 'r1', 'x')).rejects.toThrow('your own review');
        await expect(contentReport.reportReview({ _id: 'hu1', role: 'hospital' }, 'r1', '  ')).rejects.toThrow('what is wrong');
        Review.findById = () => lean({ _id: 'r1', suppressed: true });
        await expect(contentReport.reportReview({ _id: 'hu1', role: 'hospital' }, 'r1', 'x')).rejects.toThrow('not found');
        expect(mockTickets).toEqual([]);
    });
});
