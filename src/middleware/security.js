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
        // Helmet with custom Content Security Policy (allows HTTP IP access & HTTPS domain access)
        helmet({
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://static.cloudflareinsights.com"],
                    scriptSrcElem: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://static.cloudflareinsights.com"],
                    scriptSrcAttr: ["'unsafe-inline'"],
                    styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
                    styleSrcElem: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
                    fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
                    imgSrc: ["'self'", "blob:", "data:", "https:"],
                    mediaSrc: ["'self'", "blob:"],
                    frameSrc: ["'self'"],
                    connectSrc: ["'self'", "blob:", "data:", "https://cloudflareinsights.com", "https://static.cloudflareinsights.com", "ws:", "wss:"],
                    workerSrc: ["'self'", "blob:"],
                    upgradeInsecureRequests: null
                }
            },
            crossOriginEmbedderPolicy: false,
            crossOriginResourcePolicy: { policy: "cross-origin" }
        }),

        // Custom security & anti-indexing headers
        (req, res, next) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'SAMEORIGIN');
            res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
            res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate');
            next();
        },

        // CORS protection: Enforce same-host requests for API endpoints (whitelisting public share endpoints)
        (req, res, next) => {
            const origin = req.headers.origin;
            if (origin && req.path.startsWith('/api/') && !req.path.startsWith('/api/share/public')) {
                try {
                    const originUrl = new URL(origin);
                    const host = req.get('host');
                    
                    if (host && originUrl.host !== host) {
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
