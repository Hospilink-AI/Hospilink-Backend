const jwt = require('jsonwebtoken');
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
                throw new UnauthorizedError('Invalid email or password.');
            }

            // Verify password
            const isPasswordValid = await admin.comparePassword(password);
            if (!isPasswordValid) {
                throw new UnauthorizedError('Invalid email or password.');
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

            // Parallel storage operations — respond as soon as OTP is saved,
            // then deliver the email in the background (non-blocking).
            await Promise.all([
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

            // Send email after OTP is persisted — fire-and-forget so SMTP latency
            // doesn't add to the API response time. If delivery fails, the admin
            // can use the resend endpoint; the OTP is already stored.
            EmailService.sendAdminOTPEmail(admin.email, otp, admin.name)
                .then(() => logger.info(`Admin signin OTP sent to: ${admin.email}`))
                .catch(err => logger.error(`Failed to send admin OTP email: ${err.message}`));

            
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
            const emailLower = email.toLowerCase();

            // ── Attempt counter ───────────────────────────────────────────────
            // Keyed to the email so it survives across requests.
            // TTL matches the OTP window (10 min) so it auto-clears when the
            // OTP expires anyway.
            const attemptsKey = `admin_otp_attempts:${emailLower}`;
            const redis = await redisClient.getClientAsync();

            const attempts = await redis.incr(attemptsKey);
            // Set TTL only on first increment (atomic: only sets if key is new)
            if (attempts === 1) {
                await redis.expire(attemptsKey, 600); // 10 minutes — matches OTP TTL
            }

            const MAX_ATTEMPTS = 5;
            if (attempts > MAX_ATTEMPTS) {
                // Invalidate the OTP so the admin must start over
                const redisKey = `admin_otp:${emailLower}`;
                await Promise.all([
                    redis.del(redisKey),
                    redis.del(attemptsKey),
                    User.updateOne(
                        { email: emailLower, role: 'admin' },
                        { $unset: { otp: 1 } }
                    )
                ]);
                logger.warn(`Admin OTP locked out after ${MAX_ATTEMPTS} failed attempts: ${emailLower}`);
                throw new UnauthorizedError(
                    'Too many failed attempts. Your OTP has been invalidated. Please sign in again to receive a new OTP.'
                );
            }

            // Find admin user first 
            const admin = await User.findOne({ 
                email: emailLower, 
                role: 'admin' 
            });
            
            if (!admin) {
                throw new NotFoundError('Admin not found');
            }

            // Check Redis first (fast path)
            const redisKey = `admin_otp:${emailLower}`;
            const redisData = await redis.get(redisKey);

            let isValidOTP = false;
            let verificationSource = '';

            if (redisData) {
                // Redis path - fast verification
                const parsedData = JSON.parse(redisData);
                isValidOTP = parsedData.otp === otp;
                verificationSource = 'redis';
            } else {
                // Fallback to Database path
                isValidOTP = admin.verifyOTP(otp);
                verificationSource = 'database';
            }

            if (!isValidOTP) {
                const remaining = MAX_ATTEMPTS - attempts;
                logger.warn(`Admin OTP failed for ${emailLower} — attempt ${attempts}/${MAX_ATTEMPTS}`);
                throw new UnauthorizedError(
                    remaining > 0
                        ? `Invalid or expired OTP. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
                        : 'Invalid or expired OTP.'
                );
            }

            // ── OTP is valid — clear attempt counter and OTP ──────────────────
            await Promise.all([
                redis.del(redisKey),
                redis.del(attemptsKey),
                User.updateOne({ _id: admin._id }, { $unset: { otp: 1 } })
            ]);

            // Generate JWT token
            const token = require('jsonwebtoken').sign(
                { id: admin._id, role: admin.role },
                process.env.JWT_SECRET,
                { expiresIn: process.env.JWT_EXPIRES_IN }
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

                        if (existingDevice) {
                            await User.updateOne(
                                { _id: admin._id },
                                { $set: { 'loginDevices.$[dev].lastLoginAt': new Date() } },
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
                            if (sent) logger.info(`Admin login alert sent for ${admin.email}`);
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

            // Fire-and-forget — OTP is already persisted, no need to block on SMTP
            EmailService.sendAdminOTPEmail(admin.email, otp, admin.name)
                .then(() => logger.info(`Admin resend OTP sent to: ${admin.email}`))
                .catch(err => logger.error(`Failed to send admin OTP email: ${err.message}`));
            
            return {
                message: 'OTP resent successfully'
            };
        } catch (error) {
            logger.error(`Admin resend OTP error: ${error.message}`);
            throw error;
        }
    }


    async logout(token, userId) {
        let blacklistTTL = 604800; // safe fallback: 7 days
        try {
            const decoded = jwt.decode(token);
            if (decoded?.exp) {
                const remaining = decoded.exp - Math.floor(Date.now() / 1000);
                if (remaining > 0) blacklistTTL = remaining;
            }
        } catch (_) {}

        const pipelineResult = await cacheService.pipeline([
            { type: 'set', key: `blacklist:${token}`, value: true, ttl: blacklistTTL },
            ...(userId ? [{ type: 'del', key: `session:${userId}` }] : [])
        ]);

        if (!pipelineResult) {
            logger.error(`Admin logout pipeline failed for userId: ${userId}`);
            throw new Error('Failed to logout. Please try again.');
        }

        logger.info(`Admin logged out: ${userId}`);
        return { message: 'Admin logged out successfully' };
    }
    

    // Rate limiting helper — max 3 OTP send requests per hour per email
    async _checkRateLimit(email) {
        const rateLimitKey = `admin_rate_limit:${email.toLowerCase()}`;
        const redis = await redisClient.getClientAsync();

        try {
            // Atomic increment + set-expiry-on-first-write using a Lua script.
            // This avoids the TOCTOU race in the old incr→exists→expire pattern.
            const luaScript = `
                local current = redis.call('INCR', KEYS[1])
                if current == 1 then
                    redis.call('EXPIRE', KEYS[1], ARGV[1])
                end
                return current
            `;
            const currentCount = await redis.eval(luaScript, 1, rateLimitKey, 3600);

            if (currentCount > 3) {
                const ttl = await redis.ttl(rateLimitKey);
                const minutesLeft = Math.ceil(ttl / 60);
                throw new ValidationError(
                    `Too many OTP requests. Please try again after ${minutesLeft} minutes.`
                );
            }
        } catch (err) {
            if (err instanceof ValidationError) throw err;
            logger.error(`Redis rate limit error: ${err.message}`);
            // If Redis is unavailable, allow the request through rather than blocking admin access
        }
    }
}

module.exports = new AdminAuthService();