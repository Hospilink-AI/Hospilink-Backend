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

        // Longer than the AWS load balancer's 60 s idle timeout, so the
        // balancer never reuses a connection Node has already closed (502s)
        server.keepAliveTimeout = parseInt(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS, 10) || 65000;
        server.headersTimeout = server.keepAliveTimeout + 1000;

        // Socket.IO must be fully set up (Redis adapter, auth, handlers)
        // before the server takes connections
        const io = await initializeSocket(server);

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

        return { server, io };
    } catch (error) {
        logger.error(`Failed to start server: ${error.message}`);
        process.exit(1);
    }
};

// A promise rejected with no handler (a missed .catch on background work):
// logged with its stack, and the server keeps serving. Crashing here would
// drop every request and socket on this task over one stray promise.
process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? reason.stack : String(reason);
    logger.error(`Unhandled promise rejection (server kept running): ${detail}`);
});

// A thrown error nothing caught: the process may be in a broken state, so it
// stops. In-flight requests finish first, then the task exits with an error
// and AWS starts a fresh one.
let running = null;
let stopping = false;
process.on('uncaughtException', (error) => {
    logger.error(`Uncaught exception, shutting down: ${error && error.stack ? error.stack : error}`);
    if (running && !stopping) {
        stopping = true;
        shutdown('uncaughtException', running, 1);
    } else {
        process.exit(1);
    }
});

// Stop taking requests, let in-flight ones finish, then close sockets and
// connections. Sockets reconnect to the other tasks during a rolling deploy.
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 25000;

function shutdown(signal, { server, io }, exitCode = 0) {
    logger.info(`${signal} received, shutting down gracefully`);
    const force = setTimeout(() => {
        logger.warn('Shutdown timed out, exiting');
        process.exit(exitCode);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();

    // Disconnects every socket, then closes the HTTP server, which waits for
    // in-flight requests
    io.close(async () => {
        logger.info('HTTP server closed');
        await Promise.allSettled([
            require('mongoose').connection.close(),
            require('./src/config/redis').disconnect()
        ]);
        process.exit(exitCode);
    });
    // Idle keep-alive connections would otherwise hold the close open
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
}

startServer().then((started) => {
    if (started) {
        running = started;
        for (const signal of ['SIGTERM', 'SIGINT']) {
            process.on(signal, () => {
                if (stopping) return;
                stopping = true;
                shutdown(signal, started);
            });
        }
    }
});
