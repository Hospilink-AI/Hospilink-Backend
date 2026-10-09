const sharp = require('sharp');
const { createCanvas, loadImage } = require('canvas');
const jsQR = require('jsqr');
const { PDFDocument } = require('pdf-lib');
const logger = require('../utils/logger');

/**
 * Black out Aadhaar numbers in an uploaded Aadhaar card before it is stored.
 *
 * UIDAI rules don't let us keep full Aadhaar numbers, and that includes the
 * card images. The first 8 digits of every Aadhaar number (and the first 12
 * of a 16-digit Virtual ID) are covered, so the stored image shows
 * "XXXX XXXX 1234" as UIDAI's own masked Aadhaar does. An old-style QR code
 * that carries the number in plain text is covered too.
 *
 * One Google Vision call per image (or PDF page) gives both the card's text,
 * used for the checks and parsing as before, and where each word sits.
 *
 * If the text shows a number that can't be found on the image, the upload is
 * refused rather than stored with the number visible.
 */

const MAX_PDF_PAGES = 4;
const PDF_SCALE = 2;
const QR_SCAN_MAX_SIDE = 1600;
const NUMBER_IN_TEXT = /(^|[^\d])(\d{4}[ -]?\d{4}[ -]?\d{4}(?:[ -]?\d{4})?)(?!\d)/g;

class RedactionError extends Error {}

let visionClient;
function vision() {
    if (visionClient === undefined) {
        const { ImageAnnotatorClient } = require('@google-cloud/vision');
        visionClient = new ImageAnnotatorClient({
            credentials: {
                client_email: process.env.GOOGLE_CLIENT_EMAIL,
                private_key: String(process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
            }
        });
    }
    return visionClient;
}

// The card's text and the box around each word, from one Vision call
async function readWords(imageBuffer) {
    const [result] = await vision().textDetection({
        image: { content: imageBuffer },
        imageContext: { languageHints: ['en', 'hi'] }
    });
    const annotations = result.textAnnotations || [];
    const words = annotations.slice(1).map((annotation) => {
        const xs = (annotation.boundingPoly?.vertices || []).map(v => v.x || 0);
        const ys = (annotation.boundingPoly?.vertices || []).map(v => v.y || 0);
        return {
            text: annotation.description || '',
            x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys)
        };
    });
    return { text: annotations[0]?.description || '', words };
}

// How many Aadhaar numbers (12 digits) or VIDs (16) the text shows
function countNumbersInText(text) {
    return [...String(text || '').matchAll(NUMBER_IN_TEXT)].length;
}

const sameLine = (a, b) => {
    const height = Math.max(a.y1 - a.y0, b.y1 - b.y0, 1);
    return Math.abs((a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2) < height * 0.6 && b.x0 >= a.x0;
};

/**
 * The boxes to black out: the first 8 digits of each 12-digit number, the
 * first 12 of each 16-digit VID, written as one word or in groups of 4.
 * @returns {{ boxes: Array, found: number }}
 */
function boxesToCover(words) {
    const boxes = [];
    let found = 0;
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        const digits = word.text.replace(/[ -]/g, '');

        // "123456789012" or "1234-5678-9012" as one word: cover the first part
        if (/^\d{12}$/.test(digits) || /^\d{16}$/.test(digits)) {
            const share = (digits.length - 4) / digits.length;
            boxes.push({ ...word, x1: word.x0 + (word.x1 - word.x0) * share });
            found++;
            continue;
        }

        // "1234 5678 9012" as separate words on one line
        if (/^\d{4}$/.test(word.text)) {
            const group = [word];
            let j = i + 1;
            while (j < words.length && group.length < 4 && /^\d{4}$/.test(words[j].text) && sameLine(group[group.length - 1], words[j])) {
                group.push(words[j]);
                j++;
            }
            if (group.length === 3 || group.length === 4) {
                for (const part of group.slice(0, group.length - 1)) boxes.push(part);
                found++;
                i = j - 1;
            }
        }
    }
    return { boxes, found };
}

// An old-style Aadhaar QR code holds the number in plain text; find it
function plainNumberQr(canvas) {
    const scale = Math.min(1, QR_SCAN_MAX_SIDE / Math.max(canvas.width, canvas.height));
    const small = createCanvas(Math.round(canvas.width * scale), Math.round(canvas.height * scale));
    small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
    const pixels = small.getContext('2d').getImageData(0, 0, small.width, small.height);
    const code = jsQR(pixels.data, small.width, small.height);
    if (!code || !/(uid="?\d{12}|\b\d{12}\b)/i.test(code.data || '')) return null;
    const points = Object.values(code.location).filter(p => p && typeof p.x === 'number');
    const xs = points.map(p => p.x / scale);
    const ys = points.map(p => p.y / scale);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

function cover(ctx, box, pad) {
    ctx.fillRect(box.x0 - pad, box.y0 - pad, (box.x1 - box.x0) + pad * 2, (box.y1 - box.y0) + pad * 2);
}

/**
 * Redact one image (already upright). Returns the canvas and what was found.
 */
async function redactCanvas(imageBuffer) {
    const { text, words } = await readWords(imageBuffer);
    const expected = countNumbersInText(text);
    const { boxes, found } = boxesToCover(words);
    if (found < expected) {
        throw new RedactionError(`located ${found} of ${expected} numbers`);
    }

    const image = await loadImage(imageBuffer);
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    ctx.fillStyle = '#000';
    for (const box of boxes) cover(ctx, box, Math.max(2, (box.y1 - box.y0) * 0.2));

    let qr = null;
    try {
        qr = plainNumberQr(canvas);
    } catch (err) {
        logger.warn(`Aadhaar QR check skipped: ${err.message}`);
    }
    if (qr) cover(ctx, qr, 4);

    return { canvas, text, numbers: found, qrCovered: Boolean(qr) };
}

async function redactImage(buffer, mimetype) {
    // Apply the phone camera's rotation so Vision's boxes and the drawing agree
    const upright = await sharp(buffer).rotate().toBuffer();
    const { canvas, text, numbers, qrCovered } = await redactCanvas(upright);
    const png = canvas.toBuffer('image/png');
    const format = mimetype === 'image/png' ? 'png' : (mimetype === 'image/webp' ? 'webp' : 'jpeg');
    const out = format === 'png' ? png : await sharp(png)[format]({ quality: 90 }).toBuffer();
    return { buffer: out, mimetype: `image/${format}`, text, numbers, qrCovered };
}

async function redactPdf(buffer) {
    const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
    const source = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
    if (source.numPages > MAX_PDF_PAGES) {
        throw new RedactionError(`PDF has ${source.numPages} pages`);
    }
    const output = await PDFDocument.create();
    const texts = [];
    let numbers = 0;
    let qrCovered = false;
    for (let pageNumber = 1; pageNumber <= source.numPages; pageNumber++) {
        const page = await source.getPage(pageNumber);
        const pageSize = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: PDF_SCALE });
        const rendered = createCanvas(viewport.width, viewport.height);
        await page.render({ canvasContext: rendered.getContext('2d'), viewport }).promise;
        const result = await redactCanvas(rendered.toBuffer('image/png'));
        texts.push(result.text);
        numbers += result.numbers;
        qrCovered = qrCovered || result.qrCovered;
        const image = await output.embedPng(result.canvas.toBuffer('image/png'));
        const outPage = output.addPage([pageSize.width, pageSize.height]);
        outPage.drawImage(image, { x: 0, y: 0, width: pageSize.width, height: pageSize.height });
    }
    const bytes = await output.save();
    return { buffer: Buffer.from(bytes), mimetype: 'application/pdf', text: texts.join('\n'), numbers, qrCovered };
}

/**
 * @param {Buffer} buffer the uploaded file
 * @param {string} mimetype
 * @returns {Promise<{buffer, mimetype, text, numbers, qrCovered}>} the file to
 *   store (numbers blacked out) and the card's text (full, for the checks)
 * @throws {RedactionError} when a number can't be located on the image
 */
async function redact(buffer, mimetype) {
    if (mimetype === 'application/pdf') return redactPdf(buffer);
    if (String(mimetype).startsWith('image/')) return redactImage(buffer, mimetype);
    throw new RedactionError(`unsupported file type ${mimetype}`);
}

module.exports = { redact, boxesToCover, countNumbersInText, RedactionError };
