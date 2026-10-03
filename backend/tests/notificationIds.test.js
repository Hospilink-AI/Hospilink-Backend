// Live pop-ups need the stored notification id to mark it read
const mockEmitted = [];
jest.mock('../src/services/websocketManager', () => ({
    isUserOnline: () => true,
    emitToUser: (userId, event, payload) => mockEmitted.push({ userId, payload }),
    sendUnreadCount: () => {}
}));
jest.mock('../src/services/fcm.service', () => ({ sendToUser: async () => ({}), sendToUsers: async () => ({}) }));
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {} }));

const Notification = require('../src/models/Notification');
const notificationService = require('../src/services/notificationService');
const notificationDelivery = require('../src/services/notificationDelivery.service');

const id = (n) => String(n).padStart(24, '0');

beforeAll(() => {
    Notification.prototype.save = async function () { await this.validate(); return this; };
    Notification.countDocuments = async () => 1;
    Notification.insertMany = async (docs) => docs.map((d, i) => ({ ...d, _id: id(100 + i) }));
});
beforeEach(() => { mockEmitted.length = 0; });

describe('notification ids on live events', () => {
    it('puts the stored id on a single notification', async () => {
        const payload = { type: 'DUTY_EDITED', duty: { id: 'd1' }, message: 'Duty updated' };
        const { notification } = await notificationService.createNotificationWithCount(id(1), 'DUTY_EDITED', payload);
        await notificationDelivery.deliverToUser(id(1), 'DUTY_EDITED', payload, 1);
        expect(mockEmitted[0].payload.notificationId).toBe(notification._id.toString());
        expect(mockEmitted[0].payload.display.title).toBe('Duty updated');
    });

    it('gives each recipient of a bulk send their own id', async () => {
        const payload = { type: 'NEW_DUTY_OFFER', duty: { id: 'd2' }, message: 'New duty' };
        await notificationService.createBulkNotifications([id(1), id(2)], 'NEW_DUTY_OFFER', payload);
        await notificationDelivery.deliverToUsers([id(1), id(2)], 'NEW_DUTY_OFFER', payload);
        expect(mockEmitted.map(e => [e.userId, e.payload.notificationId])).toEqual([[id(1), id(100)], [id(2), id(101)]]);
    });

    it('adds the id to stored and replayed notifications', async () => {
        Notification.find = () => ({ sort: () => ({ limit: () => ({ lean: async () => [
            { _id: id(7), type: 'STAFF_ASSIGNED', payload: { duty: { id: 'd3' } } }
        ] }) }) });
        const [missed] = await notificationService.getNotificationsSince(id(1), new Date(0));
        expect(missed.payload.notificationId).toBe(id(7));
    });
});
