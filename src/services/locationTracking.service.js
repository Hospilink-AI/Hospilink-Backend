const redisClient = require('../config/redis');
const geocodingService = require('./geocoding.service');
const logger = require('../utils/logger');
const { getIO } = require('../socket/index');

class LocationTrackingService {
    constructor() {
        this.LOCATION_TTL = parseInt(process.env.REDIS_TTL_LOCATION) || 7200; // 2 hours
        this.CLEANUP_TTL = parseInt(process.env.REDIS_TTL_CLEANUP) || 60; // 1 minutes
        this.ARRIVAL_THRESHOLD = 0.1; // 100 meters
        this.UPDATE_INTERVAL = 2000; // 2 seconds


    }

    // Store initial staff location when starting navigation
    async storeInitialLocation(staffId, dutyId, hospitalId, coordinates) {
        try {
            const redis = await redisClient.getClientAsync();

            const locationData = {
                latitude: coordinates.latitude,
                longitude: coordinates.longitude,
                timestamp: Date.now(),
                dutyId,
                hospitalId,
                status: 'active',
                sessionStart: Date.now(),
                lastUpdated: Date.now()
            };

            const key = `hospilink:staff_location:${staffId}`;
            await redis.setex(key, this.LOCATION_TTL, JSON.stringify(locationData));
            logger.info(`Stored initial location for staff ${staffId}, duty ${dutyId}`);
            return locationData;
        } catch (error) {
            logger.error('Error storing initial location:', error);
            throw error;
        }
    }



    // Update staff location in real-time
    async updateStaffLocation(staffId, coordinates, additionalData = {}) {
        try {
            const redis = await redisClient.getClientAsync();
            const key = `hospilink:staff_location:${staffId}`;

            // Get existing location data
            const existingData = await this.getStaffLocation(staffId);
            if (!existingData) {
                throw new Error('No active tracking session found');
            }

            // Validate coordinates
            this.validateCoordinates(coordinates);

            // Update location data
            const updatedData = {
                ...existingData,
                latitude: coordinates.latitude,
                longitude: coordinates.longitude,
                timestamp: Date.now(),
                lastUpdated: Date.now(),
                ...additionalData
            };


            // Calculate distance to hospital
            const hospitalData = await this.getHospitalLocation(existingData.hospitalId);
            if (hospitalData) {
                const distanceInfo = await geocodingService.calculateDistanceAndETA(
                    coordinates.latitude,
                    coordinates.longitude,
                    hospitalData.latitude,
                    hospitalData.longitude
                );

                updatedData.distanceToHospital = distanceInfo.distance;
                updatedData.estimatedArrival = Date.now() + (distanceInfo.duration * 60 * 1000);
            }

            // Update Redis
            await redis.setex(key, this.LOCATION_TTL, JSON.stringify(updatedData));

            // Broadcast to hospital room
            await this.broadcastLocationUpdate(staffId, updatedData);

            // Check for arrival
            await this.checkArrival(staffId, updatedData, hospitalData);

            logger.debug(`Updated location for staff ${staffId}`);
            return updatedData;
        } catch (error) {
            logger.error('Error updating staff location:', error);
            throw error;
        }
    }



    // Get staff location from Redis
    async getStaffLocation(staffId) {
        try {
            const redis = await redisClient.getClientAsync();
            const key = `hospilink:staff_location:${staffId}`;
            const data = await redis.get(key);
            return data ? JSON.parse(data) : null;
        } catch (error) {
            logger.error('Error getting staff location:', error);
            return null;
        }
    }


    // Get hospital location from database
    async getHospitalLocation(hospitalId) {
        try {
            const Hospital = require('../models/Hospital');
            const hospital = await Hospital.findById(hospitalId);
            if (!hospital || !hospital.coordinates || !hospital.coordinates.coordinates) {
                return null;
            }

            return {
                latitude: hospital.coordinates.coordinates.latitude,
                longitude: hospital.coordinates.coordinates.longitude
            };
        } catch (error) {
            logger.error('Error getting hospital location:', error);
            return null;
        }
    }



    // Broadcast location update to hospital
    async broadcastLocationUpdate(staffId, locationData) {
        try {
            const io = getIO();
            const MedicalStaff = require('../models/MedicalStaff');

            // Get staff details
            const staff = await MedicalStaff.findOne({ user: staffId }).populate('user', 'name');
            if (!staff) return;

            const broadcastData = {
                staffId,
                staffName: staff.user.name,
                currentLocation: {
                    latitude: locationData.latitude,
                    longitude: locationData.longitude
                },
                distanceRemaining: locationData.distanceToHospital || 0,
                estimatedArrival: locationData.estimatedArrival 
                    ? new Date(locationData.estimatedArrival).toLocaleTimeString()
                    : 'Calculating...',
                status: locationData.status,
                timestamp: locationData.timestamp

            };

            // Broadcast to hospital tracking room
            io.to(`hospital_tracking:${locationData.hospitalId}`).emit('staff_location_update', broadcastData);

            // broadcast to admin tracking room
            io.to('admin_tracking').emit('admin_staff_location_update', broadcastData);
            
            logger.debug(`Broadcasted location update for staff ${staffId}`);
        } catch (error) {
            logger.error('Error broadcasting location update:', error);
        }
    }



    // Check if staff has arrived at hospital
    async checkArrival(staffId, locationData, hospitalData) {
        try {
            if (!hospitalData || locationData.status === 'arrived') {
                return;
            }

            const distance = await geocodingService.calculateDistanceAndETA(
                locationData.latitude,
                locationData.longitude,
                hospitalData.latitude,
                hospitalData.longitude
            );

            if (distance.distance <= this.ARRIVAL_THRESHOLD) {
                await this.handleStaffArrival(staffId, locationData);
            }
        } catch (error) {
            logger.error('Error checking arrival:', error);
        }
    }



    // Handle staff arrival
    async handleStaffArrival(staffId, locationData) {
        try {
            const redis = await redisClient.getClientAsync();
            const io = getIO();
            const MedicalStaff = require('../models/MedicalStaff');

            // Update location status
            locationData.status = 'arrived';
            locationData.arrivalTime = Date.now();

            const key = `staff_location:${staffId}`;
            await redis.setex(key, this.LOCATION_TTL, JSON.stringify(locationData));

            // Get staff details
            const staff = await MedicalStaff.findOne({ user: staffId }).populate('user', 'name');
            if (!staff) return;

            // Send arrival notifications
            const arrivalData = {
                staffId,
                staffName: staff.user.name,
                arrivalTime: new Date(locationData.arrivalTime).toLocaleTimeString(),
                finalLocation: {
                    latitude: locationData.latitude,
                    longitude: locationData.longitude
                },
                message: `${staff.user.name} has arrived at your location`
            };

            // To hospital
            io.to(`hospital_tracking:${locationData.hospitalId}`).emit('staff_arrived', arrivalData);

            // To staff
            io.to(`user:${staffId}`).emit('arrival_confirmation', {
                message: 'You have arrived at the hospital',
                arrivalTime: arrivalData.arrivalTime
            });

            logger.info(`Staff ${staffId} arrived at hospital ${locationData.hospitalId}`);
        } catch (error) {
            logger.error('Error handling staff arrival:', error);
        }
    }



    // End tracking session and start cleanup
    async endTrackingSession(staffId, reason = 'manual') {
        try {
            const redis = await redisClient.getClientAsync();
            const locationData = await this.getStaffLocation(staffId);

            if (!locationData) {
                return null;
            }

            // Store cleanup data
            const cleanupData = {
                staffId,
                dutyId: locationData.dutyId,
                hospitalId: locationData.hospitalId,
                sessionEnd: Date.now(),
                finalLocation: {
                    latitude: locationData.latitude,
                    longitude: locationData.longitude
                },
                totalDuration: Date.now() - locationData.sessionStart,
                reason
            };

            const cleanupKey = `staff_location_cleanup:${staffId}`;
            await redis.setex(cleanupKey, this.CLEANUP_TTL, JSON.stringify(cleanupData));

            // Set main location key for deletion
            const mainKey = `hospilink:staff_location:${staffId}`;
            await redis.expire(mainKey, this.CLEANUP_TTL);

            // Leave WebSocket tracking room
            const io = getIO();
            const trackingRoom = `tracking:${staffId}:${locationData.dutyId}`;
            io.socketsLeave(trackingRoom);

            logger.info(`Ended tracking session for staff ${staffId}, reason: ${reason}`);
            return cleanupData;
        } catch (error) {
            logger.error('Error ending tracking session:', error);
            throw error;
        }
    }



    // Validate coordinates
    validateCoordinates(coordinates) {
        if (!coordinates || typeof coordinates.latitude !== 'number' || typeof coordinates.longitude !== 'number') {
            throw new Error('Invalid coordinates provided');
        }

        if (coordinates.latitude < -90 || coordinates.latitude > 90) {
            throw new Error('Latitude must be between -90 and 90');
        }

        if (coordinates.longitude < -180 || coordinates.longitude > 180) {
            throw new Error('Longitude must be between -180 and 180');
        }
    }


    // Get active tracking sessions
    async getActiveTrackingSessions() {
        try {
            const redis = await redisClient.getClientAsync();
            const keys = await redis.keys('hospilink:staff_location:*');
            const sessions = [];

            for (const key of keys) {
                const data = await redis.get(key);
                if (data) {
                    sessions.push(JSON.parse(data));
                }
            }

            return sessions;
        } catch (error) {
            logger.error('Error getting active tracking sessions:', error);
            return [];
        }
    }
}
module.exports = new LocationTrackingService();