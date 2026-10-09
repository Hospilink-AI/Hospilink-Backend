// Aadhaar card images are stored with the first 8 digits blacked out
// Image and PDF work loads native libraries on first use
jest.setTimeout(90000);
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

// Vision is replaced by what this test draws: the text and where each word is
let mockAnnotations = [];
jest.mock('@google-cloud/vision', () => ({
    ImageAnnotatorClient: class {
        async textDetection() { return [{ textAnnotations: mockAnnotations }]; }
    }
}));
let mockQr = null;
jest.mock('jsqr', () => () => mockQr);

const sharp = require('sharp');
const { createCanvas } = require('canvas');
const { PDFDocument } = require('pdf-lib');
const { redact, boxesToCover, countNumbersInText, RedactionError } = require('../src/services/aadhaarRedaction.service');

// Load the native image libraries once, before the timed tests
beforeAll(async () => {
    await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>')).png().toBuffer();
    createCanvas(2, 2).toBuffer('image/png');
});

const box = (text, x0, y0, x1, y1) => ({
    description: text,
    boundingPoly: { vertices: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] }
});

// A white card with three grey number blocks where Vision says the groups are
function card() {
    const canvas = createCanvas(600, 300);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 600, 300);
    ctx.fillStyle = '#888';
    for (const x0 of [100, 220, 340]) ctx.fillRect(x0, 200, 100, 40);
    return canvas.toBuffer('image/png');
}

async function pixel(buffer, x, y) {
    const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
}

beforeEach(() => {
    mockQr = null;
    mockAnnotations = [
        box('Government of India\nAsha Rao\n1234 5678 9012', 0, 0, 600, 300),
        box('Asha', 100, 100, 160, 130),
        box('1234', 100, 200, 200, 240),
        box('5678', 220, 200, 320, 240),
        box('9012', 340, 200, 440, 240)
    ];
});

describe('finding the numbers', () => {
    it('counts 12-digit numbers and VIDs in the text, not dates or phones', () => {
        expect(countNumbersInText('1234 5678 9012 and 9123 4567 8901 2345, DOB 12/05/1990, 9876543210')).toBe(2);
        expect(countNumbersInText('XXXX XXXX 9012')).toBe(0);
    });

    it('covers the first two groups of a number and the first three of a VID', () => {
        const words = [
            { text: '1234', x0: 0, x1: 10, y0: 0, y1: 10 }, { text: '5678', x0: 12, x1: 22, y0: 0, y1: 10 }, { text: '9012', x0: 24, x1: 34, y0: 0, y1: 10 },
            { text: '9123', x0: 0, x1: 10, y0: 50, y1: 60 }, { text: '4567', x0: 12, x1: 22, y0: 50, y1: 60 },
            { text: '8901', x0: 24, x1: 34, y0: 50, y1: 60 }, { text: '2345', x0: 36, x1: 46, y0: 50, y1: 60 }
        ];
        const { boxes, found } = boxesToCover(words);
        expect(found).toBe(2);
        expect(boxes.map(b => b.text)).toEqual(['1234', '5678', '9123', '4567', '8901']);
    });

    it('covers two thirds of a number written as one word', () => {
        const { boxes } = boxesToCover([{ text: '123456789012', x0: 0, x1: 120, y0: 0, y1: 10 }]);
        expect(boxes[0].x1).toBe(80);
    });
});

describe('images', () => {
    it('blacks out the first 8 digits and leaves the last 4 readable', async () => {
        const result = await redact(card(), 'image/png');
        expect(result.mimetype).toBe('image/png');
        expect(result.text).toContain('1234 5678 9012');
        expect(await pixel(result.buffer, 150, 220)).toEqual([0, 0, 0]);
        expect(await pixel(result.buffer, 270, 220)).toEqual([0, 0, 0]);
        expect(await pixel(result.buffer, 390, 220)).toEqual([136, 136, 136]);
        expect(await pixel(result.buffer, 50, 50)).toEqual([255, 255, 255]);
    });

    it('keeps a JPEG a JPEG', async () => {
        const jpeg = await sharp(card()).jpeg().toBuffer();
        const result = await redact(jpeg, 'image/jpeg');
        expect(result.mimetype).toBe('image/jpeg');
        expect((await sharp(result.buffer).metadata()).format).toBe('jpeg');
    });

    it('covers an old-style QR code that carries the number', async () => {
        mockQr = { data: '<PrintLetterBarcodeData uid="123456789012" name="Asha Rao"/>', location: { topLeftCorner: { x: 480, y: 20 }, bottomRightCorner: { x: 580, y: 120 } } };
        const result = await redact(card(), 'image/png');
        expect(result.qrCovered).toBe(true);
        expect(await pixel(result.buffer, 530, 70)).toEqual([0, 0, 0]);
    });

    it('refuses a card whose number it can find in the text but not on the image', async () => {
        mockAnnotations = [box('1234 5678 9012', 0, 0, 600, 300), box('1234', 100, 200, 200, 240)];
        await expect(redact(card(), 'image/png')).rejects.toBeInstanceOf(RedactionError);
    });

    it('stores a masked Aadhaar as it is', async () => {
        mockAnnotations = [box('XXXX XXXX 9012', 0, 0, 600, 300), box('XXXX', 100, 200, 200, 240)];
        const result = await redact(card(), 'image/png');
        expect(result.numbers).toBe(0);
        expect(await pixel(result.buffer, 150, 220)).toEqual([136, 136, 136]);
    });
});

describe('PDFs', () => {
    it('rebuilds the PDF from redacted pages, same page count and size', async () => {
        const source = await PDFDocument.create();
        source.addPage([300, 150]);
        source.addPage([300, 150]);
        const result = await redact(Buffer.from(await source.save()), 'application/pdf');
        const out = await PDFDocument.load(result.buffer);
        expect(result.mimetype).toBe('application/pdf');
        expect(out.getPageCount()).toBe(2);
        expect(out.getPage(0).getSize()).toEqual({ width: 300, height: 150 });
        expect(result.numbers).toBe(2);
    });

    it('refuses a long PDF', async () => {
        const source = await PDFDocument.create();
        for (let i = 0; i < 6; i++) source.addPage([100, 100]);
        await expect(redact(Buffer.from(await source.save()), 'application/pdf')).rejects.toBeInstanceOf(RedactionError);
    });
});

describe('uploads', () => {
    it('redact before anything is stored and accept a masked Aadhaar', () => {
        const fs = require('fs');
        const path = require('path');
        const service = fs.readFileSync(path.join(__dirname, '../src/services/document.service.js'), 'utf8');
        const redactAt = service.indexOf('await aadhaarRedaction.redact(file.buffer, file.mimetype)');
        expect(redactAt).toBeGreaterThan(-1);
        expect(redactAt).toBeLessThan(service.indexOf('await deleteFromS3(existingDoc.s3Key)'));
        expect(redactAt).toBeLessThan(service.indexOf('await uploadToS3(file.buffer, key, file.mimetype)'));
        expect(service).toContain('/^[X*]{8}\\d{4}$/i.test(aadhaarNumber)');
        const parse = require('../src/services/parsers/aadhaar.parser');
        expect(parse('Asha Rao\nDOB: 12/05/1990\nXXXX XXXX 9012').aadhaarNumber).toBe('XXXX XXXX 9012');
    });
});
