const Duty = require('../models/Duty');
const { getCurrentIST } = require('./helpers');
const cacheService = require('../services/cache.service');

// Get staff duty status with caching 

async function getStaffDutyStatus(staffId) {
    try {
        // Check cache first (30 seconds TTL for real-time data)
        const cacheKey = `duty:status:${staffId}`;
        const cached = await cacheService.get(cacheKey);
        if (cached) return cached;

        const now = getCurrentIST();
        
        // Optimized query with proper indexes
        const [activeDuties, upcomingDuties] = await Promise.all([
            Duty.find({
                assignedTo: staffId,
                status: { $in: ['assigned', 'enroute', 'in-progress'] }
            })
            .select('date startTime endTime status hospital assignedAt startedAt')
            .populate('hospital', 'hospitalLegalName')
            .lean()
            .limit(10), // Limit to prevent memory issues

            Duty.find({
                assignedTo: staffId,
                status: 'available',
                date: { 
                    $gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
                    $lte: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7)
                }
            })
            .select('date startTime endTime hospital')
            .populate('hospital', 'hospitalLegalName')
            .sort({ date: 1, startTime: 1 })
            .lean()
            .limit(20) // Limit upcoming duties
        ]);

        const currentDuty = activeDuties.find(duty => {
            const dutyStart = new Date(duty.date);
            const [startHours, startMinutes] = duty.startTime.split(':');
            dutyStart.setHours(parseInt(startHours), parseInt(startMinutes), 0, 0);
            
            const dutyEnd = new Date(duty.date);
            const [endHours, endMinutes] = duty.endTime.split(':');
            dutyEnd.setHours(parseInt(endHours), parseInt(endMinutes), 0, 0);
            
            return now >= dutyStart && now <= dutyEnd;
        });

        const result = {
            hasActiveDuty: activeDuties.length > 0,
            hasUpcomingDuty: upcomingDuties.length > 0,
            currentDuty: currentDuty || null,
            activeDutyCount: activeDuties.length,
            upcomingDutyCount: upcomingDuties.length,
            nextDuty: upcomingDuties[0] || null,
            status: currentDuty ? 'in_duty' : 
                   activeDuties.length > 0 ? 'has_active_duties' : 
                   upcomingDuties.length > 0 ? 'has_upcoming_duties' : 'fully_available'
        };

        // Cache for 30 seconds
        await cacheService.set(cacheKey, result, 30);
        return result;
    } catch (error) {
        console.error(`Error getting duty status for staff ${staffId}:`, error);
        return {
            hasActiveDuty: false,
            hasUpcomingDuty: false,
            currentDuty: null,
            activeDutyCount: 0,
            upcomingDutyCount: 0,
            nextDuty: null,
            status: 'fully_available'
        };
    }
}



// Batch get duty status for multiple staff members 
async function getBatchStaffDutyStatus(staffIds) {
    const dutyStatusMap = new Map();
    
    try {
        // Check cache first for all staff
        const cacheKeys = staffIds.map(id => `duty:status:${id}`);
        const cacheOperations = cacheKeys.map(key => ({
            type: 'get',
            key
        }));
        
        const cacheResults = await cacheService.pipeline(cacheOperations);
        
        const uncachedIds = [];
        cacheResults.forEach((result, index) => {
            if (result && result[1]) {
                dutyStatusMap.set(staffIds[index].toString(), JSON.parse(result[1]));
            } else {
                uncachedIds.push(staffIds[index]);
            }
        });

        if (uncachedIds.length === 0) {
            return dutyStatusMap; // All data from cache
        }

        // Batch database queries for uncached staff
        const [activeDuties, upcomingDuties] = await Promise.all([
            Duty.find({
                assignedTo: { $in: uncachedIds },
                status: { $in: ['assigned', 'enroute', 'in-progress'] }
            })
            .select('assignedTo date startTime endTime status hospital assignedAt startedAt')
            .populate('hospital', 'hospitalLegalName')
            .lean()
            .limit(uncachedIds.length * 5), // Limit per staff

            Duty.find({
                assignedTo: { $in: uncachedIds },
                status: 'available',
                date: { 
                    $gte: new Date(getCurrentIST().getFullYear(), getCurrentIST().getMonth(), getCurrentIST().getDate()),
                    $lte: new Date(getCurrentIST().getFullYear(), getCurrentIST().getMonth(), getCurrentIST().getDate() + 7)
                }
            })
            .select('assignedTo date startTime endTime hospital')
            .populate('hospital', 'hospitalLegalName')
            .sort({ assignedTo: 1, date: 1, startTime: 1 })
            .lean()
            .limit(uncachedIds.length * 10)
        ]);

        // Process results and cache them
        const now = getCurrentIST();
        const cacheSetOperations = [];
        
        for (const staffId of uncachedIds) {
            const staffActiveDuties = activeDuties.filter(duty => 
                duty.assignedTo.toString() === staffId.toString()
            );
            
            const staffUpcomingDuties = upcomingDuties.filter(duty => 
                duty.assignedTo.toString() === staffId.toString()
            );

            const currentDuty = staffActiveDuties.find(duty => {
                const dutyStart = new Date(duty.date);
                const [startHours, startMinutes] = duty.startTime.split(':');
                dutyStart.setHours(parseInt(startHours), parseInt(startMinutes), 0, 0);
                
                const dutyEnd = new Date(duty.date);
                const [endHours, endMinutes] = duty.endTime.split(':');
                dutyEnd.setHours(parseInt(endHours), parseInt(endMinutes), 0, 0);
                
                return now >= dutyStart && now <= dutyEnd;
            });

            const result = {
                hasActiveDuty: staffActiveDuties.length > 0,
                hasUpcomingDuty: staffUpcomingDuties.length > 0,
                currentDuty: currentDuty || null,
                activeDutyCount: staffActiveDuties.length,
                upcomingDutyCount: staffUpcomingDuties.length,
                nextDuty: staffUpcomingDuties[0] || null,
                status: currentDuty ? 'in_duty' : 
                       staffActiveDuties.length > 0 ? 'has_active_duties' : 
                       staffUpcomingDuties.length > 0 ? 'has_upcoming_duties' : 'fully_available'
            };

            dutyStatusMap.set(staffId.toString(), result);
            
            // Prepare cache set operation
            cacheSetOperations.push({
                type: 'set',
                key: `duty:status:${staffId}`,
                value: result,
                ttl: 30
            });
        }

        // Batch cache set
        if (cacheSetOperations.length > 0) {
            await cacheService.pipeline(cacheSetOperations);
        }

        return dutyStatusMap;
    } catch (error) {
        console.error('Error in batch duty status lookup:', error);
        // Return default status for all staff if error occurs
        staffIds.forEach(staffId => {
            dutyStatusMap.set(staffId.toString(), {
                hasActiveDuty: false,
                hasUpcomingDuty: false,
                currentDuty: null,
                activeDutyCount: 0,
                upcomingDutyCount: 0,
                nextDuty: null,
                status: 'fully_available'
            });
        });
        return dutyStatusMap;
    }
}

module.exports = {
    getStaffDutyStatus,
    getBatchStaffDutyStatus
};