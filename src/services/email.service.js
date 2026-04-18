const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

class EmailService {
    constructor() {
        this.transporter = nodemailer.createTransport({
            host: process.env.EMAIL_HOST,
            port: process.env.EMAIL_PORT,
            secure: false,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });
    }

    async sendOTPEmail(email, otp, userName) {
        try {
            const mailOptions = {
                from: `HospiLink <${process.env.EMAIL_FROM}>`,
                to: email,
                subject: 'HospiLink - Email Verification OTP',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                        <h2 style="color: #2c3e50;">HospiLink - Email Verification</h2>
                        <p>Hello ${userName},</p>
                        <p>Thank you for registering with HospiLink. Please use the following OTP to verify your email address:</p>
                        <div style="background-color: #f8f9fa; padding: 20px; text-align: center; margin: 20px 0;">
                            <h1 style="color: #3498db; letter-spacing: 10px; margin: 0;">${otp}</h1>
                        </div>
                        <p>This OTP is valid for ${process.env.OTP_EXPIRY_MINUTES || 10} minutes.</p>
                        <p>If you didn't request this, please ignore this email.</p>
                        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                        <p style="color: #7f8c8d; font-size: 12px;">© ${new Date().getFullYear()} HospiLink. All rights reserved.</p>
                    </div>
                `
            };

            await this.transporter.sendMail(mailOptions);
            logger.info(`OTP email sent to ${email}`);
            return true;
        } catch (error) {
            logger.error(`Error sending email to ${email}: ${error.message}`);
            throw new Error('Failed to send OTP email');
        }
    }



    async sendPasswordResetEmail(email, userName, resetUrl) {
        try {
            const mailOptions = {
                from: `HospiLink <${process.env.EMAIL_FROM}>`,
                to: email,
                subject: 'HospiLink - Password Reset Request',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e1e4e8; border-radius: 10px; overflow: hidden;">
                        <div style="background-color: #e74c3c; padding: 20px; text-align: center;">
                            <h2 style="color: white; margin: 0;">Password Reset</h2>
                        </div>
                        <div style="padding: 20px;">
                            <p>Hello <strong>${userName}</strong>,</p>
                            <p>We received a request to reset your HospiLink password. Click the button below to set a new password:</p>

                            <div style="text-align: center; margin: 30px 0;">
                                <a href="${resetUrl}" style="background-color: #e74c3c; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: bold;">
                                    Reset Password
                                </a>
                            </div>

                            <p style="color: #7f8c8d; font-size: 13px;">Or copy this link into your browser:</p>
                            <p style="word-break: break-all; color: #3498db; font-size: 13px;">${resetUrl}</p>

                            <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
                                <p style="margin: 0; color: #856404;">This link expires in <strong>1 hour</strong>. If you didn't request a password reset, you can safely ignore this email.</p>
                            </div>

                            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                            <p style="color: #7f8c8d; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} HospiLink. All rights reserved.</p>
                        </div>
                    </div>
                `
            };

            await this.transporter.sendMail(mailOptions);
            logger.info(`Password reset email sent to ${email}`);
            return true;
        } catch (error) {
            logger.error(`Error sending password reset email to ${email}: ${error.message}`);
            throw new Error('Failed to send password reset email');
        }
    }

    async sendAdminOTPEmail(email, otp, userName) {
        try {
            const mailOptions = {
                from: `HospiLink Admin <${process.env.EMAIL_FROM}>`,
                to: email,
                subject: 'HospiLink Admin - Sign In Verification OTP',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e1e4e8; border-radius: 10px; overflow: hidden;">
                        <div style="background-color: #2c3e50; padding: 20px; text-align: center;">
                            <h2 style="color: white; margin: 0;">Admin Sign In</h2>
                        </div>
                        <div style="padding: 20px;">
                            <p>Hello <strong>${userName}</strong>,</p>
                            <p>You requested to sign in to the HospiLink Admin Panel. Please use the following OTP to verify your identity:</p>
                            
                            <div style="background-color: #f8f9fa; border: 2px solid #3498db; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
                                <h1 style="color: #2c3e50; letter-spacing: 8px; margin: 0; font-size: 32px;">${otp}</h1>
                            </div>
                            
                            <p><strong>This OTP is valid for ${process.env.OTP_EXPIRY_MINUTES || 10} minutes only.</strong></p>
                            
                            <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
                                <h4 style="margin-top: 0; color: #856404;">🔒 Security Notice</h4>
                                <p style="margin: 0; color: #856404;">If you didn't request this sign in, please contact your system administrator immediately.</p>
                            </div>
                            
                            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                            <p style="color: #7f8c8d; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} HospiLink. All rights reserved.</p>
                        </div>
                    </div>
                `
            };

            await this.transporter.sendMail(mailOptions);
            logger.info(`Admin OTP email sent to ${email}`);
            return true;
        } catch (error) {
            logger.error(`Error sending admin email to ${email}: ${error.message}`);
            throw new Error('Failed to send admin OTP email');
        }
    }



    async sendAdminLoginAlertEmail(adminName, adminEmail, deviceName, location, time) {
        try {
            const alertEmail = process.env.ADMIN_LOGIN_ALERT_EMAIL;
            
            if (!alertEmail) {
                logger.warn('ADMIN_LOGIN_ALERT_EMAIL not configured, skipping alert email');
                return false;
            }

            const mailOptions = {
                from: `HospiLink Security <${process.env.EMAIL_FROM}>`,
                to: alertEmail,
                subject: `🔔 Admin Login Alert - ${adminName}`,
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e1e4e8; border-radius: 10px; overflow: hidden;">
                        <div style="background-color: #3498db; padding: 20px; text-align: center;">
                            <h2 style="color: white; margin: 0;">🔔 Admin Login Notification</h2>
                        </div>
                        <div style="padding: 20px;">
                            <p><strong>Admin Name:</strong> ${adminName}</p>
                            <p><strong>Admin Email:</strong> ${adminEmail}</p>
                            
                            <div style="background-color: #f8f9fa; border-left: 4px solid #3498db; padding: 15px; margin: 20px 0;">
                                <h4 style="margin-top: 0; color: #2c3e50;">Login Details</h4>
                                <table style="width: 100%; border-collapse: collapse;">
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;"><strong>Device:</strong></td>
                                        <td style="padding: 8px 0;">${deviceName}</td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;"><strong>Location:</strong></td>
                                        <td style="padding: 8px 0;">${location}</td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;"><strong>Time:</strong></td>
                                        <td style="padding: 8px 0;">${time}</td>
                                    </tr>
                                </table>
                            </div>
                            
                            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                            <p style="color: #7f8c8d; font-size: 12px; text-align: center;">
                                © ${new Date().getFullYear()} HospiLink. All rights reserved.<br>
                                This is an automated login notification. Please do not reply.
                            </p>
                        </div>
                    </div>
                `
            };

            await this.transporter.sendMail(mailOptions);
            logger.info(`Admin login alert email sent to ${alertEmail} for admin ${adminEmail}`);
            return true;
        } catch (error) {
            logger.error(`Error sending admin login alert email: ${error.message}`);
            // Don't throw error to avoid breaking login flow
            return false;
        }
    }

    
    
    async sendDutyAcceptanceEmail(email, userName, dutyDetails) {
        try {
            const mailOptions = {
                from: `HospiLink <${process.env.EMAIL_FROM}>`,
                to: email,
                subject: 'HospiLink - Duty Accepted Successfully',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e1e4e8; border-radius: 10px; overflow: hidden;">
                        <div style="background-color: #2ecc71; padding: 20px; text-align: center;">
                            <h2 style="color: white; margin: 0;">Duty Accepted!</h2>
                        </div>
                        <div style="padding: 20px;">
                            <p>Hello <strong>${userName}</strong>,</p>
                            <p>You have successfully accepted a duty. Here are the details:</p>
                            
                            <div style="background-color: #f8f9fa; border-radius: 8px; padding: 15px; margin: 20px 0;">
                                <h3 style="margin-top: 0; color: #2c3e50;">Duty Details</h3>
                                <table style="width: 100%; border-collapse: collapse;">
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Hospital:</td>
                                        <td style="padding: 8px 0; font-weight: bold;">${dutyDetails.hospitalName}</td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Role:</td>
                                        <td style="padding: 8px 0;">${dutyDetails.staffRole}</td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Date:</td>
                                        <td style="padding: 8px 0;">${dutyDetails.date}</td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Time:</td>
                                        <td style="padding: 8px 0;">${dutyDetails.time}</td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Offered Rate:</td>
                                        <td style="padding: 8px 0; color: #27ae60; font-weight: bold;">₹${dutyDetails.rate}/hr</td>
                                    </tr>
                                </table>
                            </div>
                            
                            <p>Please ensure you arrive at least 15 minutes before your shift starts.</p>
                            <p>If you have any questions, please contact the hospital directly.</p>
                            
                            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                            <p style="color: #7f8c8d; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} HospiLink. Your medical staffing partner.</p>
                        </div>
                    </div>
                `
            };

            await this.transporter.sendMail(mailOptions);
            logger.info(`Duty acceptance email sent to ${email}`);
            return true;
        } catch (error) {
            logger.error(`Error sending duty acceptance email to ${email}: ${error.message}`);
            // We don't want to throw error here to not break the duty acceptance logic
            return false;
        }
    }

    async sendHospitalDutyNotificationEmail(hospitalEmail, hospitalName, staffDetails, dutyDetails) {
        try {
            const mailOptions = {
                from: `HospiLink <${process.env.EMAIL_FROM}>`,
                to: hospitalEmail,
                subject: 'HospiLink - Duty Accepted by Staff',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e1e4e8; border-radius: 10px; overflow: hidden;">
                        <div style="background-color: #3498db; padding: 20px; text-align: center;">
                            <h2 style="color: white; margin: 0;">Duty Accepted!</h2>
                        </div>
                        <div style="padding: 20px;">
                            <p>Hello <strong>${hospitalName}</strong>,</p>
                            <p>A medical staff member has accepted your duty request. Here are the details:</p>
                            
                            <div style="background-color: #f8f9fa; border-radius: 8px; padding: 15px; margin: 20px 0;">
                                <h3 style="margin-top: 0; color: #2c3e50;">Staff Details</h3>
                                <table style="width: 100%; border-collapse: collapse;">
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Name:</td>
                                        <td style="padding: 8px 0; font-weight: bold;">${staffDetails.name}</td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Email:</td>
                                        <td style="padding: 8px 0;">${staffDetails.email}</td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Role:</td>
                                        <td style="padding: 8px 0;">${dutyDetails.staffRole}</td>
                                    </tr>
                                </table>
                            </div>

                            <div style="background-color: #f8f9fa; border-radius: 8px; padding: 15px; margin: 20px 0;">
                                <h3 style="margin-top: 0; color: #2c3e50;">Duty Details</h3>
                                <table style="width: 100%; border-collapse: collapse;">
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Date:</td>
                                        <td style="padding: 8px 0;">${dutyDetails.date}</td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Time:</td>
                                        <td style="padding: 8px 0;">${dutyDetails.time}</td>
                                    </tr>
                                </table>
                            </div>
                            
                            <p>You can view more details in your Hospital Dashboard.</p>
                            
                            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                            <p style="color: #7f8c8d; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} HospiLink. All rights reserved.</p>
                        </div>
                    </div>
                `
            };

            await this.transporter.sendMail(mailOptions);
            logger.info(`Hospital notification email sent to ${hospitalEmail}`);
            return true;
        } catch (error) {
            logger.error(`Error sending hospital notification email to ${hospitalEmail}: ${error.message}`);
            return false;
        }
    }


    async sendDutyStatusUpdateEmail(email, userName, dutyDetails, newStatus) {
        try {
            const statusMessages = {
                'enroute': 'On the way to duty location',
                'in-progress': 'Started duty shift',
                'completed': 'Completed duty shift'
            };

            const statusColors = {
                'enroute': '#f39c12',
                'in-progress': '#3498db',
                'completed': '#27ae60'
            };

            const mailOptions = {
                from: `HospiLink <${process.env.EMAIL_FROM}>`,
                to: email,
                subject: `HospiLink - Duty Status Updated: ${newStatus.replace('-', ' ').toUpperCase()}`,
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e1e4e8; border-radius: 10px; overflow: hidden;">
                        <div style="background-color: ${statusColors[newStatus]}; padding: 20px; text-align: center;">
                            <h2 style="color: white; margin: 0;">Duty Status Updated!</h2>
                        </div>
                        <div style="padding: 20px;">
                            <p>Hello <strong>${userName}</strong>,</p>
                            <p>Your duty status has been successfully updated to: <strong>${statusMessages[newStatus]}</strong></p>
                            
                            <div style="background-color: #f8f9fa; border-radius: 8px; padding: 15px; margin: 20px 0;">
                                <h3 style="margin-top: 0; color: #2c3e50;">Duty Details</h3>
                                <table style="width: 100%; border-collapse: collapse;">
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Hospital:</td>
                                        <td style="padding: 8px 0; font-weight: bold;">${dutyDetails.hospitalName}</td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Role:</td>
                                        <td style="padding: 8px 0;">${dutyDetails.staffRole}</td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Date:</td>
                                        <td style="padding: 8px 0;">${dutyDetails.date}</td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Time:</td>
                                        <td style="padding: 8px 0;">${dutyDetails.time}</td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Current Status:</td>
                                        <td style="padding: 8px 0; color: ${statusColors[newStatus]}; font-weight: bold;">${newStatus.replace('-', ' ').toUpperCase()}</td>
                                    </tr>
                                </table>
                            </div>
                            
                            <p>Thank you for keeping your duty status updated. This helps hospitals track your progress efficiently.</p>
                            
                            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                            <p style="color: #7f8c8d; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} HospiLink. Your medical staffing partner.</p>
                        </div>
                    </div>
                `
            };

            await this.transporter.sendMail(mailOptions);
            logger.info(`Duty status update email sent to ${email}`);
            return true;
        } catch (error) {
            logger.error(`Error sending duty status update email to ${email}: ${error.message}`);
            return false;
        }
    }

    async sendHospitalStatusUpdateEmail(hospitalEmail, hospitalName, staffDetails, dutyDetails, newStatus) {
        try {
            const statusMessages = {
                'enroute': 'On the way to your facility',
                'in-progress': 'Started duty shift at your facility',
                'completed': 'Completed duty shift at your facility'
            };

            const statusColors = {
                'enroute': '#f39c12',
                'in-progress': '#3498db',
                'completed': '#27ae60'
            };

            const mailOptions = {
                from: `HospiLink <${process.env.EMAIL_FROM}>`,
                to: hospitalEmail,
                subject: `HospiLink - Staff Duty Status Update: ${newStatus.replace('-', ' ').toUpperCase()}`,
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e1e4e8; border-radius: 10px; overflow: hidden;">
                        <div style="background-color: ${statusColors[newStatus]}; padding: 20px; text-align: center;">
                            <h2 style="color: white; margin: 0;">Staff Status Update!</h2>
                        </div>
                        <div style="padding: 20px;">
                            <p>Hello <strong>${hospitalName}</strong>,</p>
                            <p>Your assigned medical staff member has updated their duty status to: <strong>${statusMessages[newStatus]}</strong></p>
                            
                            <div style="background-color: #f8f9fa; border-radius: 8px; padding: 15px; margin: 20px 0;">
                                <h3 style="margin-top: 0; color: #2c3e50;">Staff Details</h3>
                                <table style="width: 100%; border-collapse: collapse;">
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Name:</td>
                                        <td style="padding: 8px 0; font-weight: bold;">${staffDetails.name}</td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Email:</td>
                                        <td style="padding: 8px 0;">${staffDetails.email}</td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Current Status:</td>
                                        <td style="padding: 8px 0; color: ${statusColors[newStatus]}; font-weight: bold;">${newStatus.replace('-', ' ').toUpperCase()}</td>
                                    </tr>
                                </table>
                            </div>

                            <div style="background-color: #f8f9fa; border-radius: 8px; padding: 15px; margin: 20px 0;">
                                <h3 style="margin-top: 0; color: #2c3e50;">Duty Details</h3>
                                <table style="width: 100%; border-collapse: collapse;">
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Role:</td>
                                        <td style="padding: 8px 0;">${dutyDetails.staffRole}</td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Date:</td>
                                        <td style="padding: 8px 0;">${dutyDetails.date}</td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Time:</td>
                                        <td style="padding: 8px 0;">${dutyDetails.time}</td>
                                    </tr>
                                </table>
                            </div>
                            
                            <p>You can view more details and track staff progress in your Hospital Dashboard.</p>
                            
                            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                            <p style="color: #7f8c8d; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} HospiLink. All rights reserved.</p>
                        </div>
                    </div>
                `
            };

            await this.transporter.sendMail(mailOptions);
            logger.info(`Hospital status update email sent to ${hospitalEmail}`);
            return true;
        } catch (error) {
            logger.error(`Error sending hospital status update email to ${hospitalEmail}: ${error.message}`);
            return false;
        }
    }

    async sendStaffDutyCancellationEmail(email, userName, dutyDetails, cancellationDetails) {
        try {
            const cancelledByText = cancellationDetails.cancelledBy === 'hospital' 
                ? 'the hospital' 
                : 'you';

            const mailOptions = {
                from: `HospiLink <${process.env.EMAIL_FROM}>`,
                to: email,
                subject: 'HospiLink - Duty Cancelled',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e1e4e8; border-radius: 10px; overflow: hidden;">
                        <div style="background-color: #e74c3c; padding: 20px; text-align: center;">
                            <h2 style="color: white; margin: 0;">Duty Cancelled</h2>
                        </div>
                        <div style="padding: 20px;">
                            <p>Hello <strong>${userName}</strong>,</p>
                            <p>A duty has been cancelled by ${cancelledByText}. Here are the details:</p>
                            
                            <div style="background-color: #f8f9fa; border-radius: 8px; padding: 15px; margin: 20px 0;">
                                <h3 style="margin-top: 0; color: #2c3e50;">Duty Details</h3>
                                <table style="width: 100%; border-collapse: collapse;">
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Hospital:</td>
                                        <td style="padding: 8px 0; font-weight: bold;">${dutyDetails.hospitalName}</td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Role:</td>
                                        <td style="padding: 8px 0;">${dutyDetails.staffRole}</td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Date:</td>
                                        <td style="padding: 8px 0;">${dutyDetails.date}</td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Time:</td>
                                        <td style="padding: 8px 0;">${dutyDetails.time}</td>
                                    </tr>
                                </table>
                            </div>

                            <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
                                <h4 style="margin-top: 0; color: #856404;">Cancellation Reason</h4>
                                <p style="margin: 0; color: #856404;">${cancellationDetails.reasonText || cancellationDetails.reason.replace(/_/g, ' ')}</p>
                            </div>
                            
                            <p>If you have any questions, please contact the hospital or HospiLink support.</p>
                            
                            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                            <p style="color: #7f8c8d; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} HospiLink. Your medical staffing partner.</p>
                        </div>
                    </div>
                `
            };

            await this.transporter.sendMail(mailOptions);
            logger.info(`Duty cancellation email sent to staff ${email}`);
            return true;
        } catch (error) {
            logger.error(`Error sending duty cancellation email to staff ${email}: ${error.message}`);
            return false;
        }
    }

    async sendHospitalDutyCancellationEmail(hospitalEmail, hospitalName, staffDetails, dutyDetails, cancellationDetails) {
        try {
            const cancelledByText = cancellationDetails.cancelledBy === 'hospital' 
                ? 'you' 
                : 'the assigned staff member';

            const staffInfo = staffDetails ? `
                <div style="background-color: #f8f9fa; border-radius: 8px; padding: 15px; margin: 20px 0;">
                    <h3 style="margin-top: 0; color: #2c3e50;">Staff Details</h3>
                    <table style="width: 100%; border-collapse: collapse;">
                        <tr>
                            <td style="padding: 8px 0; color: #7f8c8d;">Name:</td>
                            <td style="padding: 8px 0; font-weight: bold;">${staffDetails.name}</td>
                        </tr>
                        <tr>
                            <td style="padding: 8px 0; color: #7f8c8d;">Email:</td>
                            <td style="padding: 8px 0;">${staffDetails.email}</td>
                        </tr>
                    </table>
                </div>
            ` : '';

            const mailOptions = {
                from: `HospiLink <${process.env.EMAIL_FROM}>`,
                to: hospitalEmail,
                subject: 'HospiLink - Duty Cancelled',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e1e4e8; border-radius: 10px; overflow: hidden;">
                        <div style="background-color: #e74c3c; padding: 20px; text-align: center;">
                            <h2 style="color: white; margin: 0;">Duty Cancelled</h2>
                        </div>
                        <div style="padding: 20px;">
                            <p>Hello <strong>${hospitalName}</strong>,</p>
                            <p>A duty has been cancelled by ${cancelledByText}. Here are the details:</p>
                            
                            ${staffInfo}

                            <div style="background-color: #f8f9fa; border-radius: 8px; padding: 15px; margin: 20px 0;">
                                <h3 style="margin-top: 0; color: #2c3e50;">Duty Details</h3>
                                <table style="width: 100%; border-collapse: collapse;">
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Role:</td>
                                        <td style="padding: 8px 0;">${dutyDetails.staffRole}</td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Date:</td>
                                        <td style="padding: 8px 0;">${dutyDetails.date}</td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 8px 0; color: #7f8c8d;">Time:</td>
                                        <td style="padding: 8px 0;">${dutyDetails.time}</td>
                                    </tr>
                                </table>
                            </div>

                            <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
                                <h4 style="margin-top: 0; color: #856404;">Cancellation Reason</h4>
                                <p style="margin: 0; color: #856404;">${cancellationDetails.reasonText || cancellationDetails.reason.replace(/_/g, ' ')}</p>
                            </div>
                            
                            <p>You can view more details in your Hospital Dashboard.</p>
                            
                            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                            <p style="color: #7f8c8d; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} HospiLink. All rights reserved.</p>
                        </div>
                    </div>
                `
            };

            await this.transporter.sendMail(mailOptions);
            logger.info(`Duty cancellation email sent to hospital ${hospitalEmail}`);
            return true;
        } catch (error) {
            logger.error(`Error sending duty cancellation email to hospital ${hospitalEmail}: ${error.message}`);
            return false;
        }
    }
    async sendHospitalVerifiedEmail(email, hospitalName) {
        try {
            const mailOptions = {
                from: `HospiLink <${process.env.EMAIL_FROM}>`,
                to: email,
                subject: 'HospiLink - Hospital Profile Verified',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e1e4e8; border-radius: 10px; overflow: hidden;">
                        <div style="background-color: #27ae60; padding: 20px; text-align: center;">
                            <h2 style="color: white; margin: 0;">Profile Verified ✓</h2>
                        </div>
                        <div style="padding: 20px;">
                            <p>Hello <strong>${hospitalName}</strong>,</p>
                            <p>Great news! Your hospital profile on HospiLink has been <strong style="color: #27ae60;">verified</strong> by our admin team.</p>
                            <p>You can now:</p>
                            <ul>
                                <li>Post duty requirements for medical staff</li>
                                <li>Access the full HospiLink platform</li>
                                <li>Connect with verified medical professionals</li>
                            </ul>
                            <div style="background-color: #f0fff4; border-left: 4px solid #27ae60; padding: 15px; margin: 20px 0;">
                                <p style="margin: 0; color: #276749;">Your profile is now live and visible to medical staff on the platform.</p>
                            </div>
                            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                            <p style="color: #7f8c8d; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} HospiLink. All rights reserved.</p>
                        </div>
                    </div>
                `
            };
            await this.transporter.sendMail(mailOptions);
            logger.info(`Hospital verified email sent to ${email}`);
            return true;
        } catch (error) {
            logger.error(`Error sending hospital verified email to ${email}: ${error.message}`);
            return false;
        }
    }

    async sendHospitalRejectedEmail(email, hospitalName, reason) {
        try {
            const mailOptions = {
                from: `HospiLink <${process.env.EMAIL_FROM}>`,
                to: email,
                subject: 'HospiLink - Hospital Profile Verification Update',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e1e4e8; border-radius: 10px; overflow: hidden;">
                        <div style="background-color: #e74c3c; padding: 20px; text-align: center;">
                            <h2 style="color: white; margin: 0;">Profile Verification Update</h2>
                        </div>
                        <div style="padding: 20px;">
                            <p>Hello <strong>${hospitalName}</strong>,</p>
                            <p>After reviewing your hospital profile, our admin team was unable to verify it at this time.</p>
                            <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
                                <h4 style="margin-top: 0; color: #856404;">Reason</h4>
                                <p style="margin: 0; color: #856404;">${reason}</p>
                            </div>
                            <p>To resolve this, please:</p>
                            <ul>
                                <li>Review the reason mentioned above</li>
                                <li>Update your profile or re-upload the required documents</li>
                                <li>Our team will re-review your profile once updated</li>
                            </ul>
                            <p>If you have any questions, please contact our support team.</p>
                            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                            <p style="color: #7f8c8d; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} HospiLink. All rights reserved.</p>
                        </div>
                    </div>
                `
            };
            await this.transporter.sendMail(mailOptions);
            logger.info(`Hospital rejected email sent to ${email}`);
            return true;
        } catch (error) {
            logger.error(`Error sending hospital rejected email to ${email}: ${error.message}`);
            return false;
        }
    }

    async sendMedicalStaffVerifiedEmail(email, staffName) {
        try {
            const mailOptions = {
                from: `HospiLink <${process.env.EMAIL_FROM}>`,
                to: email,
                subject: 'HospiLink - Account Verified',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e1e4e8; border-radius: 10px; overflow: hidden;">
                        <div style="background-color: #27ae60; padding: 20px; text-align: center;">
                            <h2 style="color: white; margin: 0;">Account Verified ✓</h2>
                        </div>
                        <div style="padding: 20px;">
                            <p>Hello <strong>${staffName}</strong>,</p>
                            <p>Great news! Your medical staff account on HospiLink has been <strong style="color: #27ae60;">verified</strong> by our admin team.</p>
                            <p>You can now:</p>
                            <ul>
                                <li>Apply for duty opportunities</li>
                                <li>Access the full HospiLink platform</li>
                                <li>Connect with verified hospitals</li>
                                <li>Build your professional profile</li>
                            </ul>
                            <div style="background-color: #f0fff4; border-left: 4px solid #27ae60; padding: 15px; margin: 20px 0;">
                                <p style="margin: 0; color: #276749;">Your account is now live and visible to hospitals on the platform.</p>
                            </div>
                            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                            <p style="color: #7f8c8d; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} HospiLink. All rights reserved.</p>
                        </div>
                    </div>
                `
            };
            await this.transporter.sendMail(mailOptions);
            logger.info(`Medical staff verified email sent to ${email}`);
            return true;
        } catch (error) {
            logger.error(`Error sending medical staff verified email to ${email}: ${error.message}`);
            return false;
        }
    }

    async sendMedicalStaffRejectedEmail(email, staffName, reason) {
        try {
            const mailOptions = {
                from: `HospiLink <${process.env.EMAIL_FROM}>`,
                to: email,
                subject: 'HospiLink - Account Verification Update',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e1e4e8; border-radius: 10px; overflow: hidden;">
                        <div style="background-color: #e74c3c; padding: 20px; text-align: center;">
                            <h2 style="color: white; margin: 0;">Account Verification Update</h2>
                        </div>
                        <div style="padding: 20px;">
                            <p>Hello <strong>${staffName}</strong>,</p>
                            <p>After reviewing your medical staff account, our admin team was unable to verify it at this time.</p>
                            <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
                                <h4 style="margin-top: 0; color: #856404;">Reason</h4>
                                <p style="margin: 0; color: #856404;">${reason}</p>
                            </div>
                            <p>To resolve this, please:</p>
                            <ul>
                                <li>Review the reason mentioned above</li>
                                <li>Update your profile or re-upload the required documents</li>
                                <li>Ensure all information is accurate and complete</li>
                                <li>Our team will re-review your account once updated</li>
                            </ul>
                            <p>If you have any questions, please contact our support team.</p>
                            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                            <p style="color: #7f8c8d; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} HospiLink. All rights reserved.</p>
                        </div>
                    </div>
                `
            };
            await this.transporter.sendMail(mailOptions);
            logger.info(`Medical staff rejected email sent to ${email}`);
            return true;
        } catch (error) {
            logger.error(`Error sending medical staff rejected email to ${email}: ${error.message}`);
            return false;
        }
    }
}

module.exports = new EmailService();