// const jwt = require('jsonwebtoken');
// const User = require('../models/User');
// const { UnauthorizedError, ForbiddenError, asyncHandler } = require('./error.middleware');
// const cacheService = require('../services/cache.service');


// exports.protect = asyncHandler(async (req, res, next) => {
//     let token;

//     if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
//         token = req.headers.authorization.split(' ')[1];
//     }

//     if (!token) {
//         throw new UnauthorizedError('Access denied. No token provided.');
//     }

//     // Check if token is blacklisted
//     const blacklistKey = `blacklist:${token}`;
//     const isBlacklisted = await cacheService.get(blacklistKey);
//     if (isBlacklisted) {
//         throw new UnauthorizedError('Token has been invalidated. Please login again.');
//     }

//     try {
//         const decoded = jwt.verify(token, process.env.JWT_SECRET);

//         // Check cache for user session
//         const sessionKey = `session:${decoded.id}`;
//         const cachedSession = await cacheService.get(sessionKey);

//         // if (cachedSession) {
//         //     req.user = cachedSession;
//         //     return next();
//         // }
//         if (cachedSession) {
//             req.user = {
//                 _id: cachedSession._id || cachedSession.id,   // 🔥 IMPORTANT
//                 email: cachedSession.email,
//                 role: cachedSession.role
//             };
//             return next();
//         }

//         // Fallback to database
//         const user = await User.findById(decoded.id);
//         if (!user) {
//             throw new UnauthorizedError('User not found');
//         }

//         // Cache session for future requests
//         await cacheService.set(sessionKey, {
//             // id: user._id,
//             _id: user._id,
//             email: user.email,
//             role: user.role
//         }, 86400);

//         // req.user = user;
//         req.user = {
//             _id: user._id,
//             email: user.email,
//             role: user.role
//         };
//         next();
//     } catch (error) {
//         throw new UnauthorizedError('Invalid token');
//     }
// });

// exports.authorize = (...roles) => {
//     return (req, res, next) => {
//         if (!roles.includes(req.user.role)) {
//             return next(new ForbiddenError(`User role ${req.user.role} is not authorized to access this route`));
//         }
//         next();
//     };
// };
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { UnauthorizedError, ForbiddenError, asyncHandler } = require('./error.middleware');
const cacheService = require('../services/cache.service');
 
 
exports.protect = asyncHandler(async (req, res, next) => {
    let token;
    
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }
    
    if (!token) {
        throw new UnauthorizedError('Access denied. No token provided.');
    }
    
    // Check if token is blacklisted
    const blacklistKey = `blacklist:${token}`;
    const isBlacklisted = await cacheService.get(blacklistKey);
    if (isBlacklisted) {
        throw new UnauthorizedError('Token has been invalidated. Please login again.');
    }
    
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Check cache for user session
        const sessionKey = `session:${decoded.id}`;
        const cachedSession = await cacheService.get(sessionKey);
        
        if (cachedSession) {
            // Normalize: ensure both _id and id are available
            req.user = { ...cachedSession, _id: cachedSession._id || cachedSession.id };
            return next();
        }
        
        // Fallback to database
        const user = await User.findById(decoded.id);
        if (!user) {
            throw new UnauthorizedError('User not found');
        }
        
        // Cache session for future requests
        await cacheService.set(sessionKey, {
            _id: user._id,
            id: user._id,
            email: user.email,
            role: user.role
        }, 86400);
        
        req.user = user;
        next();
    } catch (error) {
        throw new UnauthorizedError('Invalid token');
    }
});
 
exports.authorize = (...roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return next(new ForbiddenError(`User role ${req.user.role} is not authorized to access this route`));
        }
        next();
    };
};
 