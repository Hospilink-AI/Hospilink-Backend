// Comparing the name, date of birth and numbers read from identity documents
// with each other and with the profile. Values often come from OCR, so a value
// that can't be read is "unknown", never a mismatch.

// Honorifics and labels that are not part of anyone's name
const TITLES = new Set([
    'dr', 'doctor', 'mr', 'mrs', 'ms', 'miss', 'mx', 'smt', 'shri', 'shree', 'sri', 'kum', 'kumari',
    'prof', 'sh', 'km'
]);

// Words OCR picks up from the card itself; a "name" containing one of these
// was read from the wrong line
const NOT_A_NAME = new Set([
    'government', 'india', 'income', 'tax', 'department', 'council', 'medical', 'registration',
    'certificate', 'republic', 'permanent', 'account', 'number', 'card', 'unique', 'identification',
    'authority', 'signature', 'father', 'fathers', 'name', 'date', 'birth', 'dob', 'male', 'female',
    'nursing', 'state', 'board', 'university', 'address', 'issued', 'valid', 'license', 'licence',
    'aadhaar', 'aadhar', 'enrolment', 'vid', 'pan', 'govt', 'maharashtra'
]);

const COMPANY_WORDS = new Set(['private', 'pvt', 'limited', 'ltd', 'llp', 'the', 'and', 'co', 'company', 'pvtltd']);

function nameTokens(value) {
    if (typeof value !== 'string') return [];
    return value
        .toLowerCase()
        .replace(/\b[sdwc]\s*\/\s*o\b.*$/, '') // "S/O ..." starts the father's or husband's name
        .replace(/[^a-z\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter(token => !TITLES.has(token));
}

function looksLikeName(value) {
    const tokens = nameTokens(value);
    if (tokens.length === 0 || tokens.length > 6) return false;
    if (tokens.some(token => NOT_A_NAME.has(token))) return false;
    return tokens.join('').length >= 3;
}

function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > 1) return 2;
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let diagonal = prev[0];
        prev[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const above = prev[j];
            prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
            diagonal = above;
        }
    }
    return prev[b.length];
}

// Same name part: equal, an initial of it, one letter off in a long part, or
// one letter dropped ("kumr", "deshmuk")
function samePart(a, b) {
    if (a === b) return true;
    if (a.length === 1) return b.startsWith(a);
    if (b.length === 1) return a.startsWith(b);
    const shortest = Math.min(a.length, b.length);
    if (shortest >= 5) return editDistance(a, b) <= 1;
    return shortest >= 4 && Math.abs(a.length - b.length) === 1 && editDistance(a, b) === 1;
}

// The given name agrees: both start with it, or one is written surname first
// ("KOLHE JEET RAMESH" for "Jeet Kolhe"). Without this, a relative's document
// would pass: "Sunita Anil Shah" contains every part of "Anil Shah".
function givenNamesAgree(left, right) {
    if (left.length < 2 || right.length < 2) return true;
    if (samePart(left[0], right[0])) return true;
    if (samePart(left[0], right[1]) && samePart(right[0], left[left.length - 1])) return true;
    return samePart(right[0], left[1]) && samePart(left[0], right[right.length - 1]);
}

/**
 * Compare two personal names.
 *   'match'    every part of the shorter name is in the longer one and the
 *              given names agree (middle names, surname first and initials
 *              are fine)
 *   'partial'  close but not certain: a one-word name, one part of a long
 *              name differs, or the given names don't line up ("Anil Shah"
 *              and "Sunita Anil Shah")
 *   'mismatch' a part of the shorter name isn't in the longer one
 *              ("Jeet Kolhe" and "Rasika Kolhe")
 *   'unknown'  either value can't be read as a name
 */
function compareNames(a, b) {
    if (!looksLikeName(a) || !looksLikeName(b)) return 'unknown';
    const left = nameTokens(a);
    const right = nameTokens(b);
    if (left.join('') === right.join('')) return 'match';
    if ([...left].sort().join('') === [...right].sort().join('')) return 'match';

    const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
    const used = new Set();
    let matched = 0;
    let fullPartMatched = false;
    for (const part of shorter) {
        const index = longer.findIndex((other, i) => !used.has(i) && samePart(part, other));
        if (index === -1) continue;
        used.add(index);
        matched++;
        if (part.length > 1 && longer[index].length > 1) fullPartMatched = true;
    }

    const missing = shorter.length - matched;
    if (missing === 0) {
        if (!fullPartMatched) return 'partial'; // only initials agree
        if (shorter.length === 1 && longer.length > 1) return 'partial';
        return givenNamesAgree(left, right) ? 'match' : 'partial';
    }
    if (shorter.length >= 3 && missing === 1 && fullPartMatched) return 'partial';
    return 'mismatch';
}

function companyTokens(value) {
    if (typeof value !== 'string') return [];
    return value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t && !COMPANY_WORDS.has(t));
}

// Company and hospital names: the same words, ignoring "Private Limited" and order
function compareCompanyNames(a, b) {
    const left = companyTokens(a);
    const right = companyTokens(b);
    if (left.join('').length < 3 || right.join('').length < 3) return 'unknown';
    const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
    const found = shorter.filter(part => longer.some(other => samePart(part, other))).length;
    if (found === shorter.length) return 'match';
    return found / shorter.length >= 0.5 ? 'partial' : 'mismatch';
}

/**
 * A date of birth as { y, m, d } (or { y } for a year of birth only), from
 * 'DD/MM/YYYY', 'DD-MM-YYYY', 'DD.MM.YYYY', 'YYYY-MM-DD', 'YYYY' or a Date.
 */
function parseDob(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return { y: value.getUTCFullYear(), m: value.getUTCMonth() + 1, d: value.getUTCDate() };
    }
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value).trim();
    let match = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (match) return valid({ y: +match[3], m: +match[2], d: +match[1] });
    match = text.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/);
    if (match) return valid({ y: +match[1], m: +match[2], d: +match[3] });
    match = text.match(/^(?:yob\s*:?\s*)?(\d{4})$/i);
    if (match) return valid({ y: +match[1] });
    return null;
}

function valid(dob) {
    if (dob.y < 1900 || dob.y > 2100) return null;
    if (dob.m !== undefined && (dob.m < 1 || dob.m > 12 || dob.d < 1 || dob.d > 31)) return null;
    return dob;
}

// 'match' | 'mismatch' | 'unknown'. A year of birth is compared on the year.
function compareDobs(a, b) {
    const left = parseDob(a);
    const right = parseDob(b);
    if (!left || !right) return 'unknown';
    if (left.y !== right.y) return 'mismatch';
    if (left.m === undefined || right.m === undefined) return 'match';
    return left.m === right.m && left.d === right.d ? 'match' : 'mismatch';
}

const normalizeNumber = (value) => (typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z0-9]/g, '') : '');

// Registration and licence numbers, ignoring spaces, dashes and case
function compareNumbers(a, b) {
    const left = normalizeNumber(a);
    const right = normalizeNumber(b);
    if (left.length < 3 || right.length < 3) return 'unknown';
    return left === right ? 'match' : 'mismatch';
}

// A PAN whose fourth letter is P belongs to a person; C, F, T, ... to a business
const isPersonalPan = (pan) => /^[A-Z]{3}P[A-Z][0-9]{4}[A-Z]$/.test(normalizeNumber(pan));

module.exports = {
    nameTokens,
    looksLikeName,
    compareNames,
    compareCompanyNames,
    parseDob,
    compareDobs,
    compareNumbers,
    normalizeNumber,
    isPersonalPan
};
