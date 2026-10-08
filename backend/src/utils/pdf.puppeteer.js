const puppeteer = require('puppeteer-core');
const { earningsTemplate, receiptTemplate, activityLogsTemplate, activeDutiesTemplate } = require('./pdf.templates');
const logger = require('./logger');

// One Chromium per server process, shared by every PDF. Launching a browser
// per request costs ~1 s and ~150 MB each, so a burst of statement downloads
// could take the server down. Each request gets its own page instead.
const MAX_CONCURRENT_PAGES = parseInt(process.env.PDF_MAX_CONCURRENT_PAGES, 10) || 3;
// Web fonts get this long to load before printing goes ahead with fallbacks
const FONT_WAIT_MS = 5000;

let browserPromise = null;
let activePages = 0;
const waiting = [];

function getBrowser() {
    if (!browserPromise) {
        browserPromise = puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        }).then((browser) => {
            browser.on('disconnected', () => { browserPromise = null; });
            return browser;
        }).catch((err) => {
            browserPromise = null;
            throw err;
        });
    }
    return browserPromise;
}

async function acquireSlot() {
    if (activePages < MAX_CONCURRENT_PAGES) {
        activePages++;
        return;
    }
    await new Promise(resolve => waiting.push(resolve));
}

function releaseSlot() {
    const next = waiting.shift();
    if (next) next();
    else activePages--;
}

// Renders html to a PDF buffer. waitForFonts waits for the network to settle
// (web fonts) for up to FONT_WAIT_MS, then prints whatever has loaded.
async function renderPdf(html, pdfOptions, { waitForFonts = false } = {}) {
    await acquireSlot();
    let page = null;
    try {
        const browser = await getBrowser();
        page = await browser.newPage();
        if (waitForFonts) {
            await page.setContent(html, { waitUntil: 'networkidle0', timeout: FONT_WAIT_MS }).catch((err) => {
                if (!/timeout/i.test(err.message)) throw err;
            });
        } else {
            await page.setContent(html, { waitUntil: 'load' });
        }
        return await page.pdf({ printBackground: true, ...pdfOptions });
    } finally {
        if (page) await page.close().catch(() => {});
        releaseSlot();
    }
}

async function sendPdf(res, html, filename, pdfOptions, renderOptions, label) {
    try {
        const pdfBuffer = await renderPdf(html, pdfOptions, renderOptions);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
        res.setHeader('Content-Length', pdfBuffer.length);
        return res.end(pdfBuffer);
    } catch (error) {
        logger.error(`${label} PDF failed: ${error.message}`);
        return res.status(500).json({ success: false, message: 'PDF generation failed' });
    }
}

const LANDSCAPE = {
    format: 'A4',
    landscape: true, // landscape fits the wide table better
    margin: { top: '16px', bottom: '16px', left: '16px', right: '16px' }
};

async function generateEarningsPDF(res, data) {
    return sendPdf(res, earningsTemplate(data), 'earnings.pdf', { format: 'A4' }, { waitForFonts: true }, 'Earnings');
}

async function generateDutyReceiptPDF(res, data) {
    return sendPdf(res, receiptTemplate(data), 'earnings.pdf', { format: 'A4' }, { waitForFonts: true }, 'Receipt');
}

async function generateActivityLogsPDF(res, data) {
    return sendPdf(res, activityLogsTemplate(data), `activity-logs-${Date.now()}.pdf`, LANDSCAPE, {}, 'Activity logs');
}

async function generateActiveDutiesPDF(res, data) {
    return sendPdf(res, activeDutiesTemplate(data), `active-duties-${Date.now()}.pdf`, LANDSCAPE, {}, 'Active duties');
}

// Closes the shared browser (graceful shutdown)
async function closeBrowser() {
    if (!browserPromise) return;
    const pending = browserPromise;
    browserPromise = null;
    try {
        const browser = await pending;
        await browser.close();
    } catch (err) {
        // already gone
    }
}

module.exports = {
    generateEarningsPDF,
    generateDutyReceiptPDF,
    generateActivityLogsPDF,
    generateActiveDutiesPDF,
    renderPdf,
    closeBrowser
};
