const helmet = require('helmet');

/**
 * Security Middleware Factory
 * Returns an array of security middlewares including Helmet with custom CSP,
 * custom headers, and Same-Origin CORS enforcement.
 * 
 * @returns {Array<Function>} Array of Express middleware functions
 */
const securityMiddleware = () => {
    return [
        // Helmet with custom Content Security Policy
        helmet({
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    scriptSrc: ["'self'"],
                    styleSrc: ["'self'", "'unsafe-inline'"],
                    imgSrc: ["'self'", "blob:", "data:"],
                    mediaSrc: ["'self'", "blob:"],
                    frameSrc: ["'self'"],
                    connectSrc: ["'self'"],
                    fontSrc: ["'self'"]
                }
            }
        }),

        // Custom security headers
        (req, res, next) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'SAMEORIGIN');
            res.setHeader('Referrer-Policy', 'no-referrer');
            res.setHeader('X-XSS-Protection', '1; mode=block');
            next();
        },

        // CORS: Same origin only (no cross-origin allowed by default)
        (req, res, next) => {
            res.setHeader('Access-Control-Allow-Origin', 'same-origin');
            const origin = req.headers.origin;
            if (origin) {
                try {
                    const originUrl = new URL(origin);
                    const hostUrl = new URL(`${req.protocol}://${req.get('host')}`);
                    
                    if (originUrl.origin !== hostUrl.origin) {
                        return res.status(403).json({ error: 'CORS policy violation: Cross-origin requests are not allowed' });
                    }
                } catch (e) {
                    return res.status(403).json({ error: 'Invalid origin header' });
                }
            }
            next();
        }
    ];
};

module.exports = securityMiddleware;
