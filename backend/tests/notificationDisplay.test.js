const fs = require('fs');
const path = require('path');
const { describe: describeNotification, TYPES } = require('../src/utils/notificationDisplay');

const enumTypes = (() => {
    const src = fs.readFileSync(path.join(__dirname, '../src/models/Notification.js'), 'utf8');
    const start = src.indexOf('enum: [');
    return [...src.slice(start, src.indexOf('],', start)).matchAll(/'([A-Z0-9_]+)'/g)].map(m => m[1]);
})();

describe('notification display', () => {
    it('covers every notification type the model allows', () => {
        expect(enumTypes.filter(t => !TYPES[t])).toEqual([]);
    });

    it('has every type the code sends in the model', () => {
        const src = fs.readdirSync(path.join(__dirname, '../src/services'))
            .filter(f => f.endsWith('.js'))
            .map(f => fs.readFileSync(path.join(__dirname, '../src/services', f), 'utf8'))
            .join('\n');
        const sent = new Set([...src.matchAll(/(?:createNotificationWithCount|createBulkNotifications|createNotification)\(\s*[^,]+,\s*['"`]([A-Z0-9_]+)['"`]/g)].map(m => m[1]));
        expect([...sent].filter(t => !enumTypes.includes(t))).toEqual([]);
    });

    it('builds a title, severity and a screen to open', () => {
        const display = describeNotification('DUTY_INVITE', { duty: { id: 'd1' }, message: 'City Hosp invited you' });
        expect(display).toEqual({
            title: 'Duty invitation',
            body: 'City Hosp invited you',
            severity: 'success',
            category: 'duty',
            icon: 'mail',
            action: { screen: 'duty_detail', params: { dutyId: 'd1' } }
        });
    });

    it('opens tickets and applications by their ids', () => {
        expect(describeNotification('TICKET_CHAT_MESSAGE', { ticket: { id: 't1', ticketId: 'DUT-2610-0001' } }).action)
            .toEqual({ screen: 'ticket_chat', params: { ticketId: 't1', ticketRef: 'DUT-2610-0001' } });
        expect(describeNotification('VACANCY_CLOSED', { application: { id: 'a1' }, vacancy: { id: 'v1' } }).action.params)
            .toEqual({ applicationId: 'a1', vacancyId: 'v1' });
    });

    it('raises severity for critical payloads and falls back for unknown types', () => {
        expect(describeNotification('DUTY_EDITED', { priority: 'CRITICAL' }).severity).toBe('critical');
        expect(describeNotification('SOMETHING_NEW', {})).toMatchObject({ title: 'HospiLink', action: { screen: 'notifications' } });
    });
});

describe('stored notifications', () => {
    it('adds the display block to old notifications when read', async () => {
        const Notification = require('../src/models/Notification');
        Notification.find = () => ({
            sort: () => ({ limit: () => ({ skip: () => ({ lean: async () => [
                { _id: 'n1', type: 'STAFF_ASSIGNED', payload: { duty: { id: 'd9' }, message: 'Dr A accepted' } },
                { _id: 'n2', type: 'DUTY_INVITE', payload: { display: { title: 'kept as stored' } } }
            ] }) }) })
        });
        const notificationService = require('../src/services/notificationService');
        const [older, newer] = await notificationService.getUserNotifications('u1');
        expect(older.payload.display).toMatchObject({ title: 'Staff assigned', action: { params: { dutyId: 'd9' } } });
        expect(newer.payload.display).toEqual({ title: 'kept as stored' });
    });
});
