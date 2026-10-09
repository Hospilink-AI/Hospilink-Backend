// Log lines carry masked email addresses and phone numbers, never full ones
const fs = require('fs');
const path = require('path');
const { maskEmail, maskPhone } = require('../src/utils/maskPii');

test('masks an email address', () => {
    expect(maskEmail('jeet.kolhe@gmail.com')).toBe('j***@gmail.com');
    expect(maskEmail('a@b.in')).toBe('a***@b.in');
    expect(maskEmail('not-an-email')).toBe('***');
    expect(maskEmail(undefined)).toBe('');
    expect(maskEmail({ email: 'x@y.z' })).toBe('[redacted]');
});

test('masks a phone number', () => {
    expect(maskPhone('+91 98765 43210')).toBe('******3210');
    expect(maskPhone('123')).toBe('****');
    expect(maskPhone(null)).toBe('');
});

function sourceFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return entry.name.endsWith('.js') ? [full] : [];
    });
}

test('no log line prints an email address or phone number unmasked', () => {
    const offenders = [];
    for (const file of sourceFiles(path.join(__dirname, '../src'))) {
        fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
            if (!/(logger|console)\.(log|info|warn|error|debug)\(/.test(line)) return;
            if (line.trim().startsWith('//')) return;
            const unmasked = [...line.matchAll(/\$\{([^}]*)\}/g)]
                .map(match => match[1])
                .filter(expr => /^[\w.?]*(email|phone)\w*$/i.test(expr.trim()));
            if (unmasked.length) offenders.push(`${path.relative(path.join(__dirname, '..'), file)}:${index + 1}`);
        });
    }
    expect(offenders).toEqual([]);
});
