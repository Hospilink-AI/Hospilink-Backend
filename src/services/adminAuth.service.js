const User = require('../models/User');
const OTPService = require('./otp.service');
const EmailService = require('./email.service');
const redisClient = require('../config/redis');
const logger = require('../utils/logger');
const { 
    NotFoundError, 
    UnauthorizedError,
    ValidationError 
} = require('../middleware/error.middleware');
const deviceInfoService = require('./deviceInfo.service');
const cacheService = require('./cache.service');


class AdminAuthService {
    async signin(email, password) {
        try {
            // Find admin user with password
            const admin = await User.findOne({ 
                email: email.toLowerCase(), 
                role: 'admin' 
            }).select('+password');
            
            if (!admin) {
                throw new NotFoundError('Admin not found with this email');
            }

            // Verify password
            const isPasswordValid = await admin.comparePassword(password);
            if (!isPasswordValid) {
                throw new UnauthorizedError('Invalid credentials');
            }

            // Check rate limiting (max 3 OTP requests per hour)
            await this._checkRateLimit(email);

            // Generate OTP
            const otp = OTPService.generateOTP();
            const otpExpiry = OTPService.getOTPExpiry();

            // Store OTP in user document
            admin.otp = {
                code: otp,
                expiresAt: otpExpiry
            };
            await admin.save();

            // Store OTP in Redis for faster access and additional security
            const redisKey = `admin_otp:${email}`;
            await redisClient.getClientAsync().then(redis => {
                return redis.setex(redisKey, 600, JSON.stringify({
                    otp: otp,
                    userId: admin._id.toString(),
                    timestamp: new Date().toISOString()
                }));
            });

            // Send OTP email
            await EmailService.sendAdminOTPEmail(admin.email, otp, admin.name);

            logger.info(`Admin signin OTP sent to: ${admin.email}`);
            
            return {
                message: 'OTP sent to your email for verification',
                userId: admin._id,
                email: admin.email
            };
        } catch (error) {
            logger.error(`Admin signin error: ${error.message}`);
            throw error;
        }
    }

   

    async verifyOTP(email, otp, req = null) {
        try {
            // Find admin user
            const admin = await User.findOne({ 
                email: email.toLowerCase(), 
                role: 'admin' 
            });
            
            if (!admin) {
                throw new NotFoundError('Admin not found');
            }

            // Check OTP validity from user document
            const isValidOTP = admin.verifyOTP(otp);
            if (!isValidOTP) {
                throw new UnauthorizedError('Invalid or expired OTP');
            }

            // Additional check from Redis
            const redisKey = `admin_otp:${email}`;
            const redisData = await redisClient.getClientAsync().then(redis => {
                return redis.get(redisKey);
            });

            if (redisData) {
                const parsedData = JSON.parse(redisData);
                if (parsedData.otp !== otp) {
                    throw new UnauthorizedError('Invalid OTP');
                }
            }

            // Clear OTP from both database and Redis
            await admin.clearOTP();
            await redisClient.getClientAsync().then(redis => {
                return redis.del(redisKey);
            });

            // Track device and send alert on EVERY login
            if (req) {
                const deviceInfo = deviceInfoService.extractDeviceInfo(req);
                
                // Debug logging
                logger.info(`Admin login attempt - IP: ${deviceInfo.ip}, User-Agent: ${deviceInfo.userAgent}`);
                logger.info(`Request headers: ${JSON.stringify(req.headers)}`);
                
                const location = await deviceInfoService.getLocationFromIP(deviceInfo.ip);
                const deviceId = deviceInfoService.generateDeviceId(deviceInfo.ip, deviceInfo.userAgent);
                
                // More debug logging
                logger.info(`Generated device ID: ${deviceId}, Location: ${JSON.stringify(location)}`);

                // Update device information
                if (!admin.loginDevices) {
                    admin.loginDevices = [];
                }

                // Check if device exists
                const existingDevice = admin.loginDevices?.find(d => d.deviceId === deviceId);

                if (existingDevice) {
                    // Update last login time for existing device
                    existingDevice.lastLoginAt = new Date();
                } else {
                    // Add new device
                    admin.loginDevices.push({
                        deviceId,
                        deviceName: deviceInfo.deviceName,
                        ip: deviceInfo.ip,
                        userAgent: deviceInfo.userAgent,
                        location,
                        lastLoginAt: new Date()
                    });
                }

                // Keep only last 10 devices to prevent array bloat
                if (admin.loginDevices.length > 10) {
                    admin.loginDevices = admin.loginDevices
                        .sort((a, b) => new Date(b.lastLoginAt) - new Date(a.lastLoginAt))
                        .slice(0, 10);
                }

                await admin.save();

                // Send alert email on EVERY login
                const loginTime = new Date().toLocaleString('en-IN', {
                    timeZone: 'Asia/Kolkata',
                    dateStyle: 'medium',
                    timeStyle: 'short'
                });
                const locationString = `${location.city}, ${location.region}, ${location.country}`;
                
                await EmailService.sendAdminLoginAlertEmail(
                    admin.name,
                    admin.email,
                    deviceInfo.deviceName,
                    locationString,
                    loginTime
                );

                logger.info(`Admin login alert sent for ${admin.email}`);
            }

            // Generate JWT token
            const token = require('jsonwebtoken').sign(
                { id: admin._id, role: admin.role },
                process.env.JWT_SECRET,
                { expiresIn: process.env.JWT_EXPIRES_IN || '1d' }
            );

            logger.info(`Admin signed in successfully: ${admin.email}`);
            
            return {
                message: 'Admin signed in successfully',
                token,
                user: {
                    id: admin._id,
                    name: admin.name,
                    email: admin.email,
                    role: admin.role
                }
            };
        } catch (error) {
            logger.error(`Admin OTP verification error: ${error.message}`);
            throw error;
        }
    }

    

    async resendOTP(email) {
        try {
            // Check rate limiting first
            await this._checkRateLimit(email);

            // Find admin user
            const admin = await User.findOne({ 
                email: email.toLowerCase(), 
                role: 'admin' 
            });
            
            if (!admin) {
                throw new NotFoundError('Admin not found');
            }

            // Generate new OTP
            const otp = OTPService.generateOTP();
            const otpExpiry = OTPService.getOTPExpiry();

            // Update user with new OTP
            admin.otp = {
                code: otp,
                expiresAt: otpExpiry
            };
            await admin.save();

            // Update Redis
            const redisKey = `admin_otp:${email}`;
            await redisClient.getClientAsync().then(redis => {
                return redis.setex(redisKey, 600, JSON.stringify({
                    otp: otp,
                    userId: admin._id.toString(),
                    timestamp: new Date().toISOString()
                }));
            });

            // Send new OTP email
            await EmailService.sendAdminOTPEmail(admin.email, otp, admin.name);

            logger.info(`Admin OTP resent to: ${admin.email}`);
            
            return {
                message: 'OTP resent successfully'
            };
        } catch (error) {
            logger.error(`Admin resend OTP error: ${error.message}`);
            throw error;
        }
    }


    async logout(token, userId) {
        try {
            // Use pipeline for logout operations
            await cacheService.pipeline([
                { 
                    type: 'set', 
                    key: `blacklist:${token}`, 
                    value: true, 
                    ttl: 86400 // 24 hours
                },
                ...(userId ? [{ type: 'del', key: `session:${userId}` }] : [])
            ]);
            
            logger.info(`Admin logged out: ${userId}`);
            
            return {
                message: 'Admin logged out successfully'
            };
        } catch (error) {
            logger.error(`Admin logout error: ${error.message}`);
            throw new Error('Failed to logout. Please try again.');
        }
    }
    

    // Rate limiting helper (3 OTP requests per hour)
    async _checkRateLimit(email) {
        const rateLimitKey = `admin_rate_limit:${email}`;
        const redis = await redisClient.getClientAsync();
        
        try {
            const currentCount = await redis.incr(rateLimitKey);
            
            if (currentCount === 1) {
                // Set expiry of 1 hour (3600 seconds)
                await redis.expire(rateLimitKey, 3600);
            }
            
            if (currentCount > 3) {
                const ttl = await redis.ttl(rateLimitKey);
                const minutesLeft = Math.ceil(ttl / 60);
                throw new ValidationError(
                    `Too many OTP requests. Please try again after ${minutesLeft} minutes.`
                );
            }
        } catch (redisError) {
            logger.error(`Redis rate limit error: ${redisError.message}`);
            // If Redis fails, allow the request but log the error
        }
    }
}

module.exports = new AdminAuthService();