// For log lines: enough to tell entries apart, not enough to identify anyone.
// 'jeet.kolhe@gmail.com' -> 'j***@gmail.com', '+919876543210' -> '******3210'

const maskEmail = (email) => {
    if (!email || typeof email !== 'string') return email === undefined || email === null ? '' : '[redacted]';
    const at = email.lastIndexOf('@');
    if (at < 1) return '***';
    return `${email[0]}***${email.slice(at)}`;
};

const maskPhone = (phone) => {
    const digits = String(phone ?? '').replace(/\D/g, '');
    if (digits.length < 4) return digits ? '****' : '';
    return `******${digits.slice(-4)}`;
};

module.exports = { maskEmail, maskPhone };
