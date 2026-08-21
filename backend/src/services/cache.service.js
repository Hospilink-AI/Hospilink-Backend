const redisClient = require('../config/redis');
const logger = require('../utils/logger');

class CacheService {
    async get(key) {
        try {
            const client = await redisClient.getClientAsync();
            const value = await client.get(key);
            return value ? JSON.parse(value) : null;
        } catch (error) {
            logger.error('Cache get error:', error);
            return null;
        }
    }

    // Does NOT catch errors — callers must handle them.
    // Use for security-critical reads where a Redis failure must not be treated as "not found".
    async getStrict(key) {
        const client = await redisClient.getClientAsync();
        const value = await client.get(key);
        return value ? JSON.parse(value) : null;
    }

    async set(key, value, ttl = 3600) {
        try {
            const client = await redisClient.getClientAsync();
            await client.setex(key, ttl, JSON.stringify(value));
            return true;
        } catch (error) {
            logger.error('Cache set error:', error);
            return false;
        }
    }

    async del(key) {
        try {
            const client = await redisClient.getClientAsync();
            await client.del(key);
            return true;
        } catch (error) {
            logger.error('Cache delete error:', error);
            return false;
        }
    }

    async invalidatePattern(pattern) {
        try {
            const client = await redisClient.getClientAsync();

            // SCAN instead of KEYS — non-blocking cursor iteration.
            // KEYS blocks the entire Redis server for the full scan duration.
            // SCAN processes a small batch per call, keeping Redis responsive.
            const keys = [];
            let cursor = '0';
            do {
                const [nextCursor, batch] = await client.scan(
                    cursor,
                    'MATCH', pattern,
                    'COUNT', 100
                );
                cursor = nextCursor;
                keys.push(...batch);
            } while (cursor !== '0');

            if (keys.length > 0) {
                // DEL accepts multiple keys — one round trip regardless of count
                await client.del(...keys);
            }
            return keys.length;
        } catch (error) {
            logger.error('Cache pattern delete error:', error);
            return 0;
        }
    }

    // Pipeline operations for batch cache operations
    async pipeline(operations) {
        try {
            const client = await redisClient.getClientAsync();
            const pipeline = client.pipeline();
            
            operations.forEach(op => {
                if (op.type === 'set') {
                    pipeline.setex(op.key, op.ttl, JSON.stringify(op.value));
                } else if (op.type === 'del') {
                    pipeline.del(op.key);
                } else if (op.type === 'get') {
                    pipeline.get(op.key);
                }
            });
            
            return await pipeline.exec();
        } catch (error) {
            logger.error('Cache pipeline error:', error);
            return null;
        }
    }

    // Distributed locking mechanism
    async acquireLock(key, ttl = 10) {
        try {
            const client = await redisClient.getClientAsync();
            const lockKey = `lock:${key}`;
            const result = await client.set(lockKey, 'locked', 'PX', ttl * 1000, 'NX');
            return result === 'OK';
        } catch (error) {
            logger.error('Lock acquisition error:', error);
            return false;
        }
    }

    // Release lock mechanism for distributed locking
    async releaseLock(key) {
        try {
            const client = await redisClient.getClientAsync();
            const lockKey = `lock:${key}`;
            await client.del(lockKey);
            return true;
        } catch (error) {
            logger.error('Lock release error:', error);
            return false;
        }
    }

    // Cache warming for frequently accessed data
    async warmCache(key, dataFetcher, ttl = 3600) {
        try {
            const cached = await this.get(key);
            if (cached) return cached;

            const data = await dataFetcher();
            await this.set(key, data, ttl);
            return data;
        } catch (error) {
            logger.error('Cache warming error:', error);
            return null;
        }
    }

    // Enhanced caching methods for profile operations
    async getProfile(userId, role) {
        const key = `profile:${userId}:${role}`;
        return await this.get(key);
    }

    async setProfile(userId, role, data, ttl = 900) { // 15 minutes
        const key = `profile:${userId}:${role}`;
        return await this.set(key, data, ttl);
    }

    async invalidateProfile(userId, role) {
        const key = `profile:${userId}:${role}`;
        return await this.del(key);
    }

    async invalidateUserProfiles(userId) {
        const patterns = [
            `profile:${userId}:staff`,
            `profile:${userId}:hospital`,
            `profile:${userId}:admin`
        ];
        
        const operations = patterns.map(pattern => ({
            type: 'del',
            key: pattern
        }));
        
        return await this.pipeline(operations);
    }

    async getGeocoding(address) {
        const key = `geo:${Buffer.from(address).toString('base64')}`;
        return await this.get(key);
    }

    async setGeocoding(address, data, ttl = 2592000) { // 30 days
        const key = `geo:${Buffer.from(address).toString('base64')}`;
        return await this.set(key, data, ttl);
    }

    // Profile status caching methods
    async getProfileStatus(userId) {
        const key = `profile:status:${userId}`;
        return await this.get(key);
    }

    async setProfileStatus(userId, data, ttl = 300) { // 5 minutes cache
        const key = `profile:status:${userId}`;
        return await this.set(key, data, ttl);
    }

    async invalidateProfileStatus(userId) {
        const key = `profile:status:${userId}`;
        return await this.del(key);
    }

    // Batch profile status check for multiple users (admin features)
    async getMultipleProfileStatus(userIds) {
        const operations = userIds.map(userId => ({
            type: 'get',
            key: `profile:status:${userId}`
        }));
        
        const results = await this.pipeline(operations);
        return userIds.map((userId, index) => ({
            userId,
            data: results[index] ? JSON.parse(results[index][1]) : null
        }));
    }
    
    // Location permission caching methods
    async getLocationPermission(userId) {
        const key = `location:permission:${userId}`;
        return await this.get(key);
    }
    
    async setLocationPermission(userId, data, ttl = 1800) { // 30 minutes
        const key = `location:permission:${userId}`;
        return await this.set(key, data, ttl);
    }
    
    async invalidateLocationPermission(userId) {
        const key = `location:permission:${userId}`;
        return await this.del(key);
    }

    // Real-time availability caching methods
    async getStaffAvailability(userId) {
        const key = `availability:${userId}`;
        return await this.get(key);
    }

    async setStaffAvailability(userId, isAvailable, ttl = 60) {
        const key = `availability:${userId}`;
        const data = {
            isAvailable,
            updatedAt: new Date().toISOString()
        };
        return await this.set(key, data, ttl);
    }

    async invalidateStaffAvailability(userId) {
        const key = `availability:${userId}`;
        return await this.del(key);
    }

    // Batch availability updates for dashboard (for hospitals)
    async getMultipleStaffAvailability(userIds) {
        const operations = userIds.map(userId => ({
            type: 'get',
            key: `availability:${userId}`
        }));
        
        const results = await this.pipeline(operations);
        return userIds.map((userId, index) => {
            const result = results[index];
            return {
                userId,
                availability: result && result[1] ? JSON.parse(result[1]) : null
            };
        });
    }

    // Batch set availability for real-time updates
    async setMultipleStaffAvailability(availabilityData, ttl = 60) {
        const operations = availabilityData.map(({ userId, isAvailable }) => ({
            type: 'set',
            key: `availability:${userId}`,
            value: {
                isAvailable,
                updatedAt: new Date().toISOString()
            },
            ttl
        }));
        
        return await this.pipeline(operations);
    }

    // Invalidate all availability-related cache for a user
    async invalidateUserAvailabilityCache(userId) {
        const patterns = [
            `availability:${userId}`,
            `upcoming:duties:${userId}`,
            `nearby:staff:*`
        ];
        
        const operations = patterns.map(pattern => ({
            type: 'del',
            key: pattern
        }));
        
        return await this.pipeline(operations);
    }

    // Enhanced caching methods for nearby staff queries 
    async getNearbyStaff(hospitalId, radius, role, page, limit) {
        const key = `nearby:staff:${hospitalId}:${radius}:${role || 'all'}:${page}:${limit}`;
        return await this.get(key);
    }

    async setNearbyStaff(hospitalId, radius, role, page, limit, data, ttl = 120) {
        const key = `nearby:staff:${hospitalId}:${radius}:${role || 'all'}:${page}:${limit}`;
        return await this.set(key, data, ttl);
    }

    async getAdminNearbyStaff(hospitalId, radius, role, page, limit) {
        const key = `admin:nearby:staff:${hospitalId}:${radius}:${role || 'all'}:${page}:${limit}`;
        return await this.get(key);
    }

    async setAdminNearbyStaff(hospitalId, radius, role, page, limit, data, ttl = 60) {
        const key = `admin:nearby:staff:${hospitalId}:${radius}:${role || 'all'}:${page}:${limit}`;
        return await this.set(key, data, ttl);
    }

    // Duty status caching methods
    async getDutyStatus(staffId) {
        const key = `duty:status:${staffId}`;
        return await this.get(key);
    }

    async setDutyStatus(staffId, data, ttl = 30) {
        const key = `duty:status:${staffId}`;
        return await this.set(key, data, ttl);
    }

    async invalidateDutyStatus(staffId) {
        const key = `duty:status:${staffId}`;
        return await this.del(key);
    }

    // Batch duty status operations
    async getBatchDutyStatus(staffIds) {
        const operations = staffIds.map(id => ({
            type: 'get',
            key: `duty:status:${id}`
        }));
        
        const results = await this.pipeline(operations);
        return staffIds.map((id, index) => ({
            staffId: id,
            data: results[index] && results[index][1] ? JSON.parse(results[index][1]) : null
        }));
    }

    async setBatchDutyStatus(dutyStatusData, ttl = 30) {
        const operations = dutyStatusData.map(({ staffId, data }) => ({
            type: 'set',
            key: `duty:status:${staffId}`,
            value: data,
            ttl
        }));
        
        return await this.pipeline(operations);
    }

    // Invalidate all nearby staff cache for a hospital
    async invalidateNearbyStaffCache(hospitalId) {
        const pattern = `nearby:staff:${hospitalId}:*`;
        return await this.invalidatePattern(pattern);
    }

    // Invalidate all admin nearby staff cache for a hospital
    async invalidateAdminNearbyStaffCache(hospitalId) {
        const pattern = `admin:nearby:staff:${hospitalId}:*`;
        return await this.invalidatePattern(pattern);
    }

    // Temporary user methods with redis ttl
    // Store temp user data with TTL
    async setTempUser(email, userData, ttl = 600) {
        const key = `tempuser:${email.toLowerCase()}`;
        return await this.set(key, userData, ttl);
    }

    // Get temp user data
    async getTempUser(email) {
        const key = `tempuser:${email.toLowerCase()}`;
        return await this.get(key);
    }

    // Delete temp user data
    async deleteTempUser(email) {
        const key = `tempuser:${email.toLowerCase()}`;
        return await this.del(key);
    }

    // ── Vacancy match scores (staff-personalized GET /vacancies) ─────────────
    // Full sorted match list, cached per candidate+filter combination — avoids
    // recomputing scores across every live vacancy on each pagination click
    // within the same browse session. Short TTL, no invalidation hooks on
    // vacancy create/edit/close or profile update — there's no single
    // predictable key to invalidate (this is keyed per staff member), so a
    // short staleness window is the deliberate tradeoff instead.
    async getVacancyMatches(userId, filterKey) {
        const key = `vacancy:matches:${userId}:${filterKey}`;
        return await this.get(key);
    }

    async setVacancyMatches(userId, filterKey, data, ttl = 60) {
        const key = `vacancy:matches:${userId}:${filterKey}`;
        return await this.set(key, data, ttl);
    }

    // ── Staged resume parse ───────────
    // A brand-new candidate with no MedicalStaff profile yet uploads a resume
    // before filling any form; the parse result is staged here (not written to
    // Mongo) so the profile-creation form can be pre-filled, reviewed, and
    // edited before anything is persisted. Same shape as setTempUser/
    // getTempUser/deleteTempUser above, just keyed by userId instead of email.
    // Key: resume:stage:{userId}   TTL: 900s (15 min)
    async setParsedResumeStage(userId, stagedData, ttl = 900) {
        const key = `resume:stage:${userId}`;
        return await this.set(key, stagedData, ttl);
    }

    async getParsedResumeStage(userId) {
        const key = `resume:stage:${userId}`;
        return await this.get(key);
    }

    async deleteParsedResumeStage(userId) {
        const key = `resume:stage:${userId}`;
        return await this.del(key);
    }



    // Store OTP separately for faster verification
    async setTempUserOTP(email, otpData, ttl = 600) {
        const key = `otp:${email.toLowerCase()}`;
        return await this.set(key, otpData, ttl);
    }

    // Get OTP for verification
    async getTempUserOTP(email) {
        const key = `otp:${email.toLowerCase()}`;
        return await this.get(key);
    }
    

    // ── Phone OTP (profile creation) ─────────────────────────────────────────
    // Key: otp:phone:{normalizedPhone}   TTL: 600s (10 min)
    async setPhoneOTP(phone, otpData, ttl = 600) {
        const key = `otp:phone:${phone}`;
        return await this.set(key, otpData, ttl);
    }

    // getStrict: Redis failure throws instead of returning null.
    // Phone OTP is security-critical — a Redis error must not silently bypass the check.
    async getPhoneOTP(phone) {
        const key = `otp:phone:${phone}`;
        return await this.getStrict(key);
    }

    async deletePhoneOTP(phone) {
        const key = `otp:phone:${phone}`;
        return await this.del(key);
    }

    // ── Phone verified flag (consumed once on profile save) ──────────────────
    // Key: phone:verified:{userId}:{normalizedPhone}   TTL: 1800s (30 min)
    // Includes userId so user A's verified phone cannot be reused by user B.
    async setPhoneVerified(userId, phone, ttl = 1800) {
        const key = `phone:verified:${userId}:${phone}`;
        return await this.set(key, { verifiedAt: new Date().toISOString() }, ttl);
    }

    async getPhoneVerified(userId, phone) {
        const key = `phone:verified:${userId}:${phone}`;
        return await this.get(key);
    }

    async deletePhoneVerified(userId, phone) {
        const key = `phone:verified:${userId}:${phone}`;
        return await this.del(key);
    }

    // ─── Suspension status caching ────────────────────────────────────────────
    // key pattern: suspension:{role}:{userId}  TTL: 300s (same as verification cache)

    async getSuspensionStatus(userId, role) {
        const key = `suspension:${role}:${userId}`;
        return await this.get(key);
    }

    async setSuspensionStatus(userId, role, data, ttl = 300) {
        const key = `suspension:${role}:${userId}`;
        return await this.set(key, data, ttl);
    }

    async invalidateSuspensionStatus(userId, role) {
        const key = `suspension:${role}:${userId}`;
        return await this.del(key);
    }

    // ─── Job application / interview module ──────────────────────────────────

    // Redacted resume S3 key — keyed by the source resumeDocumentId, no
    // expiry (redaction is the expensive step; run it once per uploaded
    // version, not once per view). Invalidated only when a candidate
    // uploads a new resume (resumeDocumentId changes, so the old cache entry
    // simply stops being looked up — nothing to actively evict).
    async getRedactedResumeKey(resumeDocumentId) {
        const key = `resume:redacted:${resumeDocumentId}`;
        return await this.get(key);
    }

    async setRedactedResumeKey(resumeDocumentId, s3Key) {
        const key = `resume:redacted:${resumeDocumentId}`;
        return await this._setNoExpiry(key, { s3Key });
    }

    // Plain SETEX with ttl=0 isn't valid in Redis — this route persists the
    // key without an expiry (Redis SET, no EX option) via the raw client,
    // matching the "no expiry, invalidate only on re-upload" contract above.
    async _setNoExpiry(key, value) {
        try {
            const client = await redisClient.getClientAsync();
            await client.set(key, JSON.stringify(value));
            return true;
        } catch (error) {
            logger.error('Cache set (no-expiry) error:', error);
            return false;
        }
    }

    // Hospital-facing application detail/list reads — short TTL, no
    // invalidation hooks (same short-staleness-window tradeoff already used
    // for getVacancyMatches/setVacancyMatches above).
    async getApplicationDetail(applicationId, viewerRole) {
        const key = `app:detail:${applicationId}:${viewerRole}`;
        return await this.get(key);
    }

    async setApplicationDetail(applicationId, viewerRole, data, ttl = 30) {
        const key = `app:detail:${applicationId}:${viewerRole}`;
        return await this.set(key, data, ttl);
    }

    async getVacancyApplications(vacancyId, status, page, limit) {
        const key = `app:vacancy:${vacancyId}:${status || 'all'}:${page}:${limit}`;
        return await this.get(key);
    }

    async setVacancyApplications(vacancyId, status, page, limit, data, ttl = 30) {
        const key = `app:vacancy:${vacancyId}:${status || 'all'}:${page}:${limit}`;
        return await this.set(key, data, ttl);
    }

}

module.exports = new CacheService();