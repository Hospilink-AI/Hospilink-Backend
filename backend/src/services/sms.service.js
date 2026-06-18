const twilio = require('twilio');
const logger = require('../utils/logger');

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

class SMSService {
    // Strip all spaces: "+91 9876543210" → "+919876543210" (E.164 required by Twilio)
    static normalizePhone(phone) {
        return phone.replace(/\s+/g, '');
    }

    static async sendOTPSMS(phone, otp, recipientName = '') {
        const normalizedPhone = SMSService.normalizePhone(phone);
        const expiryMinutes = parseInt(process.env.OTP_EXPIRY_MINUTES) || 10;
        const greeting = recipientName ? `Hi ${recipientName}, ` : '';
        const message = `${greeting}Your Hospilink verification code is ${otp}. Valid for ${expiryMinutes} minutes. Do not share this OTP.`;

        await client.messages.create({
            body: message,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: normalizedPhone
        });

        logger.info(`SMS OTP sent to ${normalizedPhone}`);
    }
}

module.exports = SMSService;
