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
 * Auth / Login rate limiter: 5 failed attempts per 15 minutes per IP
 * Uses skipSuccessfulRequests so valid logins are never blocked.
 */
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Maximum 5 failed attempts
    skipSuccessfulRequests: true,
    message: { error: 'Too many failed login attempts. Please try again after 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const authLimiter = loginLimiter;

/**
 * Upload rate limiter: 2000 requests per minute per IP (Generous for parallel chunk uploads)
 */
const uploadLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 2000,
    message: { error: 'Too many upload requests from this IP, please try again after 1 minute.' },
    standardHeaders: true,
    legacyHeaders: false,
});

module.exports = {
    globalLimiter,
    authLimiter,
    loginLimiter,
    uploadLimiter
};
