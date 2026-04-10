const DelayedJob = require('../models/DelayedJob');

class DelayedJobService {

    async scheduleRateShiftJob(duty) {
        const executeAt = new Date(duty.completedAt.getTime() + (30 * 60 * 1000));
        // const executeAt = new Date(Date.now() + 10000); // 10 sec for testing

        await DelayedJob.create({
            type: 'RATE_SHIFT',
            executeAt,
            payload: {
                dutyId: duty._id,
                hospitalUserId: duty.hospital.user._id.toString(),
                staffName: duty.assignedTo?.user?.name || 'Medical Staff'
            }
        });
    }

    async scheduleDutyExpiringJob(duty, matchingStaffUserIds) {
        const dutyDate = new Date(duty.date);
        const [hours, minutes] = duty.startTime.split(':');

        const expiryTime = new Date(dutyDate);
        expiryTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);

        // 5 minutes before expiry
        // const executeAt = new Date(expiryTime.getTime() - (5 * 60 * 1000));
        const executeAt = new Date(Date.now() + 15000); // 15 sec
        //  prevent past scheduling
        if (executeAt <= new Date()) return;

        //  prevent duplicate jobs
        await DelayedJob.deleteMany({
            type: 'DUTY_EXPIRING',
            'payload.dutyId': duty._id
        });

        await DelayedJob.create({
            type: 'DUTY_EXPIRING',
            executeAt,
            payload: {
                dutyId: duty._id,
                staffRole: duty.staffRole,
                hospitalName: duty.hospital?.hospitalLegalName,
                matchingStaffUserIds
            }
        });
    }
}

module.exports = new DelayedJobService();