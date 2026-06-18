const User = require('../models/User');
const OTPService = require('./otp.service');
const EmailService = require('./email.service');
const logger = require('../utils/logger');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cacheService = require('./cache.service');
const notificationDelivery = require('./notificationDelivery.service');
const {
    AppError,
    ConflictError,
    NotFoundError,
    ValidationError,
    UnauthorizedError
} = require('../middleware/error.middleware');


class AuthService {
    async signup(userData) {
        if (userData.role === 'admin') {
            throw new ValidationError('Admin role is not allowed for signup');
        }

        const email = userData.email.toLowerCase();
        const cacheKey = `user:exists:${email}`;
        
        // Check cache first
        const cachedUser = await cacheService.get(cacheKey);
        if (cachedUser) {
            throw new ConflictError('User already exists with this email');
        }

        // Check database with lean query for performance
        const existingUser = await User.findOne({ email }).lean();
        if (existingUser) {
            await cacheService.set(cacheKey, true, 300);
            throw new ConflictError('User already exists with this email');
        }

        // Clean up existing temp user in Redis
        await cacheService.deleteTempUser(email);
        await cacheService.del(`otp:${email}`);

        // Generate OTP
        const otp = OTPService.generateOTP();
        const otpExpiry = OTPService.getOTPExpiry();

        // Hash password before storing in Redis
        const hashedPassword = await bcrypt.hash(userData.password, 10);

        // Store temp user data in Redis (10 minute TTL)
        const tempUserData = {
            name: userData.name,
            email,
            role: userData.role,
            password: hashedPassword,
            createdAt: new Date().toISOString()
        };

        await cacheService.setTempUser(email, tempUserData, 600);

        // Store OTP separately for faster verification
        await cacheService.setTempUserOTP(email, { code: otp, expiresAt: otpExpiry }, 600);

        // Fire-and-forget — temp user and OTP are already persisted in Redis.
        // If delivery fails the user can hit "resend OTP"; no need to block the
        // signup response on SMTP latency.
        EmailService.sendOTPEmail(email, otp, userData.name)
            .catch(err => logger.error(`Failed to send signup OTP email to ${email}: ${err.message}`));

        logger.info(`New user registered: ${email}`);
        
        return {
            message: 'User registered successfully. Please verify your email with the OTP sent.',
            email
        };
    }


    
    async verifyOTP(email, otp) {
        const emailLower = email.toLowerCase();
        const lockKey = `verify:${emailLower}`;
        
        // Acquire distributed lock to prevent race conditions
        const lockAcquired = await cacheService.acquireLock(lockKey, 5);
        if (!lockAcquired) {
            throw new ValidationError('Verification already in progress. Try again in a few seconds.');
        }
        
        try {
            // Get OTP from Redis
            const otpData = await cacheService.getTempUserOTP(emailLower);
            
            if (!otpData || otpData.code !== otp || new Date(otpData.expiresAt) < new Date()) {
                throw new UnauthorizedError('Invalid or expired OTP');
            }

            // Get temp user data from Redis
            const tempUser = await cacheService.getTempUser(emailLower);
            
            if (!tempUser) {
                throw new NotFoundError('User not found or already verified');
            }

            try {
                // Create permanent user in MongoDB
                const user = await User.create({
                    name: tempUser.name,
                    email: tempUser.email,
                    role: tempUser.role,
                    password: tempUser.password,
                    isEmailVerified: true
                });

                // Delete from Redis
                await cacheService.pipeline([
                    { type: 'del', key: `otp:${emailLower}` },
                    { type: 'del', key: `tempuser:${emailLower}` },
                    { type: 'set', key: `user:exists:${emailLower}`, value: true, ttl: 3600 },
                    { type: 'set', key: `user:${emailLower}`, value: { id: user._id, email: user.email, role: user.role, isEmailVerified: user.isEmailVerified }, ttl: 300 },
                    {
                        type: 'set',
                        key: `session:${user._id}`,
                        value: { id: user._id, name: user.name, email: user.email, role: user.role },
                        ttl: 86400
                    }
                ]);

                // Generate JWT token
                const token = jwt.sign(
                    { id: user._id, role: user.role },
                    process.env.JWT_SECRET,
                    { expiresIn: process.env.JWT_EXPIRES_IN }
                );

                logger.info(`Email verified and user created: ${user.email}`);
                
                return {
                    message: 'Email verified successfully',
                    token,
                    user: {
                        id: user._id,
                        name: user.name,
                        email: user.email,
                        role: user.role,
                        isEmailVerified: user.isEmailVerified
                    }
                };
            } catch (error) {
                logger.error(`Error moving user from temp to permanent: ${error.message}`);
                throw new AppError('Failed to verify email. Please try again.', 500);
            }
        } finally {
            // Always release the lock
            await cacheService.releaseLock(lockKey);
        }
    }

   

    async resendOTP(email) {
        const emailLower = email.toLowerCase();
        const tempUser = await cacheService.getTempUser(emailLower);
        
        if (!tempUser) {
            throw new NotFoundError('User not found or already verified');
        }

        // Generate new OTP
        const otp = OTPService.generateOTP();
        const otpExpiry = OTPService.getOTPExpiry();

        // Update OTP in Redis
        await cacheService.pipeline([
            { 
                type: 'set', 
                key: `otp:${emailLower}`, 
                value: { code: otp, expiresAt: otpExpiry }, 
                ttl: 600 
            },
            { 
                type: 'del', 
                key: `user:exists:${emailLower}`
            }
        ]);

        // Send new OTP email — fire-and-forget, OTP is already updated in Redis
        EmailService.sendOTPEmail(tempUser.email, otp, tempUser.name)
            .catch(err => logger.error(`Failed to resend OTP email to ${tempUser.email}: ${err.message}`));

        logger.info(`OTP resent to: ${tempUser.email}`);
        
        return {
            message: 'OTP resent successfully'
        };
    }

    

    async signin(email, password) {
        const emailLower = email.toLowerCase();
        const cacheKey = `user:${emailLower}`;
        
        // Check cache first for user existence
        const cachedUser = await cacheService.get(cacheKey);
        let user;
        
        if (!cachedUser) {
            // Single database query with password 
            user = await User.findOne({ email: emailLower }).select('+password');
            if (!user) {
                throw new UnauthorizedError('Invalid email or password.');
            }
            // Cache only non-sensitive data
            await cacheService.set(cacheKey, {
                id: user._id,
                email: user.email,
                role: user.role,
                isEmailVerified: user.isEmailVerified
            }, 300);
        } else {
            // Get full user with password from database
            user = await User.findOne({ email: emailLower }).select('+password');
        }
        
        if (!user.isEmailVerified) {
            throw new UnauthorizedError('Please verify your email first');
        }
        
        const isPasswordValid = await user.comparePassword(password);
        if (!isPasswordValid) {
            throw new UnauthorizedError('Invalid email or password.');
        }

        // Check suspension before issuing any token — fail-closed, no token for suspended accounts
        if (user.role === 'hospital' || user.role === 'staff') {
            const Model = user.role === 'hospital'
                ? require('../models/Hospital')
                : require('../models/MedicalStaff');

            const profile = await Model.findOne({ user: user._id })
                .select('isSuspended suspensionReason')
                .lean();

            if (profile && profile.isSuspended) {
                const reason = profile.suspensionReason
                    ? `Your account has been suspended. Reason: ${profile.suspensionReason}. Please contact support for assistance.`
                    : 'Your account has been suspended. Please contact support for assistance.';

                const { ForbiddenError } = require('../middleware/error.middleware');
                throw new ForbiddenError(reason);
            }
        }

        // Generate JWT token
        const token = jwt.sign(
            { id: user._id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN }
        );

        // Use pipeline for cache operations
        await cacheService.pipeline([
            {
                type: 'set',
                key: `session:${user._id}`,
                value: { id: user._id, name: user.name, email: user.email, role: user.role },
                ttl: 86400
            },
            { 
                type: 'set', 
                key: cacheKey, 
                value: { id: user._id, email: user.email, role: user.role, isEmailVerified: user.isEmailVerified }, 
                ttl: 300 
            }
        ]);

        logger.info(`User signed in: ${user.email}`);

        // Fetch onboarding step for immediate redirect — non-blocking parallel query
        let onboardingStep = 'complete';
        try {
            if (user.role === 'staff' || user.role === 'hospital') {
                const ProfileService = require('./profile.service');
                const status = await ProfileService.checkProfileCompletion(user._id.toString());
                onboardingStep = status.onboardingStep;
            }
        } catch (_) {}

        return {
            message: 'Sign in successful',
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
                isEmailVerified: user.isEmailVerified
            },
            onboardingStep
        };
    }

    
    
    async forgotPassword(email) {
        const emailLower = email.toLowerCase();
        const user = await User.findOne({ email: emailLower }).lean();

        // Always respond the same way — don't leak whether email exists
        if (!user) {
            return { message: 'If this email is registered, a reset link has been sent.' };
        }

        const crypto = require('crypto');
        const token = crypto.randomBytes(32).toString('hex');
        const tokenKey = `pwd_reset:${token}`;

        // Store userId against token, 1 hour TTL
        await cacheService.set(tokenKey, { userId: user._id.toString() }, 3600);

        const resetUrl = `${process.env.FRONTEND_URL}/auth/reset-password?token=${token}`;
        EmailService.sendPasswordResetEmail(user.email, user.name, resetUrl)
            .catch(err => logger.error(`Failed to send password reset email: ${err.message}`));

        logger.info(`Password reset requested for: ${emailLower}`);
        return { message: 'If this email is registered, a reset link has been sent.' };
    }

    async resetPassword(token, newPassword) {
        const tokenKey = `pwd_reset:${token}`;
        const cached = await cacheService.get(tokenKey);

        if (!cached || !cached.userId) {
            throw new ValidationError('Reset link is invalid or has expired.');
        }

        const user = await User.findById(cached.userId).select('+password');
        if (!user) {
            throw new NotFoundError('User not found.');
        }

        const isSamePassword = await user.comparePassword(newPassword);
        if (isSamePassword) {
            throw new ValidationError('New password cannot be the same as your current password.');
        }

        user.password = newPassword; // pre-save hook will hash it
        await user.save();

        // Invalidate the token and any active session
        await cacheService.pipeline([
            { type: 'del', key: tokenKey },
            { type: 'del', key: `session:${cached.userId}` }
        ]);

        // Notify the user their password was changed
        notificationDelivery.createAndDeliver(
            cached.userId,
            'PASSWORD_CHANGED',
            {
                title: 'Password Changed',
                message: 'Your password was successfully reset. If this wasn\'t you, contact support immediately.',
                timestamp: new Date().toISOString()
            }
        ).catch(err => logger.error(`Failed to send password changed notification: ${err.message}`));

        logger.info(`Password reset successful for userId: ${cached.userId}`);
        return { message: 'Password reset successful. Please sign in with your new password.' };
    }

    async logout(token, userId) {
        // Use remaining JWT lifetime as TTL so the blacklist entry never outlives the token
        let blacklistTTL = 604800; // safe fallback: 7 days
        try {
            const decoded = jwt.decode(token);
            if (decoded?.exp) {
                const remaining = decoded.exp - Math.floor(Date.now() / 1000);
                if (remaining > 0) blacklistTTL = remaining;
            }
        } catch (_) {} // never block logout due to decode failure

        const pipelineResult = await cacheService.pipeline([
            { type: 'set', key: `blacklist:${token}`, value: true, ttl: blacklistTTL },
            ...(userId ? [{ type: 'del', key: `session:${userId}` }] : [])
        ]);

        if (!pipelineResult) {
            logger.error(`Logout pipeline failed for userId: ${userId}`);
            throw new Error('Failed to logout. Please try again.');
        }

        logger.info(`User logged out: ${userId}`);
        return { message: 'Logged out successfully' };
    }
}

module.exports = new AuthService();