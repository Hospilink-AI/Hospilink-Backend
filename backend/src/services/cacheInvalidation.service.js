const cacheService = require('./cache.service');
const Hospital = require('../models/Hospital');
const MedicalStaff = require('../models/MedicalStaff');
const logger = require('../utils/logger');

class CacheInvalidationService {

    // Invalidate hospital verification cache with retry mechanism
    static async invalidateHospitalVerificationCache(userId, maxRetries = 3) {
        const cacheKey = `hospital_verification:${userId}`;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Attempt to delete cache
                await cacheService.del(cacheKey);

                // Verify cache is actually deleted
                const cachedValue = await cacheService.get(cacheKey);
                if (!cachedValue) {
                    logger.info(`Cache invalidated successfully for user ${userId} (attempt ${attempt})`);
                    return true;
                }

                logger.warn(`Cache invalidation failed for user ${userId} (attempt ${attempt})`);

                if (attempt < maxRetries) {
                    // Exponential backoff: 100ms, 200ms, 400ms
                    const delay = 100 * Math.pow(2, attempt - 1);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }

            } catch (error) {
                logger.error(`Cache invalidation error for user ${userId} (attempt ${attempt}):`, error);

                if (attempt < maxRetries) {
                    const delay = 100 * Math.pow(2, attempt - 1);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        logger.error(`Cache invalidation failed after ${maxRetries} attempts for user ${userId}`);
        return false;
    }

    // Invalidate hospital suspension cache
    static async invalidateHospitalSuspensionCache(userId, maxRetries = 3) {
        const cacheKey = `suspension:hospital:${userId}`;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await cacheService.del(cacheKey);

                const cachedValue = await cacheService.get(cacheKey);

                if (!cachedValue) {
                    logger.info(
                        `Hospital suspension cache invalidated for user ${userId} (attempt ${attempt})`
                    );
                    return true;
                }

                logger.warn(
                    `Hospital suspension cache invalidation failed for user ${userId} (attempt ${attempt})`
                );

                if (attempt < maxRetries) {
                    const delay = 100 * Math.pow(2, attempt - 1);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            } catch (error) {
                logger.error(
                    `Hospital suspension cache invalidation error for user ${userId} (attempt ${attempt}):`,
                    error
                );

                if (attempt < maxRetries) {
                    await new Promise(resolve =>
                        setTimeout(resolve, 100 * Math.pow(2, attempt - 1))
                    );
                }
            }
        }

        logger.error(
            `Hospital suspension cache invalidation failed after ${maxRetries} attempts for user ${userId}`
        );

        return false;
    }

    // Refresh hospital suspension cache
    static async refreshHospitalSuspensionCache(userId) {
        const cacheKey = `suspension:hospital:${userId}`;

        try {
            await this.invalidateHospitalSuspensionCache(userId);

            const hospital = await Hospital.findOne({ user: userId })
                .select('isSuspended suspensionReason')
                .lean();

            if (hospital) {
                const freshData = {
                    isSuspended: hospital.isSuspended || false,
                    suspensionReason: hospital.suspensionReason || null
                };

                await cacheService.set(cacheKey, freshData, 300);

                logger.info(
                    `Hospital suspension cache refreshed for user ${userId}`
                );

                return freshData;
            }

            logger.warn(
                `Hospital not found for user ${userId} during suspension cache refresh`
            );

            return null;
        } catch (error) {
            logger.error(
                `Hospital suspension cache refresh error for user ${userId}:`,
                error
            );

            return null;
        }
    }


    // Refresh Hospital Verification cache
    static async refreshHospitalVerificationCache(userId) {
        const cacheKey = `hospital_verification:${userId}`;

        try {
            // Delete existing cache first
            await this.invalidateHospitalVerificationCache(userId);

            // Fetch fresh data from database
            const hospital = await Hospital.findOne({ user: userId })
                .select('verificationStatus rejectionReason')
                .lean();

            if (hospital) {
                const freshData = {
                    status: hospital.verificationStatus,
                    rejectionReason: hospital.rejectionReason
                };

                // Set fresh cache with 5-minute TTL
                await cacheService.set(cacheKey, freshData, 300);
                logger.info(`Cache refreshed successfully for user ${userId}`);
                return freshData;
            } else {
                logger.warn(`Hospital not found for user ${userId} during cache refresh`);
                return null;
            }
        } catch (error) {
            logger.error(`Cache refresh error for user ${userId}:`, error);
            return null;
        }
    }


    // Batch Invalidate Cache
    static async batchInvalidateCache(userIds) {
        const results = {
            success: 0,
            failed: 0,
            errors: []
        };

        // Process in parallel for better performance
        const promises = userIds.map(async (userId) => {
            try {
                const success = await this.invalidateHospitalVerificationCache(userId);
                if (success) {
                    results.success++;
                } else {
                    results.failed++;
                    results.errors.push(`Failed to invalidate cache for user ${userId}`);
                }
            } catch (error) {
                results.failed++;
                results.errors.push(`Error invalidating cache for user ${userId}: ${error.message}`);
            }
        });

        await Promise.all(promises);

        logger.info(`Batch cache invalidation completed: ${results.success} success, ${results.failed} failed`);
        return results;
    }


    // Get cache statistics 
    static async getCacheInfo(userId) {
        const cacheKey = `hospital_verification:${userId}`;

        try {
            const cachedData = await cacheService.get(cacheKey);
            const hospital = await Hospital.findOne({ user: userId })
                .select('verificationStatus rejectionReason')
                .lean();

            return {
                cacheKey,
                hasCache: !!cachedData,
                cacheData: cachedData,
                dbData: hospital ? {
                    status: hospital.verificationStatus,
                    rejectionReason: hospital.rejectionReason
                } : null,
                isConsistent: cachedData && hospital ?
                    cachedData.status === hospital.verificationStatus : false
            };
        } catch (error) {
            logger.error(`Error getting cache info for user ${userId}:`, error);
            return null;
        }
    }

    // Invalidate staff suspension cache
    static async invalidateStaffSuspensionCache(userId, maxRetries = 3) {
        const cacheKey = `suspension:staff:${userId}`;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await cacheService.del(cacheKey);

                const cachedValue = await cacheService.get(cacheKey);

                if (!cachedValue) {
                    logger.info(
                        `Staff suspension cache invalidated for user ${userId} (attempt ${attempt})`
                    );
                    return true;
                }

                logger.warn(
                    `Staff suspension cache invalidation failed for user ${userId} (attempt ${attempt})`
                );

                if (attempt < maxRetries) {
                    const delay = 100 * Math.pow(2, attempt - 1);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            } catch (error) {
                logger.error(
                    `Staff suspension cache invalidation error for user ${userId} (attempt ${attempt}):`,
                    error
                );

                if (attempt < maxRetries) {
                    await new Promise(resolve =>
                        setTimeout(resolve, 100 * Math.pow(2, attempt - 1))
                    );
                }
            }
        }

        logger.error(
            `Staff suspension cache invalidation failed after ${maxRetries} attempts for user ${userId}`
        );

        return false;
    }

    // Refresh staff suspension cache
    static async refreshStaffSuspensionCache(userId) {
        const cacheKey = `suspension:staff:${userId}`;

        try {
            await this.invalidateStaffSuspensionCache(userId);

            const staff = await MedicalStaff.findOne({ user: userId })
                .select('isSuspended suspensionReason')
                .lean();

            if (staff) {
                const freshData = {
                    isSuspended: staff.isSuspended || false,
                    suspensionReason: staff.suspensionReason || null
                };

                await cacheService.set(cacheKey, freshData, 300);

                logger.info(
                    `Staff suspension cache refreshed for user ${userId}`
                );

                return freshData;
            }

            logger.warn(
                `Staff not found for user ${userId} during suspension cache refresh`
            );

            return null;
        } catch (error) {
            logger.error(
                `Staff suspension cache refresh error for user ${userId}:`,
                error
            );

            return null;
        }
    }


    // Staff verification cache methods 
    // Invalidates the cache for a specific staff member
    static async invalidateStaffVerificationCache(userId, maxRetries = 3) {
        const cacheKey = `staff_verification:${userId}`;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Attempt to delete cache
                await cacheService.del(cacheKey);

                // Verify cache is actually deleted
                const cachedValue = await cacheService.get(cacheKey);
                if (!cachedValue) {
                    logger.info(`Staff cache invalidated successfully for user ${userId} (attempt ${attempt})`);
                    return true;
                }

                logger.warn(`Staff cache invalidation failed for user ${userId} (attempt ${attempt})`);

                if (attempt < maxRetries) {
                    // Exponential backoff: 100ms, 200ms, 400ms
                    const delay = 100 * Math.pow(2, attempt - 1);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }

            } catch (error) {
                logger.error(`Staff cache invalidation error for user ${userId} (attempt ${attempt}):`, error);

                if (attempt < maxRetries) {
                    const delay = 100 * Math.pow(2, attempt - 1);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        logger.error(`Staff cache invalidation failed after ${maxRetries} attempts for user ${userId}`);
        return false;
    }


    // Refreshes the cache for a specific staff member
    static async refreshStaffVerificationCache(userId) {
        const cacheKey = `staff_verification:${userId}`;

        try {
            // Delete existing cache first
            await this.invalidateStaffVerificationCache(userId);

            // Fetch fresh data from database
            const staff = await MedicalStaff.findOne({ user: userId })
                .select('verificationStatus rejectionReason isAvailable')
                .lean();

            if (staff) {
                const freshData = {
                    verificationStatus: staff.verificationStatus,
                    rejectionReason: staff.rejectionReason,
                    isAvailable: staff.isAvailable
                };

                // Set fresh cache with 5-minute TTL
                await cacheService.set(cacheKey, freshData, 300);
                logger.info(`Staff cache refreshed successfully for user ${userId}`);
                return freshData;
            } else {
                logger.warn(`Staff not found for user ${userId} during cache refresh`);
                return null;
            }
        } catch (error) {
            logger.error(`Staff cache refresh error for user ${userId}:`, error);
            return null;
        }
    }


    // Batch staff cache invalidation 
    static async batchInvalidateStaffCache(userIds) {
        const results = {
            success: 0,
            failed: 0,
            errors: []
        };

        // Process in parallel for better performance
        const promises = userIds.map(async (userId) => {
            try {
                const success = await this.invalidateStaffVerificationCache(userId);
                if (success) {
                    results.success++;
                } else {
                    results.failed++;
                    results.errors.push(`Failed to invalidate cache for user ${userId}`);
                }
            } catch (error) {
                results.failed++;
                results.errors.push(`Error invalidating cache for user ${userId}: ${error.message}`);
            }
        });

        await Promise.all(promises);

        logger.info(`Batch staff cache invalidation completed: ${results.success} success, ${results.failed} failed`);
        return results;
    }

    // ─── Hospital suspension cache ─────────────────────────────────────────────

    // Invalidate hospital suspension cache with retry mechanism
    static async invalidateHospitalSuspensionCache(userId, maxRetries = 3) {
        const cacheKey = `suspension:hospital:${userId}`;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await cacheService.del(cacheKey);
                const cachedValue = await cacheService.get(cacheKey);
                if (!cachedValue) {
                    logger.info(`Hospital suspension cache invalidated for user ${userId} (attempt ${attempt})`);
                    return true;
                }
                logger.warn(`Hospital suspension cache invalidation failed for user ${userId} (attempt ${attempt})`);
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt - 1)));
                }
            } catch (error) {
                logger.error(`Hospital suspension cache invalidation error for user ${userId} (attempt ${attempt}):`, error);
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt - 1)));
                }
            }
        }

        logger.error(`Hospital suspension cache invalidation failed after ${maxRetries} attempts for user ${userId}`);
        return false;
    }

    // Re-fetch hospital suspension data from DB and warm the cache
    static async refreshHospitalSuspensionCache(userId) {
        const cacheKey = `suspension:hospital:${userId}`;

        try {
            await this.invalidateHospitalSuspensionCache(userId);

            const hospital = await Hospital.findOne({ user: userId })
                .select('isSuspended suspensionReason')
                .lean();

            if (hospital) {
                const freshData = {
                    isSuspended: hospital.isSuspended || false,
                    suspensionReason: hospital.suspensionReason || null
                };
                await cacheService.set(cacheKey, freshData, 300);
                logger.info(`Hospital suspension cache refreshed for user ${userId}`);
                return freshData;
            }

            logger.warn(`Hospital not found for user ${userId} during suspension cache refresh`);
            return null;
        } catch (error) {
            logger.error(`Hospital suspension cache refresh error for user ${userId}:`, error);
            return null;
        }
    }

    // ─── Staff suspension cache ────────────────────────────────────────────────

    // Invalidate staff suspension cache with retry mechanism
    static async invalidateStaffSuspensionCache(userId, maxRetries = 3) {
        const cacheKey = `suspension:staff:${userId}`;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await cacheService.del(cacheKey);
                const cachedValue = await cacheService.get(cacheKey);
                if (!cachedValue) {
                    logger.info(`Staff suspension cache invalidated for user ${userId} (attempt ${attempt})`);
                    return true;
                }
                logger.warn(`Staff suspension cache invalidation failed for user ${userId} (attempt ${attempt})`);
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt - 1)));
                }
            } catch (error) {
                logger.error(`Staff suspension cache invalidation error for user ${userId} (attempt ${attempt}):`, error);
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt - 1)));
                }
            }
        }

        logger.error(`Staff suspension cache invalidation failed after ${maxRetries} attempts for user ${userId}`);
        return false;
    }

    // Re-fetch staff suspension data from DB and warm the cache
    static async refreshStaffSuspensionCache(userId) {
        const cacheKey = `suspension:staff:${userId}`;

        try {
            await this.invalidateStaffSuspensionCache(userId);

            const staff = await MedicalStaff.findOne({ user: userId })
                .select('isSuspended suspensionReason')
                .lean();

            if (staff) {
                const freshData = {
                    isSuspended: staff.isSuspended || false,
                    suspensionReason: staff.suspensionReason || null
                };
                await cacheService.set(cacheKey, freshData, 300);
                logger.info(`Staff suspension cache refreshed for user ${userId}`);
                return freshData;
            }

            logger.warn(`Staff not found for user ${userId} during suspension cache refresh`);
            return null;
        } catch (error) {
            logger.error(`Staff suspension cache refresh error for user ${userId}:`, error);
            return null;
        }
    }
}

module.exports = CacheInvalidationService;