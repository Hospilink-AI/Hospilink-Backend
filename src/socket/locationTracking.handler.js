const locationTrackingService = require('../services/locationTracking.service');
const roomManager = require('./roomManager');
const logger = require('../utils/logger');


class LocationTrackingHandler {
    constructor() {
        this.setupEventHandlers();
    }

    setupEventHandlers() {
        const { getIO } = require('./index');
        const io = getIO();

        // Start tracking session
        io.on('connection', (socket) => {
            socket.on('tracking_start', async (data) => {
                try {
                    await this.handleTrackingStart(socket, data);
                } catch (error) {
                    logger.error('Error handling tracking_start:', error);
                    socket.emit('tracking_error', { message: error.message });
                }
            });

            // Location update
            socket.on('location_update', async (data) => {
                try {
                    await this.handleLocationUpdate(socket, data);
                } catch (error) {
                    logger.error('Error handling location_update:', error);
                    socket.emit('tracking_error', { message: error.message });
                }
            });

            // End tracking
            socket.on('tracking_end', async (data) => {
                try {
                    await this.handleTrackingEnd(socket, data);
                } catch (error) {
                    logger.error('Error handling tracking_end:', error);
                    socket.emit('tracking_error', { message: error.message });
                }
            });
        });
    }


    // handle tracking start for a staff member
    async handleTrackingStart(socket, data) {
        const { staffId, dutyId, hospitalId, coordinates } = data;
        const userId = socket.user._id.toString();

        // Get MedicalStaff record to validate ownership
        const medicalStaff = socket.medicalStaff;
        if (!medicalStaff || medicalStaff._id.toString() !== staffId) {
            throw new Error('Unauthorized: You can only start tracking for yourself');
        }

        // Use User ID for location tracking (consistent with admin.service.js)
        await locationTrackingService.storeInitialLocation(userId, dutyId, hospitalId, coordinates);

        // Join tracking room with User ID
        const trackingRoom = roomManager.joinTrackingRoom(socket, userId, dutyId);
        const hospitalTrackingRoom = roomManager.joinHospitalTrackingRoom(socket, hospitalId);

        socket.emit('tracking_started', {
            success: true,
            trackingRoom,
            hospitalTrackingRoom,
            updateInterval: 2000
        });

        logger.info(`Tracking started for user ${userId}, staff ${staffId}, duty ${dutyId}`);
    }


    // handle location update for a staff member
    async handleLocationUpdate(socket, data) {
        const { staffId, coordinates, accuracy, speed } = data;
        const userId = socket.user._id.toString();

        // Validate user is the staff member
        const medicalStaff = socket.medicalStaff;
        if (!medicalStaff || medicalStaff._id.toString() !== staffId) {
            throw new Error('Unauthorized: You can only update your own location');
        }

        // Use User ID for location tracking
        const updatedData = await locationTrackingService.updateStaffLocation(userId, coordinates, {
            accuracy,
            speed
        });

        socket.emit('location_confirmed', {
            timestamp: updatedData.timestamp,
            distanceToHospital: updatedData.distanceToHospital,
            estimatedArrival: updatedData.estimatedArrival
        });
    }


    // handle tracking end for a staff member
    async handleTrackingEnd(socket, data) {
        const { staffId, reason } = data;
        const userId = socket.user._id.toString();

        // Validate user is the staff member
        const medicalStaff = socket.medicalStaff;
        if (!medicalStaff || medicalStaff._id.toString() !== staffId) {
            throw new Error('Unauthorized: You can only end your own tracking');
        }

        // Use User ID for location tracking
        const cleanupData = await locationTrackingService.endTrackingSession(userId, reason);

        socket.emit('tracking_ended', {
            success: true,
            cleanupData
        });

        logger.info(`Tracking ended for user ${userId}, staff ${staffId}, reason: ${reason}`);
    }
}

module.exports = new LocationTrackingHandler();