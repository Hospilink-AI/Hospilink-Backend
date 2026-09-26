const mammoth = require('mammoth');
const { extractTextFromPDF } = require('./pdf.service');
const ocrService = require('./ocr.service');
const { DOCX_MIME_TYPE } = require('../middleware/upload.middleware');
const logger = require('../utils/logger');


exports.extractResumeText = async (buffer, mimetype) => {
    try {
        if (mimetype === 'application/pdf') {
            return await extractTextFromPDF(buffer);
        }

        if (mimetype === DOCX_MIME_TYPE) {
            const result = await mammoth.extractRawText({ buffer });
            return result.value || '';
        }

        if (mimetype === 'image/jpeg' || mimetype === 'image/jpg' || mimetype === 'image/png') {
            // Reuses the same Google Vision OCR pipeline already used for
            // aadhaar/pan/license — a photographed or scanned resume is no
            // different from any other image-based document here.
            return await ocrService.extractTextFromBuffer(buffer, mimetype, 'resume-experience');
        }

        logger.warn(`resumeExtraction.service: unsupported mimetype "${mimetype}" for resume text extraction`);
        return '';
    } catch (err) {
        logger.error(`resumeExtraction.service: extraction failed for mimetype "${mimetype}": ${err.message}`);
        return '';
    }
};
