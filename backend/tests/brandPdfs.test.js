// Statement and receipt in the new brand, printed through one shared browser.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));

const mockPages = [];
let mockLaunches = 0;
let mockFailNextContent = false;
let mockOpenNow = 0;
let mockOpenMax = 0;
jest.mock('puppeteer-core', () => ({
    launch: async () => {
        mockLaunches++;
        return {
            on: () => {},
            close: async () => {},
            newPage: async () => {
                mockOpenNow++;
                mockOpenMax = Math.max(mockOpenMax, mockOpenNow);
                const page = {
                    closed: false,
                    setContent: async (html, options) => {
                        page.options = options;
                        await new Promise(r => setTimeout(r, 5));
                        if (mockFailNextContent) { mockFailNextContent = false; throw new Error('boom'); }
                    },
                    evaluate: async () => { page.waitedForFonts = true; return true; },
                    pdf: async () => Buffer.from('%PDF'),
                    close: async () => { page.closed = true; mockOpenNow--; }
                };
                mockPages.push(page);
                return page;
            }
        };
    }
}));

const { earningsTemplate, receiptTemplate } = require('../src/utils/pdf.templates');
const pdf = require('../src/utils/pdf.puppeteer');

function res() {
    const r = { headers: {}, statusCode: 200 };
    r.setHeader = (k, v) => { r.headers[k] = v; };
    r.end = (body) => { r.body = body; return r; };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
}

const statement = {
    user: { name: 'TEST - Doctor', email: 'test@example.com' },
    period: '2026-10-01 to 2026-10-31',
    totalEarnings: 12000,
    totalDuties: 2,
    totalHours: '16h 0m',
    data: [
        { dutyDate: new Date('2026-10-02'), hospital: 'TEST - <City> Hospital', role: 'icu_nurse', amount: 6000, hours: '8h 0m', rate: 750, paymentStatus: 'paid' },
        { dutyDate: new Date('2026-10-03'), hospital: 'TEST - Hospital', role: 'rmo', amount: 6000, hours: '8h 0m', paymentStatus: 'pending' }
    ]
};

describe('brand templates', () => {
    it('statement: brand logo, readable roles, rupee separators, status per duty, escaped text', () => {
        const html = earningsTemplate(statement);
        expect(html).toContain('<svg');
        expect(html).toContain('ICU Nurse');
        expect(html).toContain('₹12,000');
        expect(html).toContain('₹750/hr');
        expect(html).toContain('Paid');
        expect(html).toContain('Hospital will pay later');
        expect(html).toContain('TEST - &lt;City&gt; Hospital');
        expect(html).not.toContain('icu_nurse');
    });

    it('receipt: payment method from the duty, including bank transfers', () => {
        const html = receiptTemplate({
            staff: { name: 'TEST - Doctor', email: 'test@example.com' },
            dutyId: '64b7f0c2a1b2c3d4e5f60718',
            hospital: 'TEST - Hospital',
            summary: { role: 'rmo', date: new Date('2026-10-02'), payment: 1600 },
            totalEarning: 1600,
            rate: 200,
            time: { startTime: '20:00', endTime: '08:00', duration: '12h 0m' },
            payment: { method: 'bank', status: 'Paid', attestedAt: new Date('2026-10-03') }
        });
        expect(html).toContain('Bank transfer');
        expect(html).toContain('8 PM to 8 AM');
        expect(html).toContain('#E5F60718');
        expect(html).toContain('₹200 per hour');
    });
});

describe('pdf printing', () => {
    it('launches one browser for many PDFs and closes every page', async () => {
        await pdf.generateEarningsPDF(res(), statement);
        await pdf.generateEarningsPDF(res(), statement);
        expect(mockLaunches).toBe(1);
        expect(mockPages.every(p => p.closed)).toBe(true);
    });

    it('waits for the brand font on statements', async () => {
        const r = res();
        await pdf.generateEarningsPDF(r, statement);
        const page = mockPages[mockPages.length - 1];
        expect(page.options.waitUntil).toBe('load');
        expect(page.waitedForFonts).toBe(true);
        expect(r.headers['Content-Type']).toBe('application/pdf');
    });

    it('closes the page and answers 500 without internals when printing fails', async () => {
        mockFailNextContent = true;
        const r = res();
        await pdf.generateEarningsPDF(r, statement);
        expect(r.statusCode).toBe(500);
        expect(r.body).toEqual({ success: false, message: 'PDF generation failed' });
        expect(mockPages[mockPages.length - 1].closed).toBe(true);
    });

    it('prints at most three at once', async () => {
        mockOpenMax = 0;
        await Promise.all(Array.from({ length: 8 }, () => pdf.generateEarningsPDF(res(), statement)));
        expect(mockOpenMax).toBeLessThanOrEqual(3);
        expect(mockPages.every(p => p.closed)).toBe(true);
    });
});
