// The doctor hears when a duty is confirmed: by the hospital's end code or by HospiLink.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
const mockSent = [];
jest.mock('../src/services/notificationService', () => ({
    createNotificationWithCount: async (userId, type, payload) => { mockSent.push({ userId, type, payload }); return { unreadCount: 1 }; },
    createBulkNotifications: async () => {},
    notificationIdFor: () => 'n1'
}));
jest.mock('../src/services/notificationDelivery.service', () => ({ deliverToUser: async () => ({}), deliverToUsers: async () => ({}) }));

const mongoose = require('mongoose');
const notificationEmitter = require('../src/services/notificationEmitter');
const { describe: describeNotification } = require('../src/utils/notificationDisplay');

const duty = (extra) => ({
    _id: new mongoose.Types.ObjectId(), staffRole: 'rmo', date: new Date('2026-10-08T00:00:00Z'),
    startTime: '09:00', endTime: '17:00', totalPayment: 1600, completedAt: new Date(), ...extra
});

beforeEach(() => { mockSent.length = 0; });

describe('duty confirmed notice to the doctor', () => {
    it('carries the amount and the payment the hospital recorded', async () => {
        await notificationEmitter.emitDutyConfirmedToStaff(duty({ isPaid: true, paymentMethod: 'upi' }), 'staff-user');
        expect(mockSent).toHaveLength(1);
        const { userId, type, payload } = mockSent[0];
        expect(userId).toBe('staff-user');
        expect(type).toBe('DUTY_COMPLETED');
        expect(payload.message).toBe('The hospital confirmed your rmo duty on 8 Oct, 09:00–17:00: ₹1,600. Paid by UPI.');
        expect(payload.duty).toMatchObject({ totalPayment: 1600, paymentMethod: 'upi', isPaid: true });
        expect(describeNotification(type, payload).action.screen).toBe('duty_detail');
    });

    it('says when the hospital will pay later', async () => {
        await notificationEmitter.emitDutyConfirmedToStaff(duty({ isPaid: false, paymentMethod: 'will_pay_later' }), 'staff-user');
        expect(mockSent[0].payload.message).toMatch(/The hospital will pay later\.$/);
    });

    it('names HospiLink and the reason when an admin closed it', async () => {
        await notificationEmitter.emitDutyConfirmedToStaff(duty({}), 'staff-user', { confirmedBy: 'admin', reason: 'Hospital confirmed by phone' });
        expect(mockSent[0].payload.message).toMatch(/^HospiLink confirmed your rmo duty/);
        expect(mockSent[0].payload.message).toMatch(/Reason: Hospital confirmed by phone$/);
        expect(mockSent[0].payload.confirmedBy).toBe('admin');
    });

    it('sends nothing without a doctor', async () => {
        await notificationEmitter.emitDutyConfirmedToStaff(duty({}), null);
        expect(mockSent).toHaveLength(0);
    });

    it('is sent from the end code and the admin completion paths', () => {
        const fs = require('fs');
        const path = require('path');
        const dutyController = fs.readFileSync(path.join(__dirname, '../src/controllers/duty.controller.js'), 'utf8');
        const adminController = fs.readFileSync(path.join(__dirname, '../src/controllers/admin.controller.js'), 'utf8');
        expect(dutyController).toContain('emitDutyConfirmedToStaff(duty, staffUserId)');
        expect(adminController).toContain("emitDutyConfirmedToStaff(duty, duty.assignedTo?.user?._id, { confirmedBy: 'admin', reason })");
    });
});
