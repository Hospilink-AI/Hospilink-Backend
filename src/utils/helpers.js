// Helper function to convert time string to minutes
function timeToMinutes(timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
}

// Helper function to check if two time ranges overlap
function doTimeRangesOverlap(start1, end1, start2, end2) {
    const start1Minutes = timeToMinutes(start1);
    const end1Minutes = timeToMinutes(end1);
    const start2Minutes = timeToMinutes(start2);
    const end2Minutes = timeToMinutes(end2);
    
    // Allow duties that start exactly when another ends (no overlap)
    // Only prevent actual time overlap
    return start1Minutes < end2Minutes && start2Minutes < end1Minutes;
}

// Helper function to check date overlap including overnight duties
function doDutiesOverlap(newDuty, existingDuty) {
    // Check if dates are the same
    const newDate = new Date(newDuty.date).toDateString();
    const existingDate = new Date(existingDuty.date).toDateString();
    
    if (newDate === existingDate) {
        return doTimeRangesOverlap(
            newDuty.startTime, newDuty.endTime,
            existingDuty.startTime, existingDuty.endTime
        );
    }
    
    // Handle overnight duties
    if (newDuty.isOvernightDuty && newDuty.endDate) {
        const newEndDate = new Date(newDuty.endDate).toDateString();
        if (newEndDate === existingDate) {
            return doTimeRangesOverlap(
                newDuty.startTime, newDuty.endTime,
                existingDuty.startTime, existingDuty.endTime
            );
        }
    }
    
    if (existingDuty.isOvernightDuty && existingDuty.endDate) {
        const existingEndDate = new Date(existingDuty.endDate).toDateString();
        if (existingEndDate === newDate) {
            return doTimeRangesOverlap(
                newDuty.startTime, newDuty.endTime,
                existingDuty.startTime, existingDuty.endTime
            );
        }
    }
    
    return false;
}

// Helper function to convert any date to IST (only for UTC dates)
function toIST(date) {
    return new Date(date.getTime() + (5.5 * 60 * 60 * 1000));
}

// Helper function to get current IST time (server already in IST)
function getCurrentIST() {
    return new Date(); // Server is already in IST timezone
}



// Helper function to normalize role names for comparison
function normalizeRole(role) {
    return role
        .toLowerCase()
        .replace(/[()\/]/g, '') // Remove parentheses and slashes
        .replace(/\s+/g, '_')   // Replace spaces with underscores
        .replace(/_+/g, '_')    // Replace multiple underscores with single
        .replace(/^_|_$/g, ''); // Remove leading/trailing underscores
}



// Calculate the duration of a duty shift in hours
function calculateDutyDuration(startDate, startTime, endTime, isOvernightDuty, endDate) {
    // Parse time strings to get hours and minutes
    const [startHours, startMinutes] = startTime.split(':').map(Number);
    const [endHours, endMinutes] = endTime.split(':').map(Number);

    // Create Date objects for start and end times
    const start = new Date(startDate);
    start.setHours(startHours, startMinutes, 0, 0);

    let end;

    if (endDate && endDate.getTime() !== startDate.getTime()) {
        // Multi-day duty: use endDate (takes precedence over isOvernightDuty)
        end = new Date(endDate);
        end.setHours(endHours, endMinutes, 0, 0);
    } else if (isOvernightDuty && endHours < startHours) {
        // Overnight duty: add one day to end time
        end = new Date(startDate);
        end.setDate(end.getDate() + 1);
        end.setHours(endHours, endMinutes, 0, 0);
    } else {
        // Same-day duty
        end = new Date(startDate);
        end.setHours(endHours, endMinutes, 0, 0);
    }

    // Calculate duration in milliseconds, then convert to hours
    const durationMs = end - start;
    const durationHours = durationMs / (1000 * 60 * 60);

    // Return 0 if duration is negative (invalid)
    return Math.max(0, durationHours);
}


// Helper function to format duration
function formatDuration(startTime, endTime, date, isOvernightDuty, endDate) {
    let durationHours;
    
    // Handle decimal hours input (for totalHours)
    if (typeof startTime === 'number' && endTime === undefined && date === undefined && isOvernightDuty === undefined && endDate === undefined) {
        durationHours = startTime;
    } else {
        // Handle time components input (for individual duties)
        durationHours = calculateDutyDuration(date, startTime, endTime, isOvernightDuty, endDate);
    }
    
    const totalMinutes = Math.floor(durationHours * 60);

    if (totalMinutes < 60) {
        return `${totalMinutes} min`;
    } else {
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        return `${hours}h ${minutes}m`;
    }
}



module.exports = {
    timeToMinutes,
    doTimeRangesOverlap,
    doDutiesOverlap,
    toIST,
    getCurrentIST,
    normalizeRole,
    calculateDutyDuration,
    formatDuration
};