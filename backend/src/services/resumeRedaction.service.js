const path = require('path');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const { createCanvas, loadImage } = require('canvas');
const { PDFDocument } = require('pdf-lib');
const logger = require('../utils/logger');

// Points pdfjs-dist at its own bundled font/cmap data on disk instead of
// trying to fetch it over the network (the default, which fails in a
// server environment and silently degrades text rendering to missing/
// fallback glyphs — harmless for pdf.service.js's existing OCR-fallback use,
// which only ever renders already-scanned, font-less pages, but this module
// rasterizes real text-bearing pages, where correct glyph rendering matters).
const PDFJS_ROOT = path.dirname(require.resolve('pdfjs-dist/package.json'));
const STANDARD_FONT_DATA_URL = path.join(PDFJS_ROOT, 'standard_fonts') + path.sep;
const CMAP_URL = path.join(PDFJS_ROOT, 'cmaps') + path.sep;

// Layer 2 of the resume-masking design (§09): every resume, regardless of
// source format, comes out of this module as a FLATTENED, text-free PDF —
// each page rendered to a raster image with detected contact info and faces
// blacked out, then re-embedded as an image-only PDF page. This is a
// deliberately different (and stronger) approach than drawing a black box
// over the original text layer: painting over text leaves the underlying
// characters fully extractable by anyone who copy-pastes or re-runs
// pdf-parse on the file. Flattening to an image removes the text layer
// entirely, so even a redaction box our own detection missed is at worst a
// *visible* miss, never a *machine-extractable* one.
//
// Two independent detection passes feed the redaction boxes:
//   1. Contact info (phone/email) — reconstructed from the PDF's own text
//      layer via pdfjs-dist for real PDFs, or via Vision OCR word tokens for
//      scanned/image resumes. The PDF-text-layer path needs no external API
//      and is exercised by every digitally-created resume (the common case).
//   2. Faces — Google Vision face detection, best-effort. Vision is already
//      an optional, lazily-created dependency elsewhere in this codebase
//      (ocr.service.js); this module follows the same "gracefully skip, log
//      a warning" contract rather than pdf.service.js's pattern of
//      constructing the client at module load time (which throws immediately
//      in any environment without Vision credentials configured — this
//      module deliberately avoids that failure mode since redaction must
//      keep working even where face detection isn't available).
//
// Scope note: DOCX resumes have no rasterization pipeline in this codebase
// today (mammoth only extracts raw text) — redactResume() returns
// { buffer: null, reason: 'unsupported_format_for_redaction' } for them, and
// the caller (jobApplication resume-view endpoint) must fall back to
// delivery-controls-only (no redacted preview) rather than serving the raw
// file pre-hire.

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Deliberately loose on shape — India's common mobile grouping is 5+5
// (98765 43210), landlines vary (3+3+4, 4+6, contiguous 10-digit, with or
// without a +91/0 prefix), and a real resume can format it any of these
// ways. Rather than hard-coding a digit-group pattern (which is exactly the
// bug this comment used to sit next to — a 3-4/3-4 pattern silently misses
// 5+5 numbers because 5 contiguous digits can't split into two 3-4 groups),
// this matches any digit/space/dash span of the right total LENGTH, then
// isLikelyPhoneNumber() below double-checks the actual digit COUNT (10-13,
// covering a bare Indian mobile number through a +91-prefixed one) before
// treating it as a hit. A false-positive redaction (blacking out something
// that wasn't actually a phone number) is a far safer failure mode than a
// false negative that leaks a real one.
const PHONE_CANDIDATE_REGEX = /\+?\d[\d\s-]{7,16}\d/g;

function isLikelyPhoneNumber(candidate) {
    const digitCount = (candidate.match(/\d/g) || []).length;
    return digitCount >= 10 && digitCount <= 13;
}

const RENDER_SCALE = 2; // matches pdf.service.js's OCR-fallback render scale
const MAX_PAGES = 5; // resumes are short; caps worst-case render time
const BOX_PADDING = 2; // px — ensures glyph ascenders/descenders are fully covered

class ResumeRedactionService {
    // { buffer, mimeType, method } on success.
    // { buffer: null, reason } when this resume can't be safely redacted in
    // this pass — the caller must NOT fall back to serving the raw file.
    async redactResume(sourceBuffer, mimetype) {
        try {
            if (mimetype === 'application/pdf') {
                return await this._redactPdf(sourceBuffer);
            }
            if (mimetype === 'image/jpeg' || mimetype === 'image/jpg' || mimetype === 'image/png') {
                return await this._redactImageResume(sourceBuffer);
            }
            return { buffer: null, reason: 'unsupported_format_for_redaction' };
        } catch (error) {
            logger.error(`resumeRedaction: redaction failed: ${error.message}`);
            return { buffer: null, reason: 'redaction_failed' };
        }
    }

    // ─── PDF path — text-layer redaction, no external API required ─────────

    async _redactPdf(sourceBuffer) {
        const uint8Array = new Uint8Array(sourceBuffer);
        const pdf = await pdfjsLib.getDocument({
            data: uint8Array,
            standardFontDataUrl: STANDARD_FONT_DATA_URL,
            cMapUrl: CMAP_URL,
            cMapPacked: true
        }).promise;
        const pageCount = Math.min(pdf.numPages, MAX_PAGES);

        const outputDoc = await PDFDocument.create();

        for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const viewport = page.getViewport({ scale: RENDER_SCALE });

            const textContent = await page.getTextContent();
            const textBoxesPdfSpace = this._findRedactionBoxesFromPdfText(textContent.items);
            const textBoxesCanvasSpace = textBoxesPdfSpace.map(box => this._pdfBoxToCanvasRect(box, viewport));

            const canvas = createCanvas(viewport.width, viewport.height);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, viewport.width, viewport.height);
            await page.render({ canvasContext: ctx, viewport }).promise;

            // Best-effort, independent of the text-layer pass above — a
            // resume with no phone/email exposure risk is never blocked by
            // face detection being unavailable.
            const faceBoxesCanvasSpace = await this._safeDetectFaces(canvas.toBuffer('image/png'));

            ctx.fillStyle = '#000000';
            for (const rect of [...textBoxesCanvasSpace, ...faceBoxesCanvasSpace]) {
                ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
            }

            const pageImageBuffer = canvas.toBuffer('image/png');
            const embeddedImage = await outputDoc.embedPng(pageImageBuffer);
            const outputPage = outputDoc.addPage([viewport.width, viewport.height]);
            outputPage.drawImage(embeddedImage, { x: 0, y: 0, width: viewport.width, height: viewport.height });
        }

        const outputBytes = await outputDoc.save();
        return { buffer: Buffer.from(outputBytes), mimeType: 'application/pdf', method: 'flattened_text_layer_redaction' };
    }

    // Line-reconstruction over pdfjs text items: group by Y position (same
    // line), sort by X, concatenate into a line string while tracking each
    // item's character range, regex-match the line, then map any match back
    // to the union of the contributing items' bounding boxes. A phone number
    // or email split across several kerned text runs is caught this way even
    // though no single run contains the whole match.
    _findRedactionBoxesFromPdfText(items) {
        const Y_TOLERANCE = 3;
        const lines = [];

        for (const item of items) {
            if (!item.str || !item.str.trim()) continue;
            const y = item.transform[5];
            let line = lines.find(l => Math.abs(l.y - y) <= Y_TOLERANCE);
            if (!line) {
                line = { y, items: [] };
                lines.push(line);
            }
            line.items.push(item);
        }

        const boxes = [];
        for (const line of lines) {
            line.items.sort((a, b) => a.transform[4] - b.transform[4]);

            let lineText = '';
            const ranges = [];
            for (const item of line.items) {
                const start = lineText.length;
                lineText += item.str;
                ranges.push({ start, end: lineText.length, item });
                lineText += ' ';
            }

            for (const { start: matchStart, end: matchEnd } of this._findMatchRanges(lineText)) {
                const contributing = ranges.filter(r => r.start < matchEnd && r.end > matchStart);
                if (contributing.length === 0) continue;
                boxes.push(this._unionBoxOfPdfItems(contributing.map(r => r.item)));
            }
        }
        return boxes;
    }

    // Shared by both the PDF-text and OCR-word paths — runs the email regex
    // as-is, and the phone candidate regex followed by the digit-count
    // sanity check, returning plain { start, end } ranges within lineText.
    _findMatchRanges(lineText) {
        const ranges = [];

        EMAIL_REGEX.lastIndex = 0;
        let match;
        while ((match = EMAIL_REGEX.exec(lineText)) !== null) {
            ranges.push({ start: match.index, end: match.index + match[0].length });
        }

        PHONE_CANDIDATE_REGEX.lastIndex = 0;
        while ((match = PHONE_CANDIDATE_REGEX.exec(lineText)) !== null) {
            if (isLikelyPhoneNumber(match[0])) {
                ranges.push({ start: match.index, end: match.index + match[0].length });
            }
        }

        return ranges;
    }

    _unionBoxOfPdfItems(items) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const item of items) {
            const tx = item.transform[4];
            const ty = item.transform[5];
            const w = item.width || 0;
            const h = item.height || Math.abs(item.transform[3]) || 10;
            x0 = Math.min(x0, tx);
            y0 = Math.min(y0, ty);
            x1 = Math.max(x1, tx + w);
            y1 = Math.max(y1, ty + h);
        }
        return { x0, y0, x1, y1 };
    }

    // Uses pdfjs's own viewport transform rather than hand-rolled math — it
    // correctly handles the PDF (bottom-left origin) -> canvas (top-left
    // origin) flip together with the render scale in one call.
    _pdfBoxToCanvasRect(box, viewport) {
        const [vx0, vy0, vx1, vy1] = viewport.convertToViewportRectangle([box.x0, box.y0, box.x1, box.y1]);
        const x = Math.min(vx0, vx1);
        const y = Math.min(vy0, vy1);
        const width = Math.abs(vx1 - vx0);
        const height = Math.abs(vy1 - vy0);
        return { x: x - BOX_PADDING, y: y - BOX_PADDING, width: width + BOX_PADDING * 2, height: height + BOX_PADDING * 2 };
    }

    // ─── Image path (scanned/photographed resumes) — Vision OCR required ───

    async _redactImageResume(buffer) {
        const visionClient = this._getVisionClient();
        if (!visionClient) {
            return { buffer: null, reason: 'ocr_unavailable' };
        }

        const [textResult] = await visionClient.textDetection({ image: { content: buffer } });
        const words = (textResult.textAnnotations || []).slice(1); // [0] is the full block, skip it
        const textBoxes = this._findRedactionBoxesFromOcrWords(words);
        const faceBoxes = await this._safeDetectFaces(buffer);

        const image = await loadImage(buffer);
        const canvas = createCanvas(image.width, image.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        ctx.fillStyle = '#000000';
        for (const rect of [...textBoxes, ...faceBoxes]) {
            ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
        }

        const redactedImageBuffer = canvas.toBuffer('image/png');

        // Wrapped in a one-page PDF so the output contract is the same
        // shape regardless of source format.
        const outputDoc = await PDFDocument.create();
        const embedded = await outputDoc.embedPng(redactedImageBuffer);
        const page = outputDoc.addPage([image.width, image.height]);
        page.drawImage(embedded, { x: 0, y: 0, width: image.width, height: image.height });
        const outputBytes = await outputDoc.save();

        return { buffer: Buffer.from(outputBytes), mimeType: 'application/pdf', method: 'ocr_redaction' };
    }

    // Same line-reconstruction algorithm as the PDF-native path, applied to
    // Vision's word-level bounding boxes instead of pdfjs text items.
    _findRedactionBoxesFromOcrWords(words) {
        const Y_TOLERANCE = 12; // px — OCR line spacing varies more than PDF glyph runs
        const lines = [];

        for (const word of words) {
            const rect = this._boundingPolyToRect(word.boundingPoly);
            const yCenter = rect.y + rect.height / 2;
            let line = lines.find(l => Math.abs(l.yCenter - yCenter) <= Y_TOLERANCE);
            if (!line) {
                line = { yCenter, words: [] };
                lines.push(line);
            }
            line.words.push({ text: word.description || '', rect });
        }

        const boxes = [];
        for (const line of lines) {
            line.words.sort((a, b) => a.rect.x - b.rect.x);

            let lineText = '';
            const ranges = [];
            for (const w of line.words) {
                const start = lineText.length;
                lineText += w.text;
                ranges.push({ start, end: lineText.length, rect: w.rect });
                lineText += ' ';
            }

            for (const { start: matchStart, end: matchEnd } of this._findMatchRanges(lineText)) {
                const contributing = ranges.filter(r => r.start < matchEnd && r.end > matchStart);
                if (contributing.length === 0) continue;
                boxes.push(this._unionRects(contributing.map(r => r.rect)));
            }
        }
        return boxes;
    }

    _unionRects(rects) {
        const x0 = Math.min(...rects.map(r => r.x));
        const y0 = Math.min(...rects.map(r => r.y));
        const x1 = Math.max(...rects.map(r => r.x + r.width));
        const y1 = Math.max(...rects.map(r => r.y + r.height));
        return { x: x0 - BOX_PADDING, y: y0 - BOX_PADDING, width: (x1 - x0) + BOX_PADDING * 2, height: (y1 - y0) + BOX_PADDING * 2 };
    }

    _boundingPolyToRect(boundingPoly) {
        const vertices = boundingPoly?.vertices || boundingPoly?.normalizedVertices || [];
        const xs = vertices.map(v => v.x || 0);
        const ys = vertices.map(v => v.y || 0);
        const x = xs.length ? Math.min(...xs) : 0;
        const y = ys.length ? Math.min(...ys) : 0;
        return { x, y, width: (xs.length ? Math.max(...xs) : 0) - x, height: (ys.length ? Math.max(...ys) : 0) - y };
    }

    // ─── Shared: face detection + a lazily-created, failure-tolerant Vision client ───

    async _safeDetectFaces(imageBuffer) {
        try {
            const visionClient = this._getVisionClient();
            if (!visionClient) return [];
            const [result] = await visionClient.faceDetection({ image: { content: imageBuffer } });
            return (result.faceAnnotations || []).map(face => this._boundingPolyToRect(face.boundingPoly));
        } catch (error) {
            logger.warn(`resumeRedaction: face detection unavailable, skipping photo redaction: ${error.message}`);
            return [];
        }
    }

    // Created on first use, not at module load — unlike pdf.service.js's
    // top-level Vision client construction (which throws immediately in any
    // environment without GOOGLE_CLIENT_EMAIL/GOOGLE_PRIVATE_KEY set), this
    // module must keep working — with face/OCR redaction simply skipped —
    // wherever Vision isn't configured. Result is cached (including the
    // "unavailable" case) so a missing-credentials environment doesn't retry
    // client construction on every call.
    _getVisionClient() {
        if (this._visionClient !== undefined) return this._visionClient;

        if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
            this._visionClient = null;
            return null;
        }

        try {
            const vision = require('@google-cloud/vision');
            this._visionClient = new vision.ImageAnnotatorClient({
                credentials: {
                    client_email: process.env.GOOGLE_CLIENT_EMAIL,
                    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
                }
            });
        } catch (error) {
            logger.warn(`resumeRedaction: Vision client unavailable: ${error.message}`);
            this._visionClient = null;
        }
        return this._visionClient;
    }
}

module.exports = new ResumeRedactionService();
