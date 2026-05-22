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
                .select('verificationStatus rejectionReason')
                .lean();
                
            if (staff) {
                const freshData = {
                    status: staff.verificationStatus,
                    rejectionReason: staff.rejectionReason
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
}

module.exports = CacheInvalidationService;