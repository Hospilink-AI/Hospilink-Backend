// Names, dates of birth and numbers from identity documents: tolerant of how
// Indian names are written and of OCR, strict about a different person
const {
    compareNames, compareCompanyNames, compareDobs, compareNumbers, looksLikeName, isPersonalPan, parseDob
} = require('../src/utils/identityMatch');

describe('names', () => {
    it.each([
        ['Jeet Kolhe', 'JEET RAMESH KOLHE'],          // father's name in the middle
        ['Jeet Kolhe', 'KOLHE JEET RAMESH'],          // surname first, as on many PANs
        ['Dr. Sumit Sanjivan Thombre', 'Sumit Thombre'],
        ['J. Kolhe', 'Jeet Kolhe'],                   // initial
        ['K. Ramesh', 'Ramesh Kumar'],                // South Indian initial first
        ['Jeetkumar Patil', 'Jeet Kumar Patil'],      // joined or split
        ['Priyanka Deshmukh', 'PRIYANKA DESHMUK'],    // one letter dropped by OCR
        ['Amit Kumar Sharma', 'Amit Kumr Sharma'],
        ['Priya Nair', 'PRIYA S NAIR']
    ])('%s and %s match', (a, b) => {
        expect(compareNames(a, b)).toBe('match');
    });

    it.each([
        ['Jeet Kolhe', 'Rasika Kolhe'],               // a relative
        ['Rahul Verma', 'Rohit Verma'],
        ['Jeet Kolhe', 'Geet Kolhe'],
        ['Asha Rao', 'Vikram Singh']
    ])('%s and %s are different people', (a, b) => {
        expect(compareNames(a, b)).toBe('mismatch');
    });

    it.each([
        ['Anil Shah', 'Sunita Anil Shah'],            // his name inside his wife's
        ['Mohammed Irfan Shaikh', 'Irfan Shaikh'],    // a dropped first name
        ['Jeet', 'Jeet Kolhe']                        // one word can't confirm
    ])('%s and %s are only close', (a, b) => {
        expect(compareNames(a, b)).toBe('partial');
    });

    it('treats text that is not a name as unreadable, never as a mismatch', () => {
        expect(compareNames('Jeet Kolhe', 'INCOME TAX DEPARTMENT')).toBe('unknown');
        expect(compareNames('Jeet Kolhe', 'Government of India')).toBe('unknown');
        expect(compareNames('Jeet Kolhe', null)).toBe('unknown');
        expect(compareNames('Jeet Kolhe', '')).toBe('unknown');
        expect(looksLikeName('S/O Ramesh Kolhe')).toBe(false);
    });
});

describe('dates of birth', () => {
    it('reads the usual formats', () => {
        expect(parseDob('12/05/1990')).toEqual({ y: 1990, m: 5, d: 12 });
        expect(parseDob('12-05-1990')).toEqual({ y: 1990, m: 5, d: 12 });
        expect(parseDob('1990-05-12')).toEqual({ y: 1990, m: 5, d: 12 });
        expect(parseDob('1990')).toEqual({ y: 1990 });
        expect(parseDob('31/13/1990')).toBeNull();
    });

    it('compares them, a year of birth on the year only', () => {
        expect(compareDobs('12/05/1990', '1990-05-12')).toBe('match');
        expect(compareDobs('12/05/1990', '13/05/1990')).toBe('mismatch');
        expect(compareDobs('1990', '12/05/1990')).toBe('match');
        expect(compareDobs('1991', '12/05/1990')).toBe('mismatch');
        expect(compareDobs('unreadable', '12/05/1990')).toBe('unknown');
    });
});

describe('numbers and companies', () => {
    it('ignores spacing and case in registration numbers', () => {
        expect(compareNumbers('I-12345-A', 'i 12345 a')).toBe('match');
        expect(compareNumbers('I-12345-A', 'I-54321-A')).toBe('mismatch');
        expect(compareNumbers('', 'I-54321-A')).toBe('unknown');
    });

    it('compares company names without "Private Limited"', () => {
        expect(compareCompanyNames('SAI HOSPITAL PRIVATE LIMITED', 'Sai Hospital Pvt Ltd')).toBe('match');
        expect(compareCompanyNames('Sai Hospital Pvt Ltd', 'Lotus Diagnostics Private Limited')).toBe('mismatch');
    });

    it('tells a personal PAN from a business one', () => {
        expect(isPersonalPan('ABCPK1234Z')).toBe(true);
        expect(isPersonalPan('ABCCK1234Z')).toBe(false);
    });
});
