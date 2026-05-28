const crypto = require('crypto');

class OTPService {
    static generateOTP() {
        const length = parseInt(process.env.OTP_LENGTH) || 6;
        const max = Math.pow(10, length); // e.g. 1_000_000 for 6 digits

        // crypto.randomInt(max) returns a cryptographically secure integer in [0, max)
        const randomInt = crypto.randomInt(max);

        // Zero-pad to ensure consistent length (e.g. 42 → "000042" for length 6)
        return String(randomInt).padStart(length, '0');
    }

    static getOTPExpiry() {
        const expiryMinutes = parseInt(process.env.OTP_EXPIRY_MINUTES) || 10;
        const expiryDate = new Date();
        expiryDate.setMinutes(expiryDate.getMinutes() + expiryMinutes);
        return expiryDate;
    }
}

module.exports = OTPService;
