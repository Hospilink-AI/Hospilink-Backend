const logger = require('./logger');

/**
 * Socket.IO Monitoring Utility
 * Tracks connection metrics and adapter health
 */
class SocketMonitor {
    constructor() {
        this.metrics = {
            totalConnections: 0,
            currentConnections: 0,
            peakConnections: 0,
            connectionErrors: 0,
            adapterErrors: 0,
            lastError: null,
            startTime: Date.now()
        };
        
        this.io = null;
        this.monitoringInterval = null;
    }

    /**
     * Initialize monitoring for Socket.IO instance
     * @param {Server} io - Socket.IO server instance
     */
    initialize(io) {
        if (!io) {
            logger.warn('SocketMonitor: Cannot initialize without io instance');
            return;
        }

        this.io = io;
        this._setupEventListeners();
        this._startPeriodicLogging();
        
        logger.info('Socket.IO monitoring initialized');
    }

    _setupEventListeners() {
        // Track connections
        this.io.on('connection', (socket) => {
            this.metrics.totalConnections++;
            this.metrics.currentConnections++;
            
            if (this.metrics.currentConnections > this.metrics.peakConnections) {
                this.metrics.peakConnections = this.metrics.currentConnections;
            }

            socket.on('disconnect', () => {
                this.metrics.currentConnections--;
            });

            socket.on('error', (error) => {
                this.metrics.connectionErrors++;
                this.metrics.lastError = {
                    type: 'connection',
                    message: error.message,
                    timestamp: new Date()
                };
            });
        });

        // Track adapter errors if Redis adapter is used
        if (this.io.sockets.adapter.on) {
            this.io.sockets.adapter.on('error', (error) => {
                this.metrics.adapterErrors++;
                this.metrics.lastError = {
                    type: 'adapter',
                    message: error.message,
                    timestamp: new Date()
                };
                logger.error('Socket.IO adapter error:', error.message);
            });
        }
    }

    _startPeriodicLogging() {
        // Log metrics every 5 minutes
        this.monitoringInterval = setInterval(() => {
            this._logMetrics();
        }, 5 * 60 * 1000);
    }

    _logMetrics() {
        const uptime = Math.floor((Date.now() - this.metrics.startTime) / 1000);
        const { getAdapterInfo } = require('../socket/index');
        const adapterInfo = getAdapterInfo();

        logger.info('Socket.IO Metrics:', {
            uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
            currentConnections: this.metrics.currentConnections,
            peakConnections: this.metrics.peakConnections,
            totalConnections: this.metrics.totalConnections,
            connectionErrors: this.metrics.connectionErrors,
            adapterErrors: this.metrics.adapterErrors,
            adapter: adapterInfo.adapter,
            serverCount: adapterInfo.serverCount
        });
    }

    /**
     * Get current metrics
     * @returns {Object} Current metrics
     */
    getMetrics() {
        const uptime = Math.floor((Date.now() - this.metrics.startTime) / 1000);
        const { getAdapterInfo } = require('../socket/index');
        const adapterInfo = getAdapterInfo();

        return {
            ...this.metrics,
            uptime,
            adapter: adapterInfo
        };
    }

    /**
     * Get room information for debugging
     * @returns {Object} Room statistics
     */
    getRoomStats() {
        if (!this.io) return null;

        const rooms = this.io.sockets.adapter.rooms;
        const roomStats = {
            totalRooms: rooms.size,
            rooms: []
        };

        // Sample first 10 rooms for debugging
        let count = 0;
        for (const [roomName, sockets] of rooms.entries()) {
            if (count >= 10) break;
            
            // Skip socket.id rooms (personal rooms)
            if (!roomName.includes(':')) continue;
            
            roomStats.rooms.push({
                name: roomName,
                socketCount: sockets.size
            });
            count++;
        }

        return roomStats;
    }

    /**
     * Stop monitoring
     */
    stop() {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }
        logger.info('Socket.IO monitoring stopped');
    }
}

// Singleton instance
const monitor = new SocketMonitor();

module.exports = monitor;
