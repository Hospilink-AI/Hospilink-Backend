const puppeteer = require('puppeteer');
const { earningsTemplate, receiptTemplate } = require('./pdf.templates');

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

module.exports = {
    generateEarningsPDF,
    generateDutyReceiptPDF
};