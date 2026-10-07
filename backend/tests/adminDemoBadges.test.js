jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
jest.mock('../src/services/cache.service', () => ({ get: async () => null, set: async () => true, del: async () => true }));

const Hospital = require('../src/models/Hospital');
const MedicalStaff = require('../src/models/MedicalStaff');
const Duty = require('../src/models/Duty');
const adminService = require('../src/services/admin.service');
const dutyService = require('../src/services/duty.service');

// The $project stage inside the list's $facet data branch
function listProjection(pipeline) {
    const facet = pipeline.find(stage => stage.$facet).$facet;
    return facet.data.find(stage => stage.$project).$project;
}

describe('Super Admin demo badges', () => {
    it('the hospital list sends isDemo as a true/false flag, and the hospital userId', async () => {
        let pipeline;
        Hospital.aggregate = async (p) => { pipeline = p; return [{ data: [], totalCount: [] }]; };
        await adminService.getHospitalList({});
        const project = listProjection(pipeline);
        expect(project.isDemo).toEqual({ $eq: ['$isDemo', true] });
        expect(project.userId).toBe('$user');
    });

    it('the doctor list sends isDemo', async () => {
        let pipeline;
        MedicalStaff.aggregate = async (p) => { pipeline = p; return [{ data: [], totalCount: [] }]; };
        await adminService.getMedicalStaffListWithFilters({});
        expect(listProjection(pipeline).isDemo).toEqual({ $eq: ['$isDemo', true] });
    });

    it('the emergency dashboard marks demo duties, and only those', async () => {
        const duty = (id, extra) => ({
            _id: id, date: new Date('2027-01-05'), startTime: '09:00', endTime: '17:00', staffRole: 'Doctor',
            urgency: 'emergency', status: 'available', hospital: { _id: 'h1', hospitalLegalName: 'TEST - Hospital' }, ...extra
        });
        const rows = [duty('d1', { isDemo: true }), duty('d2', {})];
        const chain = { populate: () => chain, sort: () => chain, skip: () => chain, limit: async () => rows };
        Duty.find = () => chain;
        Duty.countDocuments = async () => rows.length;

        const { duties } = await dutyService.getEmergencyDashboard({});
        expect(duties.map(d => [d.id, d.isDemo])).toEqual([['d1', true], ['d2', false]]);
    });
});
