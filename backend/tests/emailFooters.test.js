jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
const mockSent = [];
jest.mock('nodemailer', () => ({
    createTransport: () => ({ verify: () => {}, sendMail: async (options) => { mockSent.push(options); return {}; } })
}));

// Any field of any argument reads as plain text, so every template renders
const anything = new Proxy(function () {}, {
    get: (target, key) => (key === Symbol.toPrimitive ? () => 'TEST' : key === 'toString' ? () => 'TEST' : anything),
    apply: () => anything
});

describe('email footers', () => {
    beforeAll(() => {
        process.env.EMAIL_FROM = 'no-reply@hospilink.in';
        process.env.ADMIN_LOGIN_ALERT_EMAIL = 'alerts@hospilink.in';
        delete process.env.EMAIL_PROVIDER;
    });

    it('every email names Hospilink Private Limited and support@hospilink.in, and nothing on hospilink.com', async () => {
        const email = require('../src/services/email.service');
        const senders = Object.getOwnPropertyNames(Object.getPrototypeOf(email))
            .filter(name => name.startsWith('send') && typeof email[name] === 'function');
        expect(senders.length).toBeGreaterThan(20);

        for (const name of senders) {
            mockSent.length = 0;
            await email[name]('test@hospilink.in', 'TEST', 'TEST', anything, anything, anything);
            expect({ name, sent: mockSent.length }).toEqual({ name, sent: 1 });
            const html = mockSent[0].html;
            expect({ name, company: html.includes('Hospilink Private Limited') }).toEqual({ name, company: true });
            expect({ name, support: html.includes('support@hospilink.in') }).toEqual({ name, support: true });
            expect({ name, oldDomain: /hospilink\.com/i.test(html) }).toEqual({ name, oldDomain: false });
        }
    });
});
