const logger = require('../utils/logger');

// Custom Error Classes for better error handling
class AppError extends Error {
    // `code` is an optional stable, machine-readable identifier (e.g.
    // 'PROFILE_REQUIRED_FOR_APPLICATION') so clients can branch on it instead
    // of string-matching `message`.
    constructor(message, statusCode, code) {
        super(message);
        this.statusCode = statusCode;
        this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
        this.isOperational = true;
        if (code) this.code = code;

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
    constructor(message = 'Unprocessable entity', code) {
        super(message, 422, code);
        this.name = 'UnprocessableEntityError';
    }
}

class GoneError extends AppError {
    constructor(message = 'Resource no longer available') {
        super(message, 410);
        this.name = 'GoneError';
    }
}

/**
 * The one error handler for every route (app.js). Turns any error into a
 * status and a safe message, and logs it once:
 *   - 5xx: logged as an error with its stack; in production the client only
 *     sees "Internal server error"
 *   - 4xx: one info line (method, path, status, code), without the message,
 *     which can echo what the user sent
 */
function normalizeError(err) {
    // Our own errors (ValidationError, NotFoundError, ...)
    if (err && err.isOperational) {
        return { status: err.statusCode || 500, message: err.message, code: err.code };
    }
    // Mongoose: a value that isn't the right type (e.g. a bad id)
    if (err && err.name === 'CastError') {
        return { status: 400, message: `Invalid ${err.path}` };
    }
    // Mongoose: schema validation failed on save
    if (err && err.name === 'ValidationError' && err.errors) {
        const details = Object.values(err.errors).map(e => e.message).join('. ');
        return { status: 400, message: details || 'Invalid input' };
    }
    // MongoDB: unique index (the value itself isn't echoed)
    if (err && err.code === 11000) {
        const field = Object.keys(err.keyValue || err.keyPattern || {})[0];
        return { status: 409, message: field ? `A record with this ${field} already exists` : 'This record already exists' };
    }
    // express.json: malformed or oversized body
    if (err && err.type === 'entity.parse.failed') return { status: 400, message: 'Request body is not valid JSON' };
    if (err && err.type === 'entity.too.large') return { status: 413, message: 'Request body is too large' };
    // multer: uploads
    if (err && err.name === 'MulterError') {
        return err.code === 'LIMIT_FILE_SIZE'
            ? { status: 413, message: 'File is too large' }
            : { status: 400, message: err.message };
    }
    // jsonwebtoken
    if (err && (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError')) {
        return { status: 401, message: err.name === 'TokenExpiredError' ? 'Token expired. Please log in again.' : 'Invalid token' };
    }
    // Other libraries that set a 4xx status (e.g. CORS, http-errors)
    const status = Number(err && (err.statusCode || err.status));
    if (status >= 400 && status < 500) return { status, message: err.message };
    return { status: 500, message: (err && err.message) || 'Internal server error' };
}

// Express needs all four arguments to treat this as an error handler
const errorHandler = (err, req, res, next) => {
    const { status, message, code } = normalizeError(err);
    const production = process.env.NODE_ENV === 'production';
    const context = {
        requestId: req.requestId,
        method: req.method,
        path: (req.originalUrl || req.url || '').split('?')[0],
        status,
        ...(code && { code })
    };

    if (status >= 500) {
        logger.error('Request failed', err instanceof Error ? err : new Error(String(err)), context);
    } else {
        logger.info('Request refused', context);
    }

    if (res.headersSent) return;
    res.status(status).json({
        success: false,
        message: status >= 500 && production ? 'Internal server error' : message,
        ...(code && { code }),
        ...(!production && status >= 500 && err && err.stack && { stack: err.stack }),
        requestId: req.requestId
    });
};

// Async error handler wrapper (for async/await routes)
const asyncHandler = (fn) => {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
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
    normalizeError,
    asyncHandler
};