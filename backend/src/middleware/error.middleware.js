const logger = require('../utils/logger');

// Custom Error Classes for better error handling
class AppError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
        this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
        this.isOperational = true;

        Error.captureStackTrace(this, this.constructor);
    }
}

class ValidationError extends AppError {
    constructor(message) {
        super(message, 400);
        this.name = 'ValidationError';
    }
}

class NotFoundError extends AppError {
    constructor(message = 'Resource not found') {
        super(message, 404);
        this.name = 'NotFoundError';
    }
}

class UnauthorizedError extends AppError {
    constructor(message = 'Unauthorized access') {
        super(message, 401);
        this.name = 'UnauthorizedError';
    }
}

class ForbiddenError extends AppError {
    constructor(message = 'Forbidden access') {
        super(message, 403);
        this.name = 'ForbiddenError';
    }
}

class ConflictError extends AppError {
    constructor(message = 'Resource already exists') {
        super(message, 409);
        this.name = 'ConflictError';
    }
}

class RateLimitError extends AppError {
    constructor(message = 'Too many requests') {
        super(message, 429);
        this.name = 'RateLimitError';
    }
}

class UnprocessableEntityError extends AppError {
    constructor(message = 'Unprocessable entity') {
        super(message, 422);
        this.name = 'UnprocessableEntityError';
    }
}

class GoneError extends AppError {
    constructor(message = 'Resource no longer available') {
        super(message, 410);
        this.name = 'GoneError';
    }
}

// Error handler middleware
const errorHandler = (err, req, res, next) => {
    err.statusCode = err.statusCode || 500;
    err.status = err.status || 'error';

    // Log the error
    logError(err, req);

    // Development error response (detailed)
    if (process.env.NODE_ENV === 'development') {
        sendErrorDev(err, res);
    } 
    // Production error response (user-friendly)
    else {
        sendErrorProd(err, res);
    }
};

// Fields that must never appear in logs
const SENSITIVE_BODY_FIELDS = [
    'password',
    'newPassword',
    'confirmPassword',
    'currentPassword',
    'otp',
    'token',
    'secret',
    'apiKey',
    'privateKey',
];

/**
 * Returns a shallow copy of body with sensitive fields replaced by '[REDACTED]'.
 * Handles null/non-object bodies safely.
 */
const sanitizeBody = (body) => {
    if (body === null || body === undefined) return body;
    if (typeof body !== 'object' || Array.isArray(body)) return body;
    const sanitized = { ...body };
    for (const field of SENSITIVE_BODY_FIELDS) {
        if (field in sanitized) sanitized[field] = '[REDACTED]';
    }
    return sanitized;
};

// Function to log errors
const logError = (err, req) => {
    const errorLog = {
        timestamp: new Date().toISOString(),
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        errorName: err.name,
        errorMessage: err.message,
        statusCode: err.statusCode,
        stack: err.stack,
        body: sanitizeBody(req.body),
        params: req.params,
        query: req.query,
        user: req.user ? { id: req.user._id || req.user.id, role: req.user.role } : 'Anonymous'
    };

    if (err.statusCode >= 500) {
        logger.error(JSON.stringify(errorLog, null, 2));
    } else {
        logger.warn(JSON.stringify(errorLog, null, 2));
    }
};

// Send error in development environment
const sendErrorDev = (err, res) => {
    res.status(err.statusCode).json({
        success: false,
        status: err.status,
        error: err,
        message: err.message,
        stack: err.stack
    });
};

// Send error in production environment
const sendErrorProd = (err, res) => {
    // Operational, trusted error: send message to client
    if (err.isOperational) {
        res.status(err.statusCode).json({
            success: false,
            status: err.status,
            message: err.message
        });
    } else {
        // Log the error for debugging
        logger.error('UNEXPECTED ERROR', err);

        // Send generic message
        res.status(500).json({
            success: false,
            status: 'error',
            message: 'Something went wrong!'
        });
    }
};

// Handle MongoDB duplicate key errors
const handleDuplicateFieldsDB = (err) => {
    const value = err.errmsg.match(/(["'])(\\?.)*?\1/)[0];
    const message = `Duplicate field value: ${value}. Please use another value!`;
    return new AppError(message, 400);
};

// Handle MongoDB validation errors
const handleValidationErrorDB = (err) => {
    const errors = Object.values(err.errors).map(el => el.message);
    const message = `Invalid input data. ${errors.join('. ')}`;
    return new AppError(message, 400);
};

// Handle MongoDB cast errors
const handleCastErrorDB = (err) => {
    const message = `Invalid ${err.path}: ${err.value}`;
    return new AppError(message, 400);
};

// Handle JWT errors
const handleJWTError = () => {
    return new AppError('Invalid token. Please log in again!', 401);
};

// Handle JWT expired errors
const handleJWTExpiredError = () => {
    return new AppError('Your token has expired! Please log in again.', 401);
};

// Global error handler for different error types
const globalErrorHandler = (err, req, res, next) => {
    let error = { ...err };
    error.message = err.message;

    // Log original error
    logger.error(`Original Error: ${err.message}`);

    // Handle specific error types
    if (error.code === 11000) error = handleDuplicateFieldsDB(error);
    if (error.name === 'ValidationError') error = handleValidationErrorDB(error);
    if (error.name === 'CastError') error = handleCastErrorDB(error);
    if (error.name === 'JsonWebTokenError') error = handleJWTError();
    if (error.name === 'TokenExpiredError') error = handleJWTExpiredError();

    // Pass to error handler
    errorHandler(error, req, res, next);
};

// Async error handler wrapper (for async/await routes)
const asyncHandler = (fn) => {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
};

// 404 Not Found middleware
const notFoundHandler = (req, res, next) => {
    const error = new NotFoundError(`Route ${req.originalUrl} not found`);
    next(error);
};

// Rate limiting error handler
const rateLimitHandler = (req, res, next) => {
    const error = new RateLimitError();
    next(error);
};

module.exports = {
    AppError,
    ValidationError,
    NotFoundError,
    UnauthorizedError,
    ForbiddenError,
    ConflictError,
    RateLimitError,
    UnprocessableEntityError,
    GoneError,
    errorHandler,
    globalErrorHandler,
    asyncHandler,
    notFoundHandler,
    rateLimitHandler,
    sendErrorDev,
    sendErrorProd
};