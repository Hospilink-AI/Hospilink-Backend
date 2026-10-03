jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {} }));
jest.mock('../src/config/redis', () => ({ getClientAsync: async () => ({}) }));

const Duty = require('../src/models/Duty');
const Hospital = require('../src/models/Hospital');
const dutyCalendar = require('../src/services/dutyCalendar.service');

const at = (m) => new Date(Date.UTC(2027, 0, 5, 3, m));

function withDuty(duty) {
    Hospital.findOne = () => ({ select: () => ({ lean: async () => ({ _id: 'h1' }) }) });
    Duty.findById = () => { const c = { select: () => c, populate: () => c, lean: async () => duty }; return c; };
}

describe('fill tracker for staged offers', () => {
    it('shows the invite, the window ending, and later rings', async () => {
        withDuty({
            _id: 'd1', hospital: 'h1', status: 'available', createdAt: at(0), notifiedCount: 2, viewedBy: [],
            offer: {
                mode: 'radius', radiusKm: 35,
                history: [
                    { event: 'invite_sent', at: at(0), notified: 2 },
                    { event: 'opened_to_radius', at: at(30), radiusKm: 30, notified: 9 },
                    { event: 'expanded', at: at(90), radiusKm: 35, notified: 4 }
                ]
            }
        });
        const { steps, current } = await dutyCalendar.getFillProgress('hu1', 'd1');
        expect(steps.map(s => s.key)).toEqual(['posted', 'offered', 'viewed', 'invite_sent', 'invite_opened_to_others', 'offer_widened']);
        expect(steps.find(s => s.key === 'invite_opened_to_others')).toMatchObject({ openedTo: 'radius', radiusKm: 30, count: 9 });
        expect(current).toBe('offer_widened');
    });

    it('does not repeat an emergency city opening as an invite step', async () => {
        withDuty({
            _id: 'd2', hospital: 'h1', status: 'available', createdAt: at(0), notifiedCount: 12, viewedBy: [],
            offer: { mode: 'city', history: [{ event: 'opened_to_city', at: at(0), notified: 12 }] }
        });
        const { steps } = await dutyCalendar.getFillProgress('hu1', 'd2');
        expect(steps.map(s => s.key)).toEqual(['posted', 'offered', 'viewed']);
    });

    it('shows an emergency invite opening to the city', async () => {
        withDuty({
            _id: 'd3', hospital: 'h1', status: 'available', createdAt: at(0), notifiedCount: 1, viewedBy: [],
            offer: { mode: 'city', history: [{ event: 'invite_sent', at: at(0), notified: 1 }, { event: 'opened_to_city', at: at(20), notified: 15 }] }
        });
        const { steps } = await dutyCalendar.getFillProgress('hu1', 'd3');
        expect(steps.slice(3)).toMatchObject([{ key: 'invite_sent', count: 1 }, { key: 'invite_opened_to_others', openedTo: 'city', count: 15 }]);
    });
});
