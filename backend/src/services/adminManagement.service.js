const User = require('../models/User');
const cacheService = require('./cache.service');
const OTPService = require('./otp.service');
const EmailService = require('./email.service');
const redisClient = require('../config/redis');
const logger = require('../utils/logger');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const { NotFoundError, ConflictError, ForbiddenError, UnauthorizedError } = require('../middleware/error.middleware');


const ADMIN_PUBLIC_FIELDS = 'name email role adminSubRole isActive createdAt updatedAt';
const ROLE_CHANGE_OTP_TTL_SECONDS = 600; // 10 minutes — matches OTP_EXPIRY_MINUTES default
const ROLE_CHANGE_MAX_OTP_ATTEMPTS = 5;


class AdminManagementService {
    async _invalidateSession(adminId) {
        await cacheService.del(`session:${adminId}`);
    }

    async createAdmin({ name, email, password, adminSubRole }) {
        const existing = await User.findOne({ email });
        if (existing) {
            throw new ConflictError('An account with this email already exists.');
        }

        const admin = await User.create({
            name,
            email,
            password,
            role: 'admin',
            adminSubRole,
            isEmailVerified: true,
            isActive: true
        });

        return {
            id: admin._id,
            name: admin.name,
            email: admin.email,
            role: admin.role,
            adminSubRole: admin.adminSubRole,
            isActive: admin.isActive,
            createdAt: admin.createdAt
        };
    }



    async listAdmins({ adminSubRole, page, limit }) {
        const { skip } = getPaginationParams(page, limit);

        const query = { role: 'admin' };
        if (adminSubRole) query.adminSubRole = adminSubRole;

        const [admins, total] = await Promise.all([
            User.find(query)
                .select(ADMIN_PUBLIC_FIELDS)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            User.countDocuments(query)
        ]);

        return {
            admins,
            pagination: getPaginationMeta(total, page, limit)
        };
    }




    async getAdminDetail(adminId) {
        const admin = await User.findOne({ _id: adminId, role: 'admin' })
            .select(ADMIN_PUBLIC_FIELDS)
            .lean();

        if (!admin) {
            throw new NotFoundError('Admin not found');
        }

        return admin;
    }



    async initiateRoleChange(adminId, newSubRole, requestingAdminId) {
        if (String(adminId) === String(requestingAdminId)) {
            throw new ForbiddenError('You cannot change your own admin sub-role. Ask another super admin, or use direct DB access.');
        }

        const admin = await User.findOne({ _id: adminId, role: 'admin' });
        if (!admin) {
            throw new NotFoundError('Admin not found');
        }

        const requester = await User.findById(requestingAdminId);

        const otp = OTPService.generateOTP();
        const otpExpiry = OTPService.getOTPExpiry();

        const pendingData = {
            otp,
            targetAdminId: admin._id.toString(),
            newSubRole,
            previousSubRole: admin.adminSubRole
        };

        const redis = await redisClient.getClientAsync();
        const redisKey = `admin_role_change_otp:${requestingAdminId}`;

        await Promise.all([
            redis.setex(redisKey, ROLE_CHANGE_OTP_TTL_SECONDS, JSON.stringify(pendingData)),
            User.updateOne(
                { _id: requestingAdminId },
                { $set: { pendingRoleChange: { ...pendingData, expiresAt: otpExpiry } } }
            )
        ]);

        EmailService.sendAdminRoleChangeOTPEmail(
            requester.name, requester.email, otp, admin.name, admin.email, newSubRole
        )
            .then(() => logger.info(`Role-change OTP sent to ${requester.email} for target admin ${admin.email}`))
            .catch(err => logger.error(`Failed to send role-change OTP email: ${err.message}`));

        return {
            targetAdminId: admin._id,
            targetName: admin.name,
            targetEmail: admin.email,
            requestedSubRole: newSubRole
        };
    }



    async verifyRoleChangeOTP(otp, requestingAdminId) {
        const redis = await redisClient.getClientAsync();
        const redisKey = `admin_role_change_otp:${requestingAdminId}`;
        const attemptsKey = `admin_role_change_otp_attempts:${requestingAdminId}`;

        const attempts = await redis.incr(attemptsKey);
        if (attempts === 1) {
            await redis.expire(attemptsKey, ROLE_CHANGE_OTP_TTL_SECONDS);
        }

        if (attempts > ROLE_CHANGE_MAX_OTP_ATTEMPTS) {
            await Promise.all([
                redis.del(redisKey),
                redis.del(attemptsKey),
                User.updateOne({ _id: requestingAdminId }, { $unset: { pendingRoleChange: 1 } })
            ]);
            throw new UnauthorizedError(
                'Too many failed attempts. Please initiate the role change again.'
            );
        }

        // Redis first (fast path), fall back to the DB copy if the key is missing/expired there
        const redisData = await redis.get(redisKey);

        let pending = null;
        if (redisData) {
            pending = JSON.parse(redisData);
        } else {
            const requester = await User.findById(requestingAdminId).select('pendingRoleChange');
            if (requester?.pendingRoleChange?.otp && requester.pendingRoleChange.expiresAt > new Date()) {
                pending = {
                    otp: requester.pendingRoleChange.otp,
                    targetAdminId: requester.pendingRoleChange.targetAdminId.toString(),
                    newSubRole: requester.pendingRoleChange.newSubRole,
                    previousSubRole: requester.pendingRoleChange.previousSubRole
                };
            }
        }

        if (!pending) {
            throw new NotFoundError('No pending role change request found. Please initiate a role change first.');
        }

        if (pending.otp !== otp) {
            throw new UnauthorizedError('Invalid or expired OTP.');
        }

        await Promise.all([
            redis.del(redisKey),
            redis.del(attemptsKey),
            User.updateOne({ _id: requestingAdminId }, { $unset: { pendingRoleChange: 1 } })
        ]);

        const admin = await User.findOne({ _id: pending.targetAdminId, role: 'admin' });
        if (!admin) {
            throw new NotFoundError('Admin not found');
        }

        const previousSubRole = admin.adminSubRole;
        admin.adminSubRole = pending.newSubRole;
        await admin.save();

        await this._invalidateSession(pending.targetAdminId);

        return {
            id: admin._id,
            name: admin.name,
            email: admin.email,
            previousSubRole,
            newSubRole: admin.adminSubRole
        };
    }



    async resendRoleChangeOTP(requestingAdminId) {
        const redis = await redisClient.getClientAsync();
        const redisKey = `admin_role_change_otp:${requestingAdminId}`;

        let pending = null;
        const redisData = await redis.get(redisKey);
        if (redisData) {
            pending = JSON.parse(redisData);
        } else {
            const requesterCheck = await User.findById(requestingAdminId).select('pendingRoleChange');
            if (requesterCheck?.pendingRoleChange?.otp && requesterCheck.pendingRoleChange.expiresAt > new Date()) {
                pending = {
                    targetAdminId: requesterCheck.pendingRoleChange.targetAdminId.toString(),
                    newSubRole: requesterCheck.pendingRoleChange.newSubRole,
                    previousSubRole: requesterCheck.pendingRoleChange.previousSubRole
                };
            }
        }

        if (!pending) {
            throw new NotFoundError('No pending role change request found. Please initiate a role change first.');
        }

        const [requester, target] = await Promise.all([
            User.findById(requestingAdminId),
            User.findById(pending.targetAdminId)
        ]);

        const otp = OTPService.generateOTP();
        const otpExpiry = OTPService.getOTPExpiry();
        const refreshedPending = { ...pending, otp };

        await Promise.all([
            redis.setex(redisKey, ROLE_CHANGE_OTP_TTL_SECONDS, JSON.stringify(refreshedPending)),
            User.updateOne(
                { _id: requestingAdminId },
                {
                    $set: {
                        'pendingRoleChange.otp': otp,
                        'pendingRoleChange.expiresAt': otpExpiry
                    }
                }
            )
        ]);

        EmailService.sendAdminRoleChangeOTPEmail(
            requester.name, requester.email, otp, target?.name, target?.email, pending.newSubRole
        )
            .then(() => logger.info(`Role-change OTP resent to ${requester.email}`))
            .catch(err => logger.error(`Failed to resend role-change OTP email: ${err.message}`));

        return { message: 'OTP resent successfully' };
    }




    async deactivateAdmin(adminId, requestingAdminId) {
        if (String(adminId) === String(requestingAdminId)) {
            throw new ForbiddenError('You cannot deactivate your own account. Ask another super admin, or use direct DB access.');
        }

        const admin = await User.findOne({ _id: adminId, role: 'admin' });
        if (!admin) {
            throw new NotFoundError('Admin not found');
        }

        if (admin.adminSubRole === 'super_admin') {
            throw new ForbiddenError('You cannot deactivate another super admin account. This can only be done via direct DB access.');
        }

        if (admin.isActive === false) {
            throw new ConflictError('This admin account is already deactivated.');
        }

        admin.isActive = false;
        await admin.save();

        await this._invalidateSession(adminId);

        return {
            id: admin._id,
            name: admin.name,
            email: admin.email,
            isActive: admin.isActive
        };
    }



    
    async activateAdmin(adminId) {
        const admin = await User.findOne({ _id: adminId, role: 'admin' });
        if (!admin) {
            throw new NotFoundError('Admin not found');
        }

        if (admin.adminSubRole === 'super_admin') {
            throw new ForbiddenError('You cannot activate a super admin account. This can only be done via direct DB access.');
        }

        if (admin.isActive !== false) {
            throw new ConflictError('This admin account is already active.');
        }

        admin.isActive = true;
        await admin.save();

        return {
            id: admin._id,
            name: admin.name,
            email: admin.email,
            adminSubRole: admin.adminSubRole,
            isActive: admin.isActive
        };
    }
}

module.exports = new AdminManagementService();
