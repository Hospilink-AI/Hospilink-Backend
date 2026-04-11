const DelayedJob = require('../models/DelayedJob');

class DelayedJobService {

    async scheduleDutyExpiringJob(duty, matchingStaffUserIds) {
        const dutyDate = new Date(duty.date);
        const [hours, minutes] = duty.startTime.split(':');

        const expiryTime = new Date(dutyDate);
        expiryTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);

        // 5 minutes before expiry
        //const executeAt = new Date(Date.now() + 15000);// for testing
        const executeAt = new Date(expiryTime.getTime() - (5 * 60 * 1000));
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