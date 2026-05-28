const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Hospital = require('../models/Hospital');
const MedicalStaff = require('../models/MedicalStaff');
const cacheService = require('../services/cache.service');
const logger = require('../utils/logger');

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

        // ── 3. Check logout blacklist ─────────────────────────────────────────
        // Mirrors the same check in the HTTP auth middleware so that a token
        // invalidated via logout cannot be reused for WebSocket connections.
        const isBlacklisted = await cacheService.get(`blacklist:${token}`);
        if (isBlacklisted) {
            logger.warn(`Socket connection rejected: blacklisted token for user ${decoded.id}`);
            return next(new Error('Token has been invalidated. Please login again.'));
        }

        // ── 4. Load user ──────────────────────────────────────────────────────
        const user = await User.findById(decoded.id).select('-password');

        if (!user) {
            return next(new Error('User not found'));
        }

        socket.user = user;

        // ── 5. Attach role-specific profile ───────────────────────────────────
        if (user.role === 'hospital') {
            const hospital = await Hospital.findOne({ user: user._id });
            if (!hospital) {
                return next(new Error('Hospital profile not found'));
            }
            socket.hospital = hospital;

        } else if (user.role === 'staff') {
            const medicalStaff = await MedicalStaff.findOne({ user: user._id });
            if (!medicalStaff) {
                return next(new Error('Medical staff profile not found'));
            }
            socket.medicalStaff = medicalStaff;
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
