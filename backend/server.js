// Load .env — try repo root (local dev), fall back to cwd (Docker/ECS injects env vars directly)
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const http = require('http');
const app = require('./src/app');
const connectDB = require('./src/config/database');
const logger = require('./src/utils/logger');
const { initializeSocket } = require('./src/socket/index');
const websocketManager = require('./src/services/websocketManager');

const PORT = process.env.PORT || 3000;
const CronJobs = require('./src/utils/cronJobs');

// Start server
const startServer = async () => {
    try {

         // Validate required environment variables before starting
        if (!process.env.JWT_SECRET) {
            throw new Error('JWT_SECRET environment variable is not set. Cannot start server without a signing secret.');
        }

        // Parallelize independent operations for faster startup
        const [mongoResult, redisResult] = await Promise.allSettled([
            connectDB(),
            require('./src/config/redis').connect()
        ]);

        // Check MongoDB connection
        if (mongoResult.status === 'rejected') {
            throw new Error(`MongoDB connection failed: ${mongoResult.reason.message}`);
        }

        // Check Redis connection (non-critical, can continue without it)
        if (redisResult.status === 'rejected') {
            logger.warn(`Redis connection failed: ${redisResult.reason.message}`);
            logger.warn('Continuing without Redis - some features may be limited');
        }

        // Start cron jobs only after DB is ready (local/persistent env only)
        if (process.env.ENABLE_CRON_JOBS === 'true') {
            CronJobs.startAllJobs();
        }

        // Create HTTP server
        const server = http.createServer(app);

        // Initialize Socket.IO
        const io = initializeSocket(server);
        
        // Set Socket.IO instance in WebSocket Manager
        websocketManager.setIO(io);

        // Initialize Location Tracking Handler
        require('./src/socket/locationTracking.handler');

        // Start HTTP server
        server.listen(PORT, () => {
            logger.info(`Server running on port ${PORT}`);
            logger.info(`API Documentation: http://localhost:${PORT}/api-docs`);
            logger.info(`MongoDB Connected`);
            logger.info(`Redis ${redisResult.status === 'fulfilled' ? 'Connected' : 'Unavailable'}`);
            logger.info(`WebSocket server initialized`);
        });
    } catch (error) {
        logger.error(`Failed to start server: ${error.message}`);
        process.exit(1);
    }
};

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logger.error(`Uncaught Exception: ${error.message}`);
    process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
    process.exit(1);
});

startServer();
