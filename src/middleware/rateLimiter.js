const rateLimit = require('express-rate-limit');

/**
 * Global rate limiter: 5,000 requests per 15 minutes (Generous for video streaming & thumbnails)
 */
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5000,
    message: { error: 'Too many requests from this IP, please try again in a few minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
        // Skip rate limiting for streaming and file downloads
        return req.path.includes('/stream') || req.path.includes('/download');
    }
});

/**
 * Auth rate limiter: 30 requests per 15 minutes per IP
 * Used for login/authentication endpoints
 */
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 30,
    message: { error: 'Too many login attempts from this IP, please try again after 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
});

/**
 * Upload rate limiter: 100 requests per minute per IP
 */
const uploadLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100,
    message: { error: 'Too many upload requests from this IP, please try again after 1 minute.' },
    standardHeaders: true,
    legacyHeaders: false,
});

module.exports = {
    globalLimiter,
    authLimiter,
    uploadLimiter
};
