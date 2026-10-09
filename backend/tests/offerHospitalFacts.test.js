// The offer card shows the hospital's locality, whether it is verified and its rating.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
jest.mock('../src/services/cache.service', () => ({
    acquireLock: async () => true, releaseLock: async () => true, get: async () => null, set: async () => true, del: async () => true
}));

const mongoose = require('mongoose');
const ratingAlgorithmService = require('../src/services/ratingAlgorithm.service');
const feed = require('../src/services/locationBasedStaff.service');
const { areaFromAddress } = feed;

describe('hospital locality', () => {
    it.each([
        ['12 MG Road, Kothrud, Pune 411038', 'Pune', 'Maharashtra', 'Kothrud'],
        ['Plot 4, Sector 17, Vashi, Navi Mumbai, Maharashtra, 400703', 'Navi Mumbai', 'Maharashtra', 'Vashi'],
        ['Baner Road, Baner, Pune, Maharashtra, India', 'Pune', 'Maharashtra', 'Baner'],
        ['Kothrud', 'Pune', 'Maharashtra', null],
        ['', 'Pune', 'Maharashtra', null]
    ])('%s -> %s', (address, city, state, area) => {
        expect(areaFromAddress(address, city, state)).toBe(area);
    });
});

describe('hospital facts on offers', () => {
    const a = new mongoose.Types.ObjectId();
    const b = new mongoose.Types.ObjectId();
    const hospital = (id, extra) => ({
        _id: id, hospitalLegalName: 'TEST - Hospital', city: 'Pune', state: 'Maharashtra',
        currentAddress: '1 Main Road, Aundh, Pune', user: new mongoose.Types.ObjectId(), verificationStatus: 'verified',
        averageRating: 4.6, totalRatings: 12, coordinates: { coordinates: { latitude: 18.5, longitude: 73.8 } }, ...extra
    });

    it('rates every hospital in one batch and keeps private fields out', async () => {
        const calls = [];
        ratingAlgorithmService.getEffectiveRatingsForMany = async (profiles, type) => {
            calls.push({ count: profiles.length, type });
            return profiles.map((p, i) => ({ ratingShown: i === 0 ? 4.4 : null }));
        };
        const jobs = [
            { _id: 1, hospital: hospital(a) },
            { _id: 2, hospital: hospital(a) },
            { _id: 3, hospital: hospital(b, { totalRatings: 0, verificationStatus: 'pending' }) }
        ];
        await feed.attachHospitalFacts(jobs);
        expect(calls).toEqual([{ count: 2, type: 'staff_to_hospital' }]);
        expect(jobs[0].hospital).toMatchObject({ area: 'Aundh', verificationStatus: 'verified', effectiveRating: 4.4, totalRatings: 12, hospitalLegalName: 'TEST - Hospital', city: 'Pune' });
        expect(jobs[1].hospital.effectiveRating).toBe(4.4);
        expect(jobs[2].hospital).toMatchObject({ verificationStatus: 'pending', effectiveRating: null, totalRatings: 0 });
        for (const job of jobs) {
            expect(job.hospital.user).toBeUndefined();
            expect(job.hospital.currentAddress).toBeUndefined();
            expect(job.hospital.coordinates).toBeDefined();
        }
    });

    it('still shows offers when ratings fail', async () => {
        ratingAlgorithmService.getEffectiveRatingsForMany = async () => { throw new Error('down'); };
        const jobs = [{ _id: 1, hospital: hospital(a) }];
        jest.spyOn(console, 'error').mockImplementation(() => {});
        await feed.attachHospitalFacts(jobs);
        expect(jobs[0].hospital).toMatchObject({ area: 'Aundh', effectiveRating: null });
    });
});
