/**
 * WebSocket Manager Service
 * Handles emitting notifications to Socket.IO rooms
 */
class WebSocketManager {
    constructor(io) {
        this.io = io;
    }

    /**
     * Set Socket.IO instance (for delayed initialization)
     * @param {Server} io - Socket.IO server instance
     */
    setIO(io) {
        this.io = io;
    }

    /**
     * Emit event to specific user
     * @param {string} userId - User ID
     * @param {string} event - Event name
     * @param {Object} payload - Event payload
     */
    emitToUser(userId, event, payload) {
        try {
            if (!this.io) {
                console.error('Socket.IO not initialized');
                return;
            }
            
            const roomName = `user:${userId}`;
            this.io.to(roomName).emit(event, payload);
            console.log(`Emitted ${event} to user room: ${roomName}`);
        } catch (error) {
            console.error(`Error emitting to user ${userId}:`, error);
        }
    }

    /**
     * Emit event to staff with specific job role
     * @param {string} jobRole - Normalized job role
     * @param {string} event - Event name
     * @param {Object} payload - Event payload
     */
    emitToStaffRole(jobRole, event, payload) {
        try {
            if (!this.io) {
                console.error('Socket.IO not initialized');
                return;
            }
            
            const roomName = `role:staff:${jobRole}`;
            this.io.to(roomName).emit(event, payload);
            console.log(`Emitted ${event} to role room: ${roomName}`);
        } catch (error) {
            console.error(`Error emitting to staff role ${jobRole}:`, error);
        }
    }

    /**
     * Emit event to duty room
     * @param {string} dutyId - Duty ID
     * @param {string} event - Event name
     * @param {Object} payload - Event payload
     */
    emitToDuty(dutyId, event, payload) {
        try {
            if (!this.io) {
                console.error('Socket.IO not initialized');
                return;
            }
            
            const roomName = `duty:${dutyId}`;
            this.io.to(roomName).emit(event, payload);
            console.log(`Emitted ${event} to duty room: ${roomName}`);
        } catch (error) {
            console.error(`Error emitting to duty ${dutyId}:`, error);
        }
    }

    /**
     * Emit event to multiple users
     * @param {string[]} userIds - Array of user IDs
     * @param {string} event - Event name
     * @param {Object} payload - Event payload
     */
    emitToUsers(userIds, event, payload) {
        try {
            if (!this.io) {
                console.error('Socket.IO not initialized');
                return;
            }
            
            userIds.forEach(userId => {
                this.emitToUser(userId, event, payload);
            });
        } catch (error) {
            console.error('Error emitting to multiple users:', error);
        }
    }

    /**
     * Send unread count to user
     * @param {string} userId - User ID
     * @param {number} count - Unread notification count
     */
    sendUnreadCount(userId, count) {
        try {
            if (!this.io) {
                console.error('Socket.IO not initialized');
                return;
            }
            
            this.emitToUser(userId, 'unread_count', { count });
        } catch (error) {
            console.error(`Error sending unread count to user ${userId}:`, error);
        }
    }
}

// Export singleton instance (will be initialized later)
module.exports = new WebSocketManager(null);
