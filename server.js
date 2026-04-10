require('dotenv').config();
const http = require('http');
const app = require('./src/app');
const connectDB = require('./src/config/database');
const logger = require('./src/utils/logger');
const { initializeSocket } = require('./src/socket/index');
const websocketManager = require('./src/services/websocketManager');

const PORT = process.env.PORT || 3000;
const { initAgent } = require('./agent/api');
const CronJobs = require('./src/utils/cronJobs');
const jobProcessor = require('./src/jobs/processDelayedJobs');

// Start server
const startServer = async () => {
    try {
        // Connect to MongoDB
        await connectDB();

        // Start cron jobs only after DB is ready (local/persistent env only)
        if (process.env.ENABLE_CRON_JOBS === 'true') {
            CronJobs.startAllJobs();
        }

        // Connect to Redis
        const redisConfig = require('./src/config/redis');
        await redisConfig.connect();

        // Initialize Agent services
        await initAgent();

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
            logger.info(`Redis Connected`);
            logger.info(`Agent Services initialized`);
            logger.info(`WebSocket server initialized`);
        });
        // Background Job Processor 
        if (process.env.ENABLE_JOB_PROCESSOR === 'true') {
            setInterval(async () => {
                try {
                    await jobProcessor.process();
                } catch (err) {
                    console.error('Job processor failed:', err);
                }
            }, 60 * 1000); // every 1 min
        }
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
