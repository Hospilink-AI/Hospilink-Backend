const locationTrackingService = require('../services/locationTracking.service');
const roomManager = require('./roomManager');
const logger = require('../utils/logger');
const Duty = require('../models/Duty');


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
        const { staffId, dutyId, coordinates } = data;
        // Note: hospitalId from the client payload is intentionally ignored.
        // We look it up server-side from the duty record to prevent a staff
        // member from broadcasting their location to an arbitrary hospital.
        const userId = socket.user._id.toString();

        // Validate the socket belongs to the staff member making the request
        const medicalStaff = socket.medicalStaff;
        if (!medicalStaff || medicalStaff._id.toString() !== staffId) {
            throw new Error('Unauthorized: You can only start tracking for yourself');
        }

        // Look up the duty server-side to get the authoritative hospitalId
        const duty = await Duty.findById(dutyId)
            .select('hospital assignedTo status')
            .lean();

        if (!duty) {
            throw new Error('Duty not found');
        }

        // Verify this duty is actually assigned to this staff member
        if (!duty.assignedTo || duty.assignedTo.toString() !== medicalStaff._id.toString()) {
            throw new Error('Unauthorized: This duty is not assigned to you');
        }

        // Only allow tracking for active duty statuses
        const trackableStatuses = ['assigned', 'enroute', 'in-progress'];
        if (!trackableStatuses.includes(duty.status)) {
            throw new Error(`Cannot start tracking for a duty with status: ${duty.status}`);
        }

        // Use the server-side hospitalId — never trust the client value
        const verifiedHospitalId = duty.hospital.toString();

        await locationTrackingService.storeInitialLocation(userId, dutyId, verifiedHospitalId, coordinates);

        // Join tracking room with User ID
        const trackingRoom = roomManager.joinTrackingRoom(socket, userId, dutyId);
        const hospitalTrackingRoom = roomManager.joinHospitalTrackingRoom(socket, verifiedHospitalId);

        socket.emit('tracking_started', {
            success: true,
            trackingRoom,
            hospitalTrackingRoom,
            updateInterval: 2000
        });

        logger.info(`Tracking started for user ${userId}, staff ${staffId}, duty ${dutyId}, hospital ${verifiedHospitalId}`);
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