const puppeteer = require('puppeteer');
const { earningsTemplate, receiptTemplate, activityLogsTemplate } = require('./pdf.templates');

async function generatePDF(res, html) {
    try {
        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();

        //  wait properly
        await page.setContent(html, { waitUntil: 'domcontentloaded' });

        // small delay to ensure rendering
        await new Promise(resolve => setTimeout(resolve, 300));

        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true
        });

        await browser.close();

        // HEADERS
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=earnings.pdf');
        res.setHeader('Content-Length', pdfBuffer.length);

        return res.end(pdfBuffer);

    } catch (error) {
        console.error('PDF ERROR:', error);

        res.status(500).json({
            success: false,
            message: 'PDF generation failed',
            error: error.message
        });
    }
}

async function generateEarningsPDF(res, data) {
    const html = earningsTemplate(data);
    return generatePDF(res, html);
}

async function generateDutyReceiptPDF(res, data) {
    const html = receiptTemplate(data);
    return generatePDF(res, html);
}

async function generateActivityLogsPDF(res, data) {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const html = activityLogsTemplate(data);
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'domcontentloaded' });
        await new Promise(resolve => setTimeout(resolve, 300));

        const pdfBuffer = await page.pdf({
            format: 'A4',
            landscape: true, // landscape fits the wide table better
            printBackground: true,
            margin: { top: '16px', bottom: '16px', left: '16px', right: '16px' }
        });

        await browser.close();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=activity-logs-${Date.now()}.pdf`);
        res.setHeader('Content-Length', pdfBuffer.length);
        return res.end(pdfBuffer);
    } catch (error) {
        await browser.close();
        console.error('Activity Logs PDF ERROR:', error);
        res.status(500).json({ success: false, message: 'PDF generation failed', error: error.message });
    }
}

module.exports = {
    generateEarningsPDF,
    generateDutyReceiptPDF,
    generateActivityLogsPDF
};