// Only the last 4 digits of an Aadhaar number are stored or shown
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const {
    maskAadhaarInText, maskAadhaarNumber, maskAadhaarDeep, maskedEntryFields, maskedExtractedData
} = require('../src/utils/aadhaarMask');
const Document = require('../src/models/Document');

describe('masking', () => {
    it.each([
        ['1234 5678 9012', 'XXXX XXXX 9012'],
        ['123456789012', 'XXXX XXXX 9012'],
        ['1234-5678-9012', 'XXXX XXXX 9012'],
        ['Aadhaar No: 1234 5678 9012 Male', 'Aadhaar No: XXXX XXXX 9012 Male'],
        ['VID : 9123 4567 8901 2345', 'VID : XXXX XXXX XXXX 2345']
    ])('masks %s', (input, expected) => {
        expect(maskAadhaarInText(input)).toBe(expected);
    });

    it('leaves dates, pincodes, phone numbers and masked numbers alone', () => {
        const text = 'DOB: 12/05/1990 Pune 411001 Mobile 9876543210 XXXX XXXX 9012';
        expect(maskAadhaarInText(text)).toBe(text);
    });

    it('masks a number field', () => {
        expect(maskAadhaarNumber('1234 5678 9012')).toBe('XXXX XXXX 9012');
        expect(maskAadhaarNumber(null)).toBeNull();
    });

    it('masks inside nested payloads without changing the original or ids', () => {
        const id = new mongoose.Types.ObjectId();
        const payload = { parsed_details: { name: 'Asha Rao', uid: '123456789012', list: ['1234 5678 9012'] }, id, n: 123456789012 };
        const masked = maskAadhaarDeep(payload);
        expect(masked.parsed_details).toEqual({ name: 'Asha Rao', uid: 'XXXX XXXX 9012', list: ['XXXX XXXX 9012'] });
        expect(masked.n).toBe('XXXX XXXX 9012');
        expect(masked.id).toBe(id);
        expect(payload.parsed_details.uid).toBe('123456789012');
    });
});

describe('stored entries', () => {
    const full = {
        documentType: 'aadhaar-card',
        extractedText: 'Government of India\nAsha Rao\n1234 5678 9012',
        extractedData: { name: 'Asha Rao', aadhaarNumber: '1234 5678 9012' },
        verificationMeta: { rawResponse: { parsed_details: { uid: '123456789012' } } }
    };

    it('finds every field holding a full number', () => {
        const changes = maskedEntryFields(full);
        expect(changes.extractedText).toBe('Government of India\nAsha Rao\nXXXX XXXX 9012');
        expect(changes.extractedData).toEqual({ name: 'Asha Rao', aadhaarNumber: 'XXXX XXXX 9012' });
        expect(changes['verificationMeta.rawResponse']).toEqual({ parsed_details: { uid: 'XXXX XXXX 9012' } });
    });

    it('has nothing to do for masked entries or other documents', () => {
        const once = { ...full, ...maskedEntryFields(full), verificationMeta: { rawResponse: maskedEntryFields(full)['verificationMeta.rawResponse'] } };
        expect(maskedEntryFields(once)).toBeNull();
        expect(maskedEntryFields({ documentType: 'pan-card', extractedText: '123456789012' })).toBeNull();
    });

    it('masks an older full number whenever the record is saved', async () => {
        const record = new Document({ userId: new mongoose.Types.ObjectId(), userRole: 'staff', documents: [{ ...full, s3Key: 'k', fileName: 'a.jpg' }] });
        await new Promise((resolve, reject) => {
            Document.schema.s.hooks.execPre('save', record, [], (err) => (err ? reject(err) : resolve()));
        });
        const entry = record.documents[0];
        expect(entry.extractedText).not.toContain('1234 5678 9012');
        expect(entry.extractedData.aadhaarNumber).toBe('XXXX XXXX 9012');
        expect(entry.verificationMeta.rawResponse.parsed_details.uid).toBe('XXXX XXXX 9012');
    });

    it('masks Aadhaar data in admin responses only', () => {
        expect(maskedExtractedData('aadhaar-card', { aadhaarNumber: '1234 5678 9012' })).toEqual({ aadhaarNumber: 'XXXX XXXX 9012' });
        expect(maskedExtractedData('pan-card', { panNumber: 'ABCPK1234Z' })).toEqual({ panNumber: 'ABCPK1234Z' });
    });
});

describe('where numbers come in', () => {
    const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

    it('uploads keep only the last 4 digits', () => {
        const service = read('src/services/document.service.js');
        expect(service).toContain('extractedText: isAadhaar ? maskAadhaarInText(extractedText) : extractedText');
        expect(service).toContain('aadhaarNumber: maskAadhaarNumber(extractedData?.aadhaarNumber)');
    });

    it('the clean-up script is a dry run unless asked, and prints counts only', () => {
        const script = read('scripts/maskAadhaarNumbers.js');
        expect(script).toContain("const APPLY = process.argv.includes('--apply');");
        expect(script).toContain('if (!APPLY) continue;');
        expect(script).not.toMatch(/console\.log\([^)]*(extracted|entry\.|record\.)/);
    });
});
