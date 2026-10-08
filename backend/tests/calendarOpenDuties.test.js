// The calendar's day view lists that date's open duties without any Maps call,
// using the same rules as the open count on the calendar grid.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
jest.mock('../src/services/cache.service', () => ({
    acquireLock: async () => true, releaseLock: async () => true, get: async () => null, set: async () => true, del: async () => true
}));

const mongoose = require('mongoose');
const Duty = require('../src/models/Duty');
const MedicalStaff = require('../src/models/MedicalStaff');
const geocodingService = require('../src/services/geocoding.service');
const locationBasedStaffService = require('../src/services/locationBasedStaff.service');
const blockService = require('../src/services/block.service');
const dutyOfferService = require('../src/services/dutyOffer.service');
const calendar = require('../src/services/dutyCalendar.service');
const { validateCalendarDayQuery } = require('../src/middleware/validation.middleware');

const staffId = new mongoose.Types.ObjectId();
const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const HERE = { latitude: 18.52, longitude: 73.85 };

const hospital = (lat, lng) => ({ _id: new mongoose.Types.ObjectId(), hospitalLegalName: 'TEST - Hospital', city: 'Pune', state: 'Maharashtra', coordinates: { coordinates: { latitude: lat, longitude: lng } } });
const open = (startTime, h, extra = {}) => ({
    _id: new mongoose.Types.ObjectId(), date: new Date(`${tomorrow}T00:00:00Z`), startTime, endTime: '20:00',
    staffRole: 'rmo', urgency: 'medium', offeredRate: 200, totalPayment: 1600, hospital: h, ...extra
});

let mapsCalls;
let openRows;
beforeEach(() => {
    mapsCalls = 0;
    geocodingService.calculateBatchDistanceAndETA = async () => { mapsCalls++; return { resultMap: new Map(), totalApiCalls: 1 }; };
    geocodingService.calculateDistanceAndETA = async () => { mapsCalls++; return {}; };
    MedicalStaff.findOne = () => ({ select: () => ({ lean: async () => ({ _id: staffId, jobRole: 'rmo', city: 'Pune' }) }) });
    locationBasedStaffService.getStaffCurrentLocation = async () => HERE;
    blockService.hospitalsHiddenFrom = async () => [];
    dutyOfferService.notifiedAmong = async () => new Set();
    openRows = [
        open('14:00', hospital(18.53, 73.86)), // ~1.5 km
        open('09:00', hospital(18.60, 73.90)), // ~10 km
        open('10:00', hospital(19.50, 73.85)) // ~110 km, too far
    ];
    Duty.find = (filter) => {
        const rows = filter.status === 'available' ? openRows : [];
        const chain = { select: () => chain, populate: () => chain, sort: () => chain, lean: async () => rows };
        return chain;
    };
});

describe('calendar day with open duties', () => {
    it('lists nearby open duties by start time with a straight-line distance', async () => {
        const day = await calendar.getDay({ id: 'u1', role: 'staff' }, tomorrow, { include: 'open' });
        expect(day.open.map(d => d.startTime)).toEqual(['09:00', '14:00']);
        expect(day.open[0].distanceKm).toBeGreaterThan(5);
        expect(day.open[1].distanceKm).toBeLessThan(3);
        expect(day.open[0]).toMatchObject({ status: 'available', staffRole: 'rmo', hospital: { name: 'TEST - Hospital', city: 'Pune' } });
        expect(mapsCalls).toBe(0);
    });

    it('leaves the day as it was without include', async () => {
        const day = await calendar.getDay({ id: 'u1', role: 'staff' }, tomorrow);
        expect(day.open).toBeUndefined();
        expect(day.duties).toEqual([]);
    });

    it('lists nothing when the doctor has no position', async () => {
        locationBasedStaffService.getStaffCurrentLocation = async () => { throw new Error('none'); };
        const day = await calendar.getDay({ id: 'u1', role: 'staff' }, tomorrow, { include: 'open' });
        expect(day.open).toEqual([]);
    });

    it('matches the count on the calendar grid', async () => {
        const { days } = await calendar._staffCounts('u1', tomorrow, tomorrow);
        expect(days[0].open).toBe(2);
    });

    it('accepts include=open and nothing else', () => {
        const run = (query) => {
            let passed = false;
            const res = { status: () => res, json: () => res };
            validateCalendarDayQuery({ query }, res, () => { passed = true; });
            return passed;
        };
        expect(run({ date: tomorrow })).toBe(true);
        expect(run({ date: tomorrow, include: 'open' })).toBe(true);
        expect(run({ date: tomorrow, include: 'all' })).toBe(false);
    });
});
