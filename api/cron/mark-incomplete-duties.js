const connectDB = require('../../src/config/database');
const Duty = require('../../src/models/Duty');
const { getCurrentIST, toIST } = require('../../src/utils/helpers');

module.exports = async (req, res) => {
    // Vercel Cron passes an Authorization header with CRON_SECRET
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        await connectDB();

        const istNow = getCurrentIST();
        const istToday = new Date(istNow.getFullYear(), istNow.getMonth(), istNow.getDate());

        console.log(`[${istNow.toISOString()}] Starting incomplete duties check...`);

        // Find duties that are stuck in 'assigned' or 'enroute' status
        const stuckDuties = await Duty.find({
            status: { $in: ['assigned', 'enroute'] },
            date: {
                $gte: new Date(istToday.getFullYear(), istToday.getMonth(), istToday.getDate() - 1), // Check yesterday too for overnight duties
                $lt: new Date(istToday.getFullYear(), istToday.getMonth(), istToday.getDate() + 1)
            }
        }).populate('hospital', 'hospitalLegalName')
         .populate({
             path: 'assignedTo',
             populate: {
                 path: 'user',
                 select: 'name email'
             }
         });

        console.log(`Found ${stuckDuties.length} duties to check for incompleteness`);

        const bulkOps = [];
        const incompleteDuties = [];

        for (const duty of stuckDuties) {
            // Calculate duty start time in IST
            const [startHours, startMinutes] = duty.startTime.split(':').map(Number);
            const dutyStartDate = new Date(duty.date);
            const istDutyDate = toIST(dutyStartDate);
            const istDutyStartTime = new Date(istDutyDate);
            istDutyStartTime.setHours(startHours, startMinutes, 0, 0);

            // Check if 30 minutes have passed since duty start time
            const thirtyMinutesAfterStart = new Date(istDutyStartTime.getTime() + 30 * 60 * 1000);

            if (istNow >= thirtyMinutesAfterStart) {
                const timeDiff = istNow - istDutyStartTime;
                const minutesOverdue = Math.floor(timeDiff / (1000 * 60));

                // Log the duty being marked as incomplete
                const staffName = duty.assignedTo?.user?.name || 'Unknown Staff';
                const hospitalName = duty.hospital?.hospitalLegalName || 'Unknown Hospital';
                
                console.log(`Marking duty INCOMPLETE: ${hospitalName} - ${duty.staffRole} - ${staffName}`);
                console.log(`  -> Duty ID: ${duty._id}`);
                console.log(`  -> Start Time: ${duty.startTime} (was ${minutesOverdue} minutes ago)`);
                console.log(`  -> Status was: ${duty.status}`);
                console.log(`  -> Assigned at: ${duty.assignedAt || 'N/A'}`);
                console.log(`  -> Enroute at: ${duty.enrouteAt || 'N/A'}`);

                incompleteDuties.push({
                    dutyId: duty._id,
                    hospitalName,
                    staffName,
                    staffRole: duty.staffRole,
                    startTime: duty.startTime,
                    previousStatus: duty.status,
                    minutesOverdue
                });

                bulkOps.push({
                    updateOne: {
                        filter: { _id: duty._id },
                        update: {
                            $set: {
                                status: 'incomplete',
                                incompleteAt: istNow
                            },
                            $push: {
                                statusHistory: {
                                    status: 'incomplete',
                                    timestamp: istNow,
                                    changedBy: 'system',
                                    reason: `Automatically marked incomplete - status was '${duty.status}' for ${minutesOverdue} minutes after duty start time`
                                }
                            }
                        }
                    }
                });
            }
        }

        // Execute bulk operations if any
        let markedIncompleteCount = 0;
        if (bulkOps.length > 0) {
            const result = await Duty.bulkWrite(bulkOps);
            markedIncompleteCount = result.modifiedCount;

            console.log(`\n=== INCOMPLETE DUTIES SUMMARY ===`);
            console.log(`Total duties marked incomplete: ${markedIncompleteCount}`);
            incompleteDuties.forEach(duty => {
                console.log(`• ${duty.hospitalName} - ${duty.staffRole} - ${duty.staffName} (${duty.minutesOverdue}min overdue)`);
            });
            console.log(`================================\n`);
        } else {
            console.log(`No duties found to mark as incomplete`);
        }

        res.status(200).json({ 
            success: true, 
            markedIncomplete: markedIncompleteCount,
            details: incompleteDuties
        });

    } catch (error) {
        console.error('Cron mark-incomplete error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};