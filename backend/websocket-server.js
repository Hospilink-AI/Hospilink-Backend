/**
 * Standalone WebSocket Server for Railway
 * This server ONLY handles WebSocket connections
 * API requests are handled by Vercel
 */

// Load .env — try local path (local dev), fall back to cwd (Docker/ECS injects env vars directly)
require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const http = require('http');
const express = require('express');
const cors = require('cors');
const connectDB = require('./src/config/database');
const { initializeSocket } = require('./src/socket/index');
const websocketManager = require('./src/services/websocketManager');
const socketMonitor = require('./src/utils/socketMonitor');
const logger = require('./src/utils/logger');
const CronJobs = require('./src/utils/cronJobs');

const PORT = process.env.WEBSOCKET_PORT || process.env.PORT || 3001;

const app = express();

// CORS - Allow your Vercel frontend
app.use(cors({
    origin: [
        process.env.FRONTEND_URL,
        'http://localhost:3000',
        'http://localhost:5173'
    ],
    credentials: true
}));

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
    const { getAdapterInfo } = require('./src/socket/index');
    const adapterInfo = getAdapterInfo();
    
    res.json({
        status: 'OK',
        service: 'HospiLink WebSocket Server',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        adapter: {
            type: adapterInfo.adapter,
            redisEnabled: adapterInfo.redisAdapter,
            serverCount: adapterInfo.serverCount
        }
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        service: 'HospiLink WebSocket Server',
        status: 'running',
        websocket: 'Socket.IO',
        message: 'Connect using Socket.IO client'
    });
});

// Metrics endpoint (for monitoring/debugging)
app.get('/metrics', (req, res) => {
    const socketMonitor = require('./src/utils/socketMonitor');
    const metrics = socketMonitor.getMetrics();
    const roomStats = socketMonitor.getRoomStats();
    
    res.json({
        status: 'OK',
        metrics,
        rooms: roomStats
    });
});

// Start server
async function startWebSocketServer() {
    try {
        // Connect to MongoDB
        await connectDB();

        // Connect to Redis
        const redisConfig = require('./src/config/redis');
        await redisConfig.connect();

        // Create HTTP server
        const server = http.createServer(app);

        // Initialize Socket.IO with Redis adapter (async)
        const io = await initializeSocket(server);
        websocketManager.setIO(io);

        // Initialize monitoring
        socketMonitor.initialize(io);

        // Initialize Location Tracking Handler
        require('./src/socket/locationTracking.handler');

        // Start cron jobs
        CronJobs.startAllJobs();

        // Start server
        server.listen(PORT, '0.0.0.0', () => {
            logger.info(`WebSocket Server running on port ${PORT}`);
            
            // Log adapter status
            const { getAdapterInfo } = require('./src/socket/index');
            const adapterInfo = getAdapterInfo();
            logger.info(`Socket.IO adapter: ${adapterInfo.adapter}`);
        });

        // Graceful shutdown handler
        const gracefulShutdown = async (signal) => {
            logger.info(`${signal} received, shutting down gracefully...`);
            
            try {
                // Close HTTP server
                server.close(() => {
                    logger.info('HTTP server closed');
                });

                // Disconnect Redis pub/sub clients
                const { disconnectPubSubClients } = require('./src/config/redis');
                await disconnectPubSubClients();
                
                // Disconnect main Redis client
                await redisConfig.disconnect();
                
                logger.info('All connections closed');
                process.exit(0);
            } catch (error) {
                logger.error('Error during shutdown:', error.message);
                process.exit(1);
            }
        };

        // Register shutdown handlers
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    } catch (error) {
        logger.error(`Failed to start WebSocket server: ${error.message}`);
        process.exit(1);
    }
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logger.error(`Uncaught Exception: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
    process.exit(1);
});

startWebSocketServer();
