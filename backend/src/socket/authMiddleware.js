const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Hospital = require('../models/Hospital');
const MedicalStaff = require('../models/MedicalStaff');
const cacheService = require('../services/cache.service');
const logger = require('../utils/logger');

// The profile id and job role a socket needs. Cleared with the profile cache.
const SOCKET_PROFILE_TTL = 3600;
const socketProfileKey = (userId) => `socketprofile:${userId}`;

/**
 * Socket.IO authentication middleware.
 * Validates JWT token, checks the logout blacklist, and attaches
 * user + role-specific profile to the socket.
 */
async function authMiddleware(socket, next) {
    try {
        // ── 1. Extract token ──────────────────────────────────────────────────
        let token = socket.handshake.auth.token ||
            socket.handshake.headers.token;

        if (!token && socket.handshake.headers.authorization) {
            const authHeader = socket.handshake.headers.authorization;
            if (authHeader.startsWith('Bearer ')) {
                token = authHeader.substring(7);
            }
        }

        if (!token) {
            return next(new Error('Authentication token required'));
        }

        // ── 2. Verify JWT signature ───────────────────────────────────────────
        if (!process.env.JWT_SECRET) {
            logger.error('JWT_SECRET is not configured — cannot authenticate socket');
            return next(new Error('Server configuration error'));
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        if (!decoded || !decoded.id) {
            return next(new Error('Invalid token'));
        }

        // ── 3. Blacklist and cached session, profile and suspension ─────────
        // One Redis round trip. After a deploy every app reconnects at once,
        // so a reconnect should not need the database. Fails closed like the
        // HTTP middleware: if Redis can't be read, the connection is refused.
        const userId = String(decoded.id);
        const [isBlacklisted, session, cachedProfile, staffSuspension, hospitalSuspension] =
            await cacheService.getManyStrict([
                `blacklist:${token}`,
                `session:${userId}`,
                socketProfileKey(userId),
                `suspension:staff:${userId}`,
                `suspension:hospital:${userId}`
            ]);
        if (isBlacklisted) {
            logger.warn(`Socket connection rejected: blacklisted token for user ${userId}`);
            return next(new Error('Token has been invalidated. Please login again.'));
        }

        // ── 4. Load user ──────────────────────────────────────────────────────
        // The cached session is the one HTTP sign-in checks use. Requesting
        // deletion clears it, so a cached session is never one scheduled for
        // deletion. Plain objects with only what the handlers read: a socket
        // lives for hours, and full documents on tens of thousands add up.
        let user;
        if (session) {
            user = {
                _id: session._id || session.id,
                role: session.role,
                name: session.name,
                isActive: session.isActive
            };
        } else {
            user = await User.findById(userId).select('_id role name isActive deletion').lean();
            if (!user) {
                return next(new Error('User not found'));
            }
            if (user.deletion?.requestedAt) {
                return next(new Error('This account is scheduled for deletion. Sign in again to keep it.'));
            }
            delete user.deletion;
        }
        // Same account checks as the HTTP auth middleware
        if (user.role === 'admin' && user.isActive === false) {
            return next(new Error('This admin account has been deactivated.'));
        }

        user.id = String(user._id);
        socket.user = user;

        // ── 5. Role profile and suspension ────────────────────────────────────
        if (user.role === 'hospital' || user.role === 'staff') {
            const suspension = user.role === 'staff' ? staffSuspension : hospitalSuspension;
            let profile = cachedProfile && cachedProfile.role === user.role ? cachedProfile.profile : null;
            let isSuspended = suspension ? suspension.isSuspended : null;
            let suspensionReason = suspension ? suspension.suspensionReason : null;

            if (!profile || isSuspended === null) {
                const Model = user.role === 'hospital' ? Hospital : MedicalStaff;
                const fields = user.role === 'hospital'
                    ? '_id isSuspended suspensionReason'
                    : '_id jobRole isSuspended suspensionReason';
                const doc = await Model.findOne({ user: user._id }).select(fields).lean();
                if (!doc) {
                    return next(new Error(user.role === 'hospital'
                        ? 'Hospital profile not found'
                        : 'Medical staff profile not found'));
                }
                profile = user.role === 'hospital' ? { _id: doc._id } : { _id: doc._id, jobRole: doc.jobRole };
                isSuspended = doc.isSuspended || false;
                suspensionReason = doc.suspensionReason || null;
                // Same key and shape as the HTTP suspension check
                cacheService.pipeline([
                    { type: 'set', key: socketProfileKey(userId), value: { role: user.role, profile }, ttl: SOCKET_PROFILE_TTL },
                    { type: 'set', key: `suspension:${user.role}:${userId}`, value: { isSuspended, suspensionReason }, ttl: 300 }
                ]).catch(() => {});
            }

            if (isSuspended) {
                const reason = suspensionReason
                    ? `Your account has been suspended. Reason: ${suspensionReason}. Please contact support.`
                    : 'Your account has been suspended. Please contact support.';
                logger.warn(`Socket connection rejected: suspended ${user.role} account for user ${user._id}`);
                return next(new Error(reason));
            }

            if (user.role === 'hospital') socket.hospital = profile;
            else socket.medicalStaff = profile;
        }

        next();

    } catch (error) {
        // Log full detail server-side, return generic message to client
        logger.error(`Socket auth error: ${error.message}`);

        if (error.name === 'JsonWebTokenError') {
            return next(new Error('Invalid token'));
        }
        if (error.name === 'TokenExpiredError') {
            return next(new Error('Token expired. Please login again.'));
        }

        return next(new Error('Authentication failed'));
    }
}

module.exports = authMiddleware;
