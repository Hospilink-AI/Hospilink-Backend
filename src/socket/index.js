const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const mongoose = require('mongoose');
const authMiddleware = require('./authMiddleware');
const roomManager = require('./roomManager');
const notificationService = require('../services/notificationService');
const Duty = require('../models/Duty');
const { getPubSubClients } = require('../config/redis');
const logger = require('../utils/logger');

let io = null;
let redisAdapterInitialized = false;

// Initialize Socket.IO server
async function initializeSocket(server) {
    // Create Socket.IO instance with CORS configuration
    io = new Server(server, {
        cors: {
            origin: process.env.FRONTEND_URL,
            credentials: true,
            methods: ['GET', 'POST']
        },
        pingTimeout: 60000,
        pingInterval: 25000,
        // Connection state recovery for reconnections
        connectionStateRecovery: {
            maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
            skipMiddlewares: true
        }
    });

    // Initialize Redis adapter for horizontal scaling
    try {
        const { pubClient, subClient } = await getPubSubClients();
        
        const adapter = createAdapter(pubClient, subClient, {
            // Key prefix for Redis keys used by adapter
            key: 'socket.io',
            // Request timeout for inter-server communication
            requestsTimeout: 5000
        });
        
        io.adapter(adapter);
        redisAdapterInitialized = true;
        
        logger.info('Socket.IO Redis adapter initialized - horizontal scaling enabled');
        
    } catch (error) {
        logger.error('Failed to initialize Redis adapter:', error?.message || 'Unknown error');
        logger.error('Error details:', error?.stack || error);
        logger.warn('Socket.IO will run in single-instance mode without horizontal scaling');
        redisAdapterInitialized = false;
        // Continue without Redis adapter - Socket.IO will use in-memory adapter
    }

    // Apply authentication middleware
    io.use(authMiddleware);

    // Handle connection events
    io.on('connection', async (socket) => {
        try {
            const user = socket.user;
            console.log(`User connected: ${user._id} (${user.role})`);

            // Join user to their personal room
            roomManager.joinUserRoom(socket, user._id.toString());

            // Join staff to role-based room
            if (user.role === 'staff' && socket.medicalStaff) {
                roomManager.joinRoleRoom(socket, user.role, socket.medicalStaff.jobRole);
            }

            // Handle admin tracking room
            if (user.role === 'admin') {
                // Join admin to tracking room for real-time updates
                socket.join('admin_tracking');
                console.log(`Admin ${user._id} joined admin tracking room`);
            }

            // Send current unread count on connection
            try {
                const unreadCount = await notificationService.getUnreadCount(user._id);
                socket.emit('unread_count', { count: unreadCount });
            } catch (error) {
                console.error('Error fetching unread count:', error);
            }

            // Handle get_missed_notifications event for reconnection
            socket.on('get_missed_notifications', async (data) => {
                try {
                    const { since } = data;
                    if (since) {
                        const missedNotifications = await notificationService.getNotificationsSince(
                            user._id,
                            new Date(since)
                        );
                        
                        // Emit missed notifications in chronological order
                        missedNotifications.forEach(notification => {
                            socket.emit('notification', notification.payload);
                        });
                        
                        console.log(`Sent ${missedNotifications.length} missed notifications to user ${user._id}`);
                    }
                } catch (error) {
                    console.error('Error fetching missed notifications:', error);
                }
            });

            // Handle duty tracking subscriptions (admin only)
            socket.on('subscribe_duty_tracking', async (data) => {
                try {
                    const { dutyId } = data;
                    
                    // Validate duty ID
                    if (!mongoose.Types.ObjectId.isValid(dutyId)) {
                        socket.emit('error', { message: 'Invalid duty ID' });
                        return;
                    }

                    // Check if user has permission to track this duty
                    const duty = await Duty.findById(dutyId);
                    
                    if (!duty) {
                        socket.emit('error', { message: 'Duty not found' });
                        return;
                    }

                    // Admin can track any active duty
                    if (user.role === 'admin' && ['assigned', 'enroute', 'in-progress'].includes(duty.status)) {
                        socket.join(`duty_tracking:${dutyId}`);
                        socket.emit('duty_tracking_subscribed', { dutyId });
                        console.log(`Admin ${user._id} subscribed to duty ${dutyId} tracking`);
                    } else {
                        socket.emit('error', { message: 'Permission denied' });
                    }
                } catch (error) {
                    console.error('Error in subscribe_duty_tracking:', error);
                    socket.emit('error', { message: 'Failed to subscribe to duty tracking' });
                }
            });

            // Handle unsubscribe from duty tracking
            socket.on('unsubscribe_duty_tracking', (data) => {
                try {
                    const { dutyId } = data;
                    socket.leave(`duty_tracking:${dutyId}`);
                    socket.emit('duty_tracking_unsubscribed', { dutyId });
                    console.log(`User ${user._id} unsubscribed from duty ${dutyId} tracking`);
                } catch (error) {
                    console.error('Error in unsubscribe_duty_tracking:', error);
                }
            });

            // Handle real-time active duties updates (admin only)
            socket.on('get_active_duties_updates', async (data) => {
                try {
                    if (user.role !== 'admin') {
                        socket.emit('error', { message: 'Permission denied' });
                        return;
                    }

                    const adminService = require('../services/admin.service');
                    const { role, location, status } = data || {};
                    
                    // Get current active duties
                    const result = await adminService.getActiveDuties({
                        role,
                        location,
                        status,
                        page: 1,
                        limit: 50 // Larger limit for real-time updates
                    });

                    socket.emit('active_duties_update', {
                        duties: result.duties,
                        summary: result.summary,
                        timestamp: new Date()
                    });
                } catch (error) {
                    console.error('Error in get_active_duties_updates:', error);
                    socket.emit('error', { message: 'Failed to get active duties updates' });
                }
            });

            // Handle disconnection
            socket.on('disconnect', () => {
                console.log(`User disconnected: ${user._id}`);
                roomManager.leaveAllRooms(socket);
            });

        } catch (error) {
            console.error('Error in socket connection handler:', error);
            socket.disconnect(true);
        }
    });

    // Handle connection errors
    io.on('connect_error', (error) => {
        console.error('Socket.IO connection error:', error);
    });

    return io;
}

// Get Socket.IO server instance
function getIO() {
    if (!io) {
        throw new Error('Socket.IO not initialized. Call initializeSocket first.');
    }
    return io;
}

// Check if Redis adapter is initialized
function isRedisAdapterEnabled() {
    return redisAdapterInitialized;
}

// Get adapter info for monitoring/debugging
function getAdapterInfo() {
    if (!io) {
        return { initialized: false, adapter: 'none' };
    }
    
    // Get server count - it's a method for Redis adapter, property for in-memory
    let serverCount = 1;
    try {
        if (typeof io.sockets.adapter.serverCount === 'function') {
            // Redis adapter - serverCount is async
            serverCount = 'async'; // Will be resolved by caller if needed
        } else if (typeof io.sockets.adapter.serverCount === 'number') {
            serverCount = io.sockets.adapter.serverCount;
        }
    } catch (error) {
        // Fallback to 1 if unable to get count
        serverCount = 1;
    }
    
    return {
        initialized: true,
        redisAdapter: redisAdapterInitialized,
        adapter: redisAdapterInitialized ? 'redis' : 'in-memory',
        serverCount
    };
}

// Helper function to broadcast to admin tracking room
function broadcastToAdmins(event, data) {
    if (io) {
        io.to('admin_tracking').emit(event, data);
    }
}

// Helper function to broadcast to specific duty tracking
function broadcastToDutyTracking(dutyId, event, data) {
    if (io) {
        io.to(`duty_tracking:${dutyId}`).emit(event, data);
    }
}


module.exports = {
    initializeSocket,
    getIO,
    broadcastToAdmins,
    broadcastToDutyTracking,
    isRedisAdapterEnabled,
    getAdapterInfo
};