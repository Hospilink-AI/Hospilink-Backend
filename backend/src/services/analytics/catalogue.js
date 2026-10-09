// Every KPI the analytics module tracks or plans to track, with a plain
// definition the admin screen shows as a tooltip.
// availability: 'available' | 'coming_soon' | 'needs_payments' | 'needs_subscriptions'

const SECTIONS = [
    { key: 'overview', label: 'Overview', availability: 'available' },
    { key: 'marketplace', label: 'Marketplace health', availability: 'available' },
    { key: 'execution', label: 'Duty execution', availability: 'available' },
    { key: 'money', label: 'Money', availability: 'available' },
    { key: 'supply', label: 'Staff (supply)', availability: 'available' },
    { key: 'demand', label: 'Hospitals (demand)', availability: 'available' },
    { key: 'quality', label: 'Quality and trust', availability: 'available' },
    { key: 'support', label: 'Support and disputes', availability: 'available' },
    { key: 'recruitment', label: 'Recruitment', availability: 'available' },
    { key: 'engagement', label: 'Engagement', availability: 'available' },
    { key: 'geography', label: 'Geography', availability: 'available' }
];

const k = (section, key, label, definition, unit, availability = 'available') => ({ section, key, label, definition, unit, availability });

const KPIS = [
    // Overview
    k('overview', 'completedHours', 'Completed duty-hours', 'Scheduled hours of duties completed in the period. The North Star: work actually delivered.', 'hours'),
    k('overview', 'dutiesPosted', 'Duties posted', 'Duty slots created in the period (each slot of a multi-slot post counts).', 'count'),
    k('overview', 'fillRate', 'Fill rate', 'Posted duties a staff member accepted, divided by posted duties the hospital did not withdraw before acceptance.', 'ratio'),
    k('overview', 'completionRate', 'Completion rate', 'Completed duties divided by completed plus incomplete duties.', 'ratio'),
    k('overview', 'gmvCompleted', 'Completed GMV', 'Booked value (hourly rate × scheduled hours) of duties completed in the period.', 'inr'),
    k('overview', 'platformRevenue', 'Platform revenue', 'Net platform revenue. Projected from the commission setting until a payments ledger exists.', 'inr'),
    k('overview', 'activeHospitals', 'Hospitals that posted', 'Distinct hospitals that posted at least one duty in the period.', 'count'),
    k('overview', 'activeStaff', 'Staff who completed a duty', 'Distinct staff with at least one completed duty in the period.', 'count'),
    k('overview', 'openTickets', 'Open support tickets', 'Tickets in any active status right now.', 'count'),

    // Marketplace
    k('marketplace', 'medianTimeToFill', 'Median time to fill', 'Minutes from posting to a staff member accepting, median.', 'minutes'),
    k('marketplace', 'p90TimeToFill', 'Time to fill (90th percentile)', '90% of filled duties were accepted within this many minutes.', 'minutes'),
    k('marketplace', 'expiredRate', 'Expired unfilled', 'Posted duties that expired with nobody accepting them.', 'ratio'),
    k('marketplace', 'emergencyFillRate', 'Emergency fill rate', 'Fill rate for emergency duties only.', 'ratio'),
    k('marketplace', 'relistedShare', 'Relisted after a cancellation', 'Posted duties that went back to available after a staff cancellation.', 'ratio'),
    k('marketplace', 'offerFunnel', 'Offer funnel', 'Staff notified, staff who opened the duty, duties accepted.', 'count'),
    k('marketplace', 'leadTime', 'Posting lead time', 'Time between posting and shift start, with fill rate per band.', 'hours'),
    k('marketplace', 'demandHeat', 'Posting heatmap', 'Duties posted by weekday and hour (IST).', 'count'),
    k('marketplace', 'liquidity', 'Liquidity', 'Open future duties per verified, available staff member, by role (right now).', 'ratio'),

    // Execution
    k('execution', 'onTimeStartRate', 'On-time start', 'Started duties whose start OTP was verified within 10 minutes of the scheduled start.', 'ratio'),
    k('execution', 'medianStartDelay', 'Median start delay', 'Minutes between scheduled start and start OTP, median (negative = early).', 'minutes'),
    k('execution', 'noShowRate', 'Staff no-show rate', 'Duties that ended incomplete without the start OTP ever being verified.', 'ratio'),
    k('execution', 'staffCancellationRate', 'Staff cancellation rate', 'Staff cancellations divided by acceptances.', 'ratio'),
    k('execution', 'lateStaffCancellationShare', 'Late staff cancellations', 'Staff cancellations inside the late-cancellation band before shift start.', 'ratio'),
    k('execution', 'hospitalCancellationRate', 'Hospital cancellation rate', 'Scheduled duties the hospital cancelled.', 'ratio'),
    k('execution', 'otpLockRate', 'OTP lockouts', 'Started duties where a start or end OTP got locked.', 'ratio'),
    k('execution', 'adminOverrideRate', 'Admin overrides', 'Duties whose status an admin had to override.', 'ratio'),
    k('execution', 'confirmationDwell', 'Confirmation wait', 'Minutes a duty waited in pending confirmation before the hospital completed it, median.', 'minutes'),

    // Money
    k('money', 'gmvPosted', 'GMV posted', 'Booked value of duties posted in the period, excluding ones withdrawn before acceptance.', 'inr'),
    k('money', 'gmvFilled', 'GMV filled', 'Booked value of posted duties that were accepted.', 'inr'),
    k('money', 'averageHourlyRate', 'Average hourly rate', 'Completed GMV divided by completed hours.', 'inr'),
    k('money', 'averageDutyValue', 'Average duty value', 'Completed GMV divided by completed duties.', 'inr'),
    k('money', 'emergencyPremium', 'Emergency premium', 'How much higher the emergency hourly rate is than the normal one.', 'ratio'),
    k('money', 'boostSpend', 'Rate boost spend', 'Extra paid on completed duties whose rate was raised after a late cancellation.', 'inr'),
    k('money', 'paidConfirmedShare', 'Confirmed paid', 'Completed duties the hospital reported as paid.', 'ratio'),
    k('money', 'payLaterAgeing', 'Pay-later ageing', '"Will pay later" duties not yet confirmed paid, by days since completion.', 'count'),
    k('money', 'gmvConcentration', 'GMV concentration', 'Share of completed GMV from the top 10 hospitals.', 'ratio'),
    k('money', 'commission', 'Platform commission', 'Fees earned on duties. Projected until payments go live.', 'inr'),
    k('money', 'takeRate', 'Take rate', 'Platform commission divided by GMV.', 'ratio'),
    k('money', 'revenuePerCompletedDuty', 'Revenue per completed duty', 'Net revenue divided by completed duties.', 'inr'),
    k('money', 'mrr', 'Monthly recurring revenue', 'Subscription revenue normalised to a month.', 'inr', 'needs_subscriptions'),
    k('money', 'arr', 'Annual recurring revenue', 'MRR × 12.', 'inr', 'needs_subscriptions'),
    k('money', 'arpa', 'Average revenue per account', 'Subscription revenue per paying hospital.', 'inr', 'needs_subscriptions'),
    k('money', 'subscriptionChurn', 'Subscription churn', 'Paying hospitals that cancelled in the period.', 'ratio', 'needs_subscriptions'),
    k('money', 'trialConversion', 'Trial to paid', 'Trials that converted to a paid plan.', 'ratio', 'needs_subscriptions'),
    k('money', 'paymentSuccessRate', 'Payment success rate', 'Successful charges divided by attempts.', 'ratio', 'needs_payments'),
    k('money', 'refundRate', 'Refunds and chargebacks', 'Refunded amount as a share of charged GMV.', 'ratio', 'needs_payments'),
    k('money', 'payoutLag', 'Payout lag', 'Time from duty completion to staff payout.', 'hours', 'needs_payments'),
    k('money', 'receivables', 'Outstanding receivables', 'Charged but unsettled hospital payments.', 'inr', 'needs_payments'),
    k('money', 'gstCollected', 'GST collected', 'GST on platform fees.', 'inr', 'needs_payments'),

    // Supply
    k('supply', 'staffSignups', 'Staff signups', 'New staff accounts created in the period.', 'count'),
    k('supply', 'signupsVerified', 'Signups now verified', 'Share of the period\'s staff signups that are verified today.', 'ratio'),
    k('supply', 'staffVerified', 'Staff verified', 'Staff an admin verified in the period.', 'count'),
    k('supply', 'staffTimeToVerify', 'Time to verify', 'Hours from signup to verification, median, for staff verified in the period.', 'hours'),
    k('supply', 'activeStaff', 'Active staff', 'Staff with at least one completed duty in the period.', 'count'),
    k('supply', 'newActiveStaff', 'First duty completed', 'Staff whose first ever completed duty fell in the period.', 'count'),
    k('supply', 'utilisation', 'Utilisation', 'Completed duties per active staff member.', 'ratio'),
    k('supply', 'churnedStaff', 'Lapsed staff', 'Staff active in the previous period with no completed duty this period.', 'count'),
    k('supply', 'availabilityRate', 'Availability rate', 'Verified staff marked available right now; the comparison comes from the daily snapshot.', 'ratio'),
    k('supply', 'staffVerificationFunnel', 'Staff verification funnel', 'Signups in the period: profile complete → documents uploaded → verified.', 'count'),
    k('supply', 'staffRetention', 'Staff retention cohorts', 'Staff grouped by month of first completed duty; share still completing duties N months later.', 'ratio'),
    k('supply', 'staffMix', 'Staff mix', 'Verified staff by role, city and experience; all staff by how the profile was filled.', 'count'),
    k('supply', 'staffRatingDistribution', 'Staff rating distribution', 'Rated staff by average rating band.', 'count'),
    k('supply', 'topEarners', 'Top earners', 'Staff with the highest completed duty value in the period.', 'inr'),

    // Demand
    k('demand', 'hospitalSignups', 'Hospital signups', 'New hospital accounts created in the period.', 'count'),
    k('demand', 'hospitalsVerified', 'Hospitals verified', 'Hospitals an admin verified in the period.', 'count'),
    k('demand', 'hospitalTimeToVerify', 'Time to verify', 'Hours from signup to verification, median.', 'hours'),
    k('demand', 'activation', 'Activation', 'Verified hospitals that have posted at least one duty, ever.', 'ratio'),
    k('demand', 'activeHospitals', 'Hospitals that posted', 'Distinct hospitals posting in the period.', 'count'),
    k('demand', 'newPostingHospitals', 'First duty posted', 'Hospitals whose first ever duty was posted in the period.', 'count'),
    k('demand', 'timeToFirstPost', 'Time to first post', 'Hours from signup to first duty, median, for first posts in the period.', 'hours'),
    k('demand', 'timeToFirstFill', 'Time to first fill', 'Hours from signup to the first accepted duty, median.', 'hours'),
    k('demand', 'repeatPosting', 'Repeat posting', 'Hospitals that posted in the previous period and again in this one.', 'ratio'),
    k('demand', 'dutiesPerHospital', 'Duties per hospital', 'Duties posted per posting hospital.', 'ratio'),
    k('demand', 'hospitalCancellationRate', 'Hospital cancellations', 'Posted duties the hospital later cancelled.', 'ratio'),
    k('demand', 'hospitalVerificationFunnel', 'Hospital funnel', 'Signups in the period: profile complete → documents → verified → posted a duty.', 'count'),
    k('demand', 'hospitalRetention', 'Hospital retention cohorts', 'Hospitals grouped by month of first post; share still posting N months later.', 'ratio'),
    k('demand', 'atRiskHospitals', 'At-risk hospitals', 'Hospitals that posted in the last 90 days but not in the last 30.', 'count'),

    // Quality
    k('quality', 'staffRating', 'Rating given to staff', 'Average stars hospitals gave staff in the period (suppressed reviews left out).', 'rating'),
    k('quality', 'hospitalRating', 'Rating given to hospitals', 'Average stars staff gave hospitals in the period.', 'rating'),
    k('quality', 'staffReviewCompletion', 'Hospitals rating staff', 'Completed duties in the period that the hospital rated.', 'ratio'),
    k('quality', 'hospitalReviewCompletion', 'Staff rating hospitals', 'Completed duties in the period that the staff member rated.', 'ratio'),
    k('quality', 'complaintsPer100', 'Complaints per 100 duties', 'Duty and payment complaints raised per 100 completed duties.', 'ratio'),
    k('quality', 'penaltiesApplied', 'Rating penalties', 'Rating penalties applied through upheld complaints.', 'count'),
    k('quality', 'penaltiesReversed', 'Penalties reversed', 'Rating penalties reversed on appeal.', 'count'),
    k('quality', 'suppressedReviews', 'Suppressed reviews', 'Reviews hidden by an admin.', 'count'),
    k('quality', 'patternFlags', 'Pattern flags', 'Repeat-behaviour flags raised, and how they ended.', 'count'),
    k('quality', 'suspensions', 'Suspensions', 'Accounts suspended in the period.', 'count'),

    // Support
    k('support', 'tickets', 'Tickets raised', 'Support tickets raised in the period, by area, category, source, language and priority.', 'count'),
    k('support', 'openBacklog', 'Open tickets', 'Tickets in any active status right now, with their age and queue.', 'count'),
    k('support', 'chatbotDeflection', 'Chatbot deflection', 'Finished chatbot conversations that did not need a ticket.', 'ratio'),
    k('support', 'botAccuracy', 'Bot accuracy', 'Tickets where the agent kept the category the bot suggested.', 'ratio'),
    k('support', 'acknowledgeSla', 'Acknowledged within SLA', 'Tickets claimed or moved out of New/Triage before the acknowledge deadline.', 'ratio'),
    k('support', 'firstReplySla', 'First reply within SLA', 'Tickets with a first reply before the first-reply deadline.', 'ratio'),
    k('support', 'decideSla', 'Decided within SLA', 'Closed tickets closed before the decision deadline.', 'ratio'),
    k('support', 'resolutionTime', 'Time to close', 'Hours from a ticket being raised to it closing, median.', 'hours'),
    k('support', 'appealRate', 'Appeal rate', 'Appeals raised against decided tickets.', 'ratio'),
    k('support', 'overturnRate', 'Overturn rate', 'Decided appeals that overturned or varied the outcome.', 'ratio'),
    k('support', 'workload', 'Workload', 'Tickets closed per admin.', 'count'),
    k('support', 'feedbackSentiment', 'Feedback sentiment', 'Platform feedback by sentiment and area, and how much became a ticket.', 'count'),

    // Recruitment
    k('recruitment', 'vacanciesPosted', 'Vacancies posted', 'Permanent vacancies posted in the period, by specialty.', 'count'),
    k('recruitment', 'liveVacancies', 'Live vacancies', 'Vacancies not deleted, right now.', 'count'),
    k('recruitment', 'applications', 'Applications', 'Applications made in the period.', 'count'),
    k('recruitment', 'applicationsPerVacancy', 'Applications per vacancy', 'Applications per vacancy that received any.', 'ratio'),
    k('recruitment', 'shortlistRate', 'Shortlist rate', 'Applications that reached shortlisted or further.', 'ratio'),
    k('recruitment', 'hiringFunnel', 'Hiring funnel', 'Applied → shortlisted → interview confirmed → interviewed → offered → hired.', 'count'),
    k('recruitment', 'hires', 'Hires', 'Applications from the period that ended in a hire.', 'count'),
    k('recruitment', 'timeToHire', 'Time to hire', 'Days from application to hire, median.', 'days'),
    k('recruitment', 'offerAcceptance', 'Offer acceptance', 'Offers that ended in a hire, out of offers that have ended.', 'ratio'),
    k('recruitment', 'candidateNoShowRate', 'Candidate no-shows', 'Recorded interviews the candidate missed.', 'ratio'),
    k('recruitment', 'hospitalNoShowRate', 'Hospital no-shows', 'Recorded interviews the hospital missed.', 'ratio'),
    k('recruitment', 'rescheduleRate', 'Reschedules', 'Confirmed interviews that were rescheduled at least once.', 'ratio'),
    k('recruitment', 'matchTierHires', 'Match tier outcomes', 'Shortlist and hire rate for exact, related and unscored matches.', 'ratio'),

    // Engagement
    k('engagement', 'dau', 'Daily active users', 'Distinct users signing in per day, averaged over the period. Older days come from the daily snapshot.', 'count'),
    k('engagement', 'wau', 'Weekly active users', 'Distinct users signing in during the last 7 days of the period.', 'count'),
    k('engagement', 'mau', 'Monthly active users', 'Distinct users signing in during the last 30 days of the period.', 'count'),
    k('engagement', 'stickiness', 'Stickiness', 'Average daily active users divided by monthly active users.', 'ratio'),
    k('engagement', 'seenLast30Days', 'Seen in 30 days', 'Users whose last sign-in was in the last 30 days.', 'count'),
    k('engagement', 'notificationReadRate', 'Notification read rate', 'Notifications opened, overall and by type.', 'ratio'),
    k('engagement', 'pushPlatforms', 'Push platforms', 'Users with push notifications, by Android, iOS and web.', 'count'),
    k('engagement', 'failedLogins', 'Failed sign-ins', 'Failed sign-in attempts.', 'count'),
    k('engagement', 'securityEvents', 'Security events', 'Suspicious sign-ins, lockouts and other security events.', 'count'),
    k('engagement', 'documentsVerified', 'Documents verified', 'Documents verified in the period.', 'count'),
    k('engagement', 'documentAutoVerifyRate', 'Automatic verification', 'Documents verified automatically rather than by an admin.', 'ratio'),
    k('engagement', 'documentVerifyTime', 'Document verification time', 'Hours from upload to verification, median.', 'hours'),
    k('engagement', 'documentBacklog', 'Document backlog', 'Documents waiting for review right now.', 'count'),

    // Geography
    k('geography', 'cityTable', 'City view', 'Per city: verified hospitals and staff, available staff, duties posted, fill rate, completed GMV and average rate.', 'mixed'),
    k('geography', 'shortageCities', 'Shortage cities', 'Cities with at least 5 posts in the period and a fill rate under 60%.', 'count'),
    k('geography', 'demandWithoutSupply', 'Demand without supply', 'Cities with duties posted but no available staff.', 'count'),
    k('geography', 'stateTable', 'State view', 'The city figures rolled up by state.', 'mixed')
];

module.exports = { SECTIONS, KPIS };
