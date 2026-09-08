require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const { isSetupComplete } = require('./src/config');
const telegram = require('./src/telegram');
const db = require('./src/db');

// Import middleware
const getSecurityMiddleware = require('./src/middleware/security');
const authMiddleware = require('./src/middleware/auth');
const { globalLimiter } = require('./src/middleware/rateLimiter');

// Import routes
const authRouter = require('./src/routes/auth');
const filesRouter = require('./src/routes/files');
const foldersRouter = require('./src/routes/folders');
const setupRouter = require('./src/routes/setup');
const settingsRouter = require('./src/routes/settings');

const app = express();

// Apply security middleware
const securityMiddleware = getSecurityMiddleware();
securityMiddleware.forEach(mw => app.use(mw));

// Core middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(globalLimiter);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Mount routes
app.use('/api/setup', setupRouter);
app.use('/api/auth', authRouter);
app.use('/api/folders', foldersRouter);
app.use('/api/files', filesRouter);
app.use('/api/settings', settingsRouter);

// SPA fallback — serve index.html for all non-API GET routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

async function startServer() {
  try {
    // Initialize SQLite database first
    await db.initialize();
    console.log('[DB] Database ready.');

    const port = process.env.PORT || 3000;
    const server = app.listen(port, () => {
      console.log(`\n  ╔══════════════════════════════════════════╗`);
      console.log(`  ║  TeleDrive is running!                   ║`);
      console.log(`  ║  Local:  http://localhost:${port}            ║`);
      console.log(`  ╚══════════════════════════════════════════╝\n`);
    });

    // Initialize Telegram client if setup is complete (in background)
    if (isSetupComplete()) {
      console.log('[Telegram] Initializing Telegram client...');
      telegram.initialize(
        parseInt(process.env.API_ID),
        process.env.API_HASH,
        process.env.BOT_TOKEN
      ).then(() => {
        console.log('[Telegram] Client connected successfully.');
      }).catch(err => {
        console.error('[Telegram] Initialization failed:', err.message);
      });
    } else {
      console.log('[Setup] Setup incomplete. Visit the app to complete configuration.');
    }

    // Graceful shutdown
    const shutdown = async (signal) => {
      console.log(`\n[Server] Received ${signal}, shutting down gracefully...`);
      server.close();
      try {
        const client = telegram.getClient();
        if (client) {
          await client.disconnect();
          console.log('[Telegram] Client disconnected.');
        }
      } catch (e) {
        // Ignored
      }
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

  } catch (error) {
    console.error('[Server] Failed to start:', error);
    process.exit(1);
  }
}

startServer();
