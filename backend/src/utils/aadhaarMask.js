// UIDAI rules (Aadhaar Act s.29 and its regulations) don't let us keep full
// Aadhaar numbers outside an Aadhaar Data Vault, so only the last 4 digits
// are stored or shown: 'XXXX XXXX 1234'. A 16-digit Virtual ID is masked
// the same way.

const VID = /(^|[^\dX])(\d{4})[\s-]?(\d{4})[\s-]?(\d{4})[\s-]?(\d{4})(?![\d])/g;
const AADHAAR = /(^|[^\dX])(\d{4})[\s-]?(\d{4})[\s-]?(\d{4})(?![\d])/g;

// Every Aadhaar number or VID inside a piece of text
function maskAadhaarInText(text) {
    if (typeof text !== 'string' || !text) return text;
    return text
        .replace(VID, (match, before, a, b, c, last) => `${before}XXXX XXXX XXXX ${last}`)
        .replace(AADHAAR, (match, before, a, b, last) => `${before}XXXX XXXX ${last}`);
}

// One number field: '1234 5678 9012' -> 'XXXX XXXX 9012'
function maskAadhaarNumber(value) {
    if (value == null || value === '') return value;
    const digits = String(value).replace(/\D/g, '');
    if (digits.length < 4) return 'XXXX XXXX XXXX';
    return `XXXX XXXX ${digits.slice(-4)}`;
}

// Strings anywhere in a value (an IDfy payload, extracted data): returns a
// masked copy, leaving the original untouched
function maskAadhaarDeep(value, depth = 0) {
    if (depth > 8 || value == null) return value;
    if (typeof value === 'string') return maskAadhaarInText(value);
    if (typeof value === 'number' && /^\d{12}(\d{4})?$/.test(String(value))) return maskAadhaarNumber(value);
    if (Array.isArray(value)) return value.map(item => maskAadhaarDeep(item, depth + 1));
    if (value instanceof Date || Buffer.isBuffer(value)) return value;
    if (typeof value === 'object') {
        if (value._bsontype) return value; // ObjectId and other BSON values
        const out = {};
        for (const [key, item] of Object.entries(value)) out[key] = maskAadhaarDeep(item, depth + 1);
        return out;
    }
    return value;
}

// A document entry's stored fields with every Aadhaar number masked. Returns
// null when nothing needed masking.
function maskedEntryFields(entry) {
    if (!entry || entry.documentType !== 'aadhaar-card') return null;
    const changes = {};
    const text = maskAadhaarInText(entry.extractedText);
    if (text !== entry.extractedText) changes.extractedText = text;
    if (entry.extractedData) {
        const data = maskAadhaarDeep(entry.extractedData);
        if (data.aadhaarNumber && !/^XXXX XXXX /.test(String(data.aadhaarNumber))) {
            data.aadhaarNumber = maskAadhaarNumber(data.aadhaarNumber);
        }
        if (JSON.stringify(data) !== JSON.stringify(entry.extractedData)) changes.extractedData = data;
    }
    const raw = entry.verificationMeta?.rawResponse;
    if (raw) {
        const masked = maskAadhaarDeep(raw);
        if (JSON.stringify(masked) !== JSON.stringify(raw)) changes['verificationMeta.rawResponse'] = masked;
    }
    return Object.keys(changes).length ? changes : null;
}

// For responses: an entry's extracted data, masked if it's an Aadhaar
const maskedExtractedData = (documentType, data) => (documentType === 'aadhaar-card' && data ? maskAadhaarDeep(data) : data);

module.exports = {
    maskAadhaarInText,
    maskAadhaarNumber,
    maskAadhaarDeep,
    maskedEntryFields,
    maskedExtractedData
};
