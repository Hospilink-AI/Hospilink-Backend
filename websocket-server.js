/**
 * Standalone WebSocket Server for Railway
 * This server ONLY handles WebSocket connections
 * API requests are handled by Vercel
 */

require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const connectDB = require('./src/config/database');
const { initializeSocket } = require('./src/socket/index');
const websocketManager = require('./src/services/websocketManager');
const logger = require('./src/utils/logger');

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
    res.json({
        status: 'OK',
        service: 'HospiLink WebSocket Server',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
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

// Start server
async function startWebSocketServer() {
    try {
        // Connect to MongoDB
        await connectDB();
        logger.info('MongoDB Connected');

        // Connect to Redis
        const redisConfig = require('./src/config/redis');
        await redisConfig.connect();
        logger.info('Redis Connected');

        // Create HTTP server
        const server = http.createServer(app);

        // Initialize Socket.IO
        const io = initializeSocket(server);
        websocketManager.setIO(io);
        logger.info('Socket.IO initialized');

        // Initialize Location Tracking Handler
        require('./src/socket/locationTracking.handler');
        logger.info('Location tracking initialized');

        // Start server
        server.listen(PORT, '0.0.0.0', () => {
            logger.info(`WebSocket Server running on port ${PORT}`);
            logger.info(`Health check: http://localhost:${PORT}/health`);
        });

    } catch (error) {
        logger.error(`Failed to start WebSocket server: ${error.message}`);
        process.exit(1);
    }
}

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

// Graceful shutdown
process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down gracefully...');
    process.exit(0);
});

process.on('SIGINT', () => {
    logger.info('SIGINT received, shutting down gracefully...');
    process.exit(0);
});

startWebSocketServer();
