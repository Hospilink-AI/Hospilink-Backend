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
            // Parallel execution of independent operations
            const [admin, rateLimitResult] = await Promise.all([
                // Find admin user with password
                User.findOne({ 
                    email: email.toLowerCase(), 
                    role: 'admin' 
                }).select('+password'),
                // Check rate limiting in parallel
                this._checkRateLimit(email).catch(() => true) // Don't block on rate limit errors
            ]);
            
            if (!admin) {
                throw new NotFoundError('Admin not found with this email');
            }

            // Verify password 
            const isPasswordValid = await admin.comparePassword(password);
            if (!isPasswordValid) {
                throw new UnauthorizedError('Invalid credentials');
            }

            // Generate OTP
            const otp = OTPService.generateOTP();
            const otpExpiry = OTPService.getOTPExpiry();

            // Prepare data for parallel storage
            const redisKey = `admin_otp:${email}`;
            const otpData = {
                otp: otp,
                userId: admin._id.toString(),
                timestamp: new Date().toISOString()
            };

            // Parallel storage operations + immediate email sending
            const [redisResult, saveResult] = await Promise.all([
                // Store in Redis
                redisClient.getClientAsync().then(redis => 
                    redis.setex(redisKey, 600, JSON.stringify(otpData))
                ),
                // Store OTP in user document
                User.updateOne(
                    { _id: admin._id }, 
                    { $set: { otp: { code: otp, expiresAt: otpExpiry } } }
                )
            ]);

            // Send OTP email immediately (non-blocking)
            EmailService.sendAdminOTPEmail(admin.email, otp, admin.name)
                .catch(err => logger.error(`Failed to send admin OTP email: ${err.message}`));

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
            // Find admin user first 
            const admin = await User.findOne({ 
                email: email.toLowerCase(), 
                role: 'admin' 
            });
            
            if (!admin) {
                throw new NotFoundError('Admin not found');
            }

            // Check Redis first (fast path)
            const redisKey = `admin_otp:${email}`;
            const redis = await redisClient.getClientAsync();
            const redisData = await redis.get(redisKey);

            let isValidOTP = false;
            let verificationSource = '';

            if (redisData) {
                // Redis path - fast verification
                const parsedData = JSON.parse(redisData);
                isValidOTP = parsedData.otp === otp;
                verificationSource = 'redis';
                logger.info(`OTP verification from Redis for: ${email}`);
            } else {
                // Fallback to Database path
                isValidOTP = admin.verifyOTP(otp);
                verificationSource = 'database';
                logger.info(`OTP verification from Database for: ${email}`);
            }

            if (!isValidOTP) {
                throw new UnauthorizedError('Invalid or expired OTP');
            }

            // Clear OTP from both systems in parallel
            await Promise.all([
                redis.del(redisKey),
                User.updateOne({ _id: admin._id }, { $unset: { otp: 1 } })
            ]);
            // Generate JWT token immediately
            const token = require('jsonwebtoken').sign(
                { id: admin._id, role: admin.role },
                process.env.JWT_SECRET,
                { expiresIn: process.env.JWT_EXPIRES_IN}
            );

            // Device tracking + alert email — fully non-blocking
            if (req) {
                setImmediate(async () => {
                    try {
                        const deviceInfo = deviceInfoService.extractDeviceInfo(req);
                        const [location] = await Promise.all([
                            deviceInfoService.getLocationFromIP(deviceInfo.ip)
                        ]);
                        const deviceId = deviceInfoService.generateDeviceId(deviceInfo.ip, deviceInfo.userAgent);

                        const existingDevice = admin.loginDevices?.find(d => d.deviceId === deviceId);
                        let devicesUpdate;

                        if (existingDevice) {
                            devicesUpdate = {
                                $set: { 'loginDevices.$[dev].lastLoginAt': new Date() }
                            };
                            await User.updateOne(
                                { _id: admin._id },
                                devicesUpdate,
                                { arrayFilters: [{ 'dev.deviceId': deviceId }] }
                            );
                        } else {
                            const newDevice = {
                                deviceId,
                                deviceName: deviceInfo.deviceName,
                                ip: deviceInfo.ip,
                                userAgent: deviceInfo.userAgent,
                                location,
                                lastLoginAt: new Date()
                            };
                            await User.updateOne(
                                { _id: admin._id },
                                {
                                    $push: {
                                        loginDevices: {
                                            $each: [newDevice],
                                            $sort: { lastLoginAt: -1 },
                                            $slice: 10
                                        }
                                    }
                                }
                            );
                        }

                        const loginTime = new Date().toLocaleString('en-IN', {
                            timeZone: 'Asia/Kolkata',
                            dateStyle: 'medium',
                            timeStyle: 'short'
                        });
                        const locationString = `${location.city}, ${location.region}, ${location.country}`;

                        EmailService.sendAdminLoginAlertEmail(
                            admin.name, admin.email, deviceInfo.deviceName, locationString, loginTime
                        ).then(sent => {
                            if (sent) logger.info(`Admin login alert sent to ${process.env.ADMIN_LOGIN_ALERT_EMAIL} for ${admin.email}`);
                        }).catch(err => logger.error(`Admin login alert email failed: ${err.message}`));
                    } catch (err) {
                        logger.error(`Device tracking error: ${err.message}`);
                    }
                });
            }

            logger.info(`Admin signed in successfully via ${verificationSource}: ${admin.email}`);
            
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
            // Parallel execution of rate limit and user lookup
            const [admin, rateLimitResult] = await Promise.all([
                // Find admin user
                User.findOne({ 
                    email: email.toLowerCase(), 
                    role: 'admin' 
                }),
                // Check rate limiting in parallel
                this._checkRateLimit(email).catch(() => true)
            ]);
            
            if (!admin) {
                throw new NotFoundError('Admin not found');
            }

            // Generate new OTP
            const otp = OTPService.generateOTP();
            const otpExpiry = OTPService.getOTPExpiry();

            // Prepare data for parallel operations
            const redisKey = `admin_otp:${email}`;
            const otpData = {
                otp: otp,
                userId: admin._id.toString(),
                timestamp: new Date().toISOString()
            };

            // Parallel storage operations
            await Promise.all([
                // Update Redis
                redisClient.getClientAsync().then(redis => 
                    redis.setex(redisKey, 600, JSON.stringify(otpData))
                ),
                // Update user document (faster than save)
                User.updateOne(
                    { _id: admin._id }, 
                    { $set: { otp: { code: otp, expiresAt: otpExpiry } } }
                )
            ]);

            // Send OTP email immediately (non-blocking for consistency)
            EmailService.sendAdminOTPEmail(admin.email, otp, admin.name)
                .catch(err => logger.error(`Failed to send admin OTP email: ${err.message}`));

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
            // Use pipeline for atomic operations
            const pipeline = redis.pipeline();
            pipeline.incr(rateLimitKey);
            
            if (await redis.exists(rateLimitKey) === 0) {
                pipeline.expire(rateLimitKey, 3600);
            }
            
            const results = await pipeline.exec();
            const currentCount = results[0][1];
            
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