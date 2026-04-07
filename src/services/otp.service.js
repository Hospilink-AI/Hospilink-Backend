class OTPService {
    static generateOTP() {
        const length = process.env.OTP_LENGTH || 6;
        const digits = '0123456789';
        let OTP = '';
        
        for (let i = 0; i < length; i++) {
            OTP += digits[Math.floor(Math.random() * 10)];
        }
        
        return OTP;
    }

    static getOTPExpiry() {
        const expiryMinutes = parseInt(process.env.OTP_EXPIRY_MINUTES) || 10;
        const expiryDate = new Date();
        expiryDate.setMinutes(expiryDate.getMinutes() + expiryMinutes);
        return expiryDate;
    }
}

module.exports = OTPService;