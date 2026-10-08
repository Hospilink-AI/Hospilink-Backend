// Statements and receipts carry Manrope inside the page, so printing never
// waits on Google Fonts
const fs = require('fs');
const path = require('path');
const { earningsTemplate, receiptTemplate } = require('../src/utils/pdf.doctorTemplates');

const fontDir = path.join(__dirname, '../src/assets/fonts/manrope');

test('the font files and their licence ship with the backend', () => {
    for (const file of ['manrope-latin-wght-normal.woff2', 'manrope-latin-ext-wght-normal.woff2', 'OFL.txt']) {
        expect(fs.existsSync(path.join(fontDir, file))).toBe(true);
    }
    expect(fs.readFileSync(path.join(fontDir, 'OFL.txt'), 'utf8')).toContain('SIL Open Font License');
});

test.each([
    ['statement', () => earningsTemplate({ duties: [], summary: {}, staff: {}, period: {} })],
    ['receipt', () => receiptTemplate({ duty: {}, staff: {}, hospital: {}, payment: {} })]
])('the %s embeds Manrope and loads nothing from Google', (name, render) => {
    const html = render();
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).toContain('src: url(data:font/woff2;base64,');
    expect(html.match(/@font-face/g)).toHaveLength(2);
});

test('printing no longer waits for the network to go idle', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/utils/pdf.puppeteer.js'), 'utf8');
    expect(source).not.toContain('networkidle0');
    expect(source).toContain('document.fonts.ready');
});
