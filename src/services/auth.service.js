const User = require('../models/User');
const TempUser = require('../models/TempUser');
const OTPService = require('./otp.service');
const EmailService = require('./email.service');
const logger = require('../utils/logger');
const jwt = require('jsonwebtoken');
const cacheService = require('./cache.service');
const { 
    ConflictError, 
    NotFoundError, 
    ValidationError,
    UnauthorizedError 
} = require('../middleware/error.middleware');


class AuthService {
    async signup(userData) {
        if (userData.role === 'admin') {
            throw new ValidationError('Admin accounts cannot be created through signup');
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
            await cacheService.set(cacheKey, true, 300); // Cache for 5 minutes
            throw new ConflictError('User already exists with this email');
        }

        // Clean up existing temp user
        await TempUser.deleteOne({ email });

        // Generate OTP
        const otp = OTPService.generateOTP();
        const otpExpiry = OTPService.getOTPExpiry();

        // Create temp user
        const tempUser = await TempUser.create({
            name: userData.name,
            email,
            role: userData.role,
            password: userData.password,
            otp: { code: otp, expiresAt: otpExpiry }
        });

        // Cache OTP for faster verification
        await cacheService.set(`otp:${email}`, { code: otp, expiresAt: otpExpiry }, 600);

        try {
            await EmailService.sendOTPEmail(tempUser.email, otp, tempUser.name);
        } catch (emailError) {
            await TempUser.findByIdAndDelete(tempUser._id);
            await cacheService.del(`otp:${email}`);
            throw new Error('Failed to send OTP email. Please try again.');
        }

        logger.info(`New user registered: ${tempUser.email}`);
        
        return {
            message: 'User registered successfully. Please verify your email with the OTP sent.',
            userId: tempUser._id,
            email: tempUser.email
        };
    }


    
    async verifyOTP(email, otp) {
        const emailLower = email.toLowerCase();
        const lockKey = `verify:${emailLower}`;
        const cacheKey = `otp:${emailLower}`;
        
        // Acquire distributed lock to prevent race conditions
        const lockAcquired = await cacheService.acquireLock(lockKey, 5);
        if (!lockAcquired) {
            throw new ValidationError('Verification in progress. Please wait.');
        }
        
        try {
            // Check cache first
            const cachedOTP = await cacheService.get(cacheKey);
            let tempUser;

            if (cachedOTP && cachedOTP.code === otp && cachedOTP.expiresAt > new Date()) {
                // OTP valid in cache, get user from database
                tempUser = await TempUser.findOne({ email: emailLower }).select('+password');
            } else {
                // Fallback to database
                tempUser = await TempUser.findOne({ email: emailLower }).select('+password');
                if (!tempUser || !tempUser.verifyOTP(otp)) {
                    throw new UnauthorizedError('Invalid or expired OTP');
                }
            }

            if (!tempUser) {
                throw new NotFoundError('User not found or already verified');
            }

            try {
                // Move to User collection
                const user = await User.create({
                    name: tempUser.name,
                    email: tempUser.email,
                    role: tempUser.role,
                    password: tempUser.password,
                    isEmailVerified: true
                });

                // Delete from tempUser collection
                await TempUser.deleteOne({ _id: tempUser._id });

                // Use pipeline for cache operations
                await cacheService.pipeline([
                    { type: 'del', key: cacheKey },
                    { type: 'set', key: `user:exists:${emailLower}`, value: true, ttl: 3600 },
                    { type: 'set', key: `user:${emailLower}`, value: { id: user._id, email: user.email, role: user.role, isEmailVerified: user.isEmailVerified }, ttl: 300 },
                    { 
                        type: 'set', 
                        key: `session:${user._id}`, 
                        value: { id: user._id, email: user.email, role: user.role }, 
                        ttl: 86400 
                    }
                ]);

                // Generate JWT token
                const token = jwt.sign(
                    { id: user._id, role: user.role },
                    process.env.JWT_SECRET || 'your-secret-key-123',
                    { expiresIn: process.env.JWT_EXPIRES_IN || '1d' }
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
                throw new Error('Failed to verify email. Please try again.');
            }
        } finally {
            // Always release the lock
            await cacheService.releaseLock(lockKey);
        }
    }

   

    async resendOTP(email) {
        const emailLower = email.toLowerCase();
        const tempUser = await TempUser.findOne({ email: emailLower });
        
        if (!tempUser) {
            throw new NotFoundError('User not found or already verified');
        }

        // Generate new OTP
        const otp = OTPService.generateOTP();
        const otpExpiry = OTPService.getOTPExpiry();

        // Update temp user with new OTP
        tempUser.otp = {
            code: otp,
            expiresAt: otpExpiry
        };
        await tempUser.save();

        // Cache new OTP with pipeline
        await cacheService.pipeline([
            { 
                type: 'set', 
                key: `otp:${emailLower}`, 
                value: { code: otp, expiresAt: otpExpiry }, 
                ttl: 600 
            },
            { 
                type: 'del', 
                key: `user:exists:${emailLower}` // Clear existence cache
            }
        ]);

        // Send new OTP email
        await EmailService.sendOTPEmail(tempUser.email, otp, tempUser.name);

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
                throw new NotFoundError('User not found. Please sign up first.');
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
            throw new UnauthorizedError('Invalid password');
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
                value: { id: user._id, email: user.email, role: user.role }, 
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
        
        return {
            message: 'Sign in successful',
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
                isEmailVerified: user.isEmailVerified
            }
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

        const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
        await EmailService.sendPasswordResetEmail(user.email, user.name, resetUrl);

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

        logger.info(`Password reset successful for userId: ${cached.userId}`);
        return { message: 'Password reset successful. Please sign in with your new password.' };
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
            
            logger.info(`User logged out: ${userId}`);
            
            return {
                message: 'Logged out successfully'
            };
        } catch (error) {
            logger.error(`Logout error: ${error.message}`);
            throw new Error('Failed to logout. Please try again.');
        }
    }
}

module.exports = new AuthService();