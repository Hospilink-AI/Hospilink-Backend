const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Hospital = require('../models/Hospital');
const MedicalStaff = require('../models/MedicalStaff');

/**
 * Socket.IO authentication middleware
 * Validates JWT token and attaches user information to socket
 */
async function authMiddleware(socket, next) {
    try {
        // Extract token from multiple possible locations for compatibility
        let token = socket.handshake.auth.token ||
            socket.handshake.query?.token ||
            socket.handshake.headers.token;

        // Also check for Authorization header format
        if (!token && socket.handshake.headers?.authorization) {
            const authHeader = socket.handshake.headers.authorization;
            if (authHeader.startsWith('Bearer ')) {
                token = authHeader.substring(7);
            }
        }

        if (!token) {
            console.error('No token provided. Checked: auth.token, query.token, headers.token, headers.authorization');
            return next(new Error('Authentication token required'));
        }

        // Avoid logging token content in production
        if (process.env.NODE_ENV === 'development') {
            console.log('Token received for authentication');
        }

        // Verify JWT token
        if (!process.env.JWT_SECRET) {
            console.error('JWT_SECRET environment variable is not configured');
            return next(new Error('Server configuration error'));
        }
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        if (!decoded || !decoded.id) {
            console.error('Token decoded but no user ID found');
            return next(new Error('Invalid token'));
        }

        console.log('Token decoded successfully for user:', decoded.id);

        // Fetch user from database
        const user = await User.findById(decoded.id).select('-password');

        if (!user) {
            console.error('User not found in database:', decoded.id);
            return next(new Error('User not found'));
        }

        console.log('User authenticated:', user._id, user.role);

        // Attach user to socket
        socket.user = user;

        // Fetch and attach role-specific profile
        if (user.role === 'hospital') {
            const hospital = await Hospital.findOne({ user: user._id });
            if (hospital) {
                socket.hospital = hospital;
                console.log('Hospital profile attached:', hospital._id);
            } else {
                return next(new Error('Hospital profile not found'));
            }
        } else if (user.role === 'staff') {
            const medicalStaff = await MedicalStaff.findOne({ user: user._id });
            if (medicalStaff) {
                socket.medicalStaff = medicalStaff;
                console.log('Medical staff profile attached:', medicalStaff._id, medicalStaff.jobRole);
            } else {
                return next(new Error('Medical staff profile not found'));
            }
        }

        next();
    } catch (error) {
        console.error('Socket authentication error:', error.message);
        console.error('Error stack:', error.stack);

        if (error.name === 'JsonWebTokenError') {
            return next(new Error('Invalid token'));
        }
        if (error.name === 'TokenExpiredError') {
            return next(new Error('Authentication failed'));
        }

        // Log the internal error server-side but return a generic message to the client
        return next(new Error('Authentication failed'));
    }
}

module.exports = authMiddleware;
