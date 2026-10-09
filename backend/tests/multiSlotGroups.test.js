// A post with staff_count 3 makes three duties that share a groupId, and the
// feed says how many of the group's spots are still open.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
jest.mock('../src/services/cache.service', () => ({
    acquireLock: async () => true, releaseLock: async () => true, get: async () => null, set: async () => true, del: async () => true
}));

const mongoose = require('mongoose');
const Duty = require('../src/models/Duty');
const feed = require('../src/services/locationBasedStaff.service');

describe('multi-slot posts', () => {
    it('groupId is indexed sparsely and absent on single duties', () => {
        const index = Duty.schema.indexes().find(([fields]) => fields.groupId === 1);
        expect(index[1].sparse).toBe(true);
        expect(new Duty({}).toObject().groupId).toBeUndefined();
    });

    it('the hospital and admin create paths give the slots one groupId', () => {
        const fs = require('fs');
        const path = require('path');
        for (const file of ['../src/controllers/duty.controller.js', '../src/services/admin.service.js']) {
            const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
            expect(source).toMatch(/if \(numberOfDuties > 1\) \{\s+dutyData\.groupId = new mongoose\.Types\.ObjectId\(\);/);
        }
    });

    it('the feed adds spotsTotal and spotsOpen for grouped duties in one query', async () => {
        const groupId = new mongoose.Types.ObjectId();
        let calls = 0;
        let pipeline;
        Duty.aggregate = async (p) => {
            calls++;
            pipeline = p;
            return [{ _id: groupId, total: 3, open: 2 }];
        };
        const jobs = [{ _id: 'a', groupId }, { _id: 'b', groupId }, { _id: 'c' }];
        await feed.attachSpots(jobs);
        expect(calls).toBe(1);
        expect(pipeline[0].$match.groupId.$in.map(String)).toEqual([String(groupId)]);
        expect(jobs[0]).toMatchObject({ spotsTotal: 3, spotsOpen: 2 });
        expect(jobs[1]).toMatchObject({ spotsTotal: 3, spotsOpen: 2 });
        expect(jobs[2].spotsTotal).toBeUndefined();
    });

    it('makes no query when nothing is grouped', async () => {
        let calls = 0;
        Duty.aggregate = async () => { calls++; return []; };
        await feed.attachSpots([{ _id: 'a' }]);
        expect(calls).toBe(0);
    });

    it('does not count cancelled slots as spots', async () => {
        const groupId = new mongoose.Types.ObjectId();
        let pipeline;
        Duty.aggregate = async (p) => { pipeline = p; return []; };
        await feed.attachSpots([{ groupId }]);
        expect(JSON.stringify(pipeline[1].$group.total)).toContain('cancelled');
    });
});
