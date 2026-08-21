const JobApplication = require('../models/JobApplication');
const jobApplicationService = require('./jobApplication.service');
const systemConfigService = require('./systemConfig.service');
const noShowPenaltyService = require('./noShowPenalty.service');
const notificationEmitter = require('./notificationEmitter');
const { UnprocessableEntityError, ConflictError, NotFoundError } = require('../middleware/error.middleware');
const { SLOT_GRANULARITY_MINUTES } = require('../utils/jobApplication.constants');

function actorIdOf(requester) {
    return requester.id || requester._id;
}

function toDate(v) {
    return v instanceof Date ? v : new Date(v);
}

// Everything in this file operates on the `interview` sub-document of an
// already-created JobApplication (see jobApplication.service.js for
// apply/review/withdraw). Ownership/visibility checks are reused from that
// module's _loadOwnedApplication / _loadOwnApplicantApplication rather than
// duplicated here.
class InterviewSchedulingService {
    // shortlisted -> slots_offered
    async offerSlots(applicationId, requester, { slots, durationMinutes }) {
        const application = await jobApplicationService._loadOwnedApplication(applicationId, requester);
        if (application.status !== 'shortlisted') {
            throw new UnprocessableEntityError(`Cannot offer interview slots from status ${application.status}`);
        }

        await noShowPenaltyService.assertNotSuspended(application.staff);

        const resolvedDuration = durationMinutes || await systemConfigService.getEffective('interview.slotDurationDefault');
        await this._validateSlotWindow(slots, resolvedDuration);

        const { normalizedSlots, offeredAt, expiresAt } = await this._buildOfferWindow(slots);
        const actorId = actorIdOf(requester);

        application.status = 'slots_offered';
        application.interview.offer = {
            slots: normalizedSlots,
            durationMinutes: resolvedDuration,
            offeredAt,
            offeredBy: actorId,
            expiresAt,
            cancelledAt: null,
            cancelReason: null,
            cancelReasonText: null,
            nudgesSent: { day3: false, day10: false, day18: false }
        };
        application.interview.candidatePicks = undefined;
        application.interview.pickedAt = null;
        application.interview.selectionNudgesSent = { day3: false, day10: false, day18: false };
        application.pushHistory('slots_offered', actorId);

        await application.save();
        await notificationEmitter.emitSlotsOffered(application);
        return application.toObject();
    }

    // slots_offered -> slot_selected
    async selectSlots(applicationId, userId, picks) {
        const application = await jobApplicationService._loadOwnApplicantApplication(applicationId, userId);
        if (application.status !== 'slots_offered') {
            throw new UnprocessableEntityError(`Cannot select interview slots from status ${application.status}`);
        }

        const offeredSlots = application.interview.offer?.slots || [];
        const normalizedPicks = (picks || []).map(p => ({ start: toDate(p.start), end: toDate(p.end) }));

        const allValid = normalizedPicks.length > 0 && normalizedPicks.every(pick =>
            offeredSlots.some(s => s.start.getTime() === pick.start.getTime() && s.end.getTime() === pick.end.getTime())
        );
        if (!allValid) {
            throw new UnprocessableEntityError('Picks must be a non-empty subset of the offered slots.');
        }

        application.status = 'slot_selected';
        application.interview.candidatePicks = normalizedPicks;
        application.interview.pickedAt = new Date();
        application.pushHistory('slot_selected', userId);

        await application.save();
        await notificationEmitter.emitCandidatePickedSlots(application);
        return application.toObject();
    }

    // slot_selected -> confirmed. The one move that consumes a slot — a
    // conditional write, not a check-then-write. See models/JobApplication.js's
    // partial unique index on { vacancy, interview.confirmedSlot.start }.
    async confirmInterview(applicationId, requester, { slotStart, slotEnd, meetingLink, interviewerName, interviewerDesignation }) {
        const application = await jobApplicationService._loadOwnedApplication(applicationId, requester);
        if (application.status !== 'slot_selected') {
            throw new UnprocessableEntityError(`Cannot confirm an interview from status ${application.status}`);
        }

        const start = toDate(slotStart);
        const end = toDate(slotEnd);
        const picks = application.interview.candidatePicks || [];
        const pickMatches = picks.some(p => p.start.getTime() === start.getTime() && p.end.getTime() === end.getTime());
        if (!pickMatches) {
            throw new UnprocessableEntityError("The selected slot is not one of the candidate's picked slots.");
        }

        const actorId = actorIdOf(requester);

        try {
            const updated = await JobApplication.findOneAndUpdate(
                { _id: applicationId, status: 'slot_selected' },
                {
                    $set: {
                        status: 'confirmed',
                        'interview.confirmedSlot.start': start,
                        'interview.confirmedSlot.end': end,
                        'interview.confirmedAt': new Date(),
                        'interview.confirmedBy': actorId,
                        'interview.meetingLink': meetingLink,
                        'interview.interviewerName': interviewerName,
                        'interview.interviewerDesignation': interviewerDesignation
                    },
                    $push: {
                        statusHistory: { status: 'confirmed', timestamp: new Date(), changedBy: actorId, isLateChange: false },
                        'interview.linkHistory': { link: meetingLink, changedAt: new Date(), changedBy: actorId }
                    }
                },
                { new: true }
            );

            if (!updated) {
                throw new UnprocessableEntityError('This application is no longer awaiting confirmation.');
            }

            await notificationEmitter.emitInterviewConfirmed(updated);
            return { conflict: false, application: updated.toObject() };
        } catch (err) {
            // E11000 on the partial unique index — another application on this
            // same vacancy already holds this exact start time. Never a bare
            // 500: re-render the confirm screen with this slot blocked.
            if (err.code === 11000) {
                return this._buildSlotConflictResponse(application, start);
            }
            throw err;
        }
    }

    async _buildSlotConflictResponse(application, attemptedStart) {
        const picks = application.interview.candidatePicks || [];
        const pickStarts = picks.map(p => p.start);

        const confirmedElsewhere = await JobApplication.find({
            vacancy: application.vacancy,
            _id: { $ne: application._id },
            'interview.confirmedSlot.start': { $in: pickStarts }
        }).distinct('interview.confirmedSlot.start');

        const takenTimes = new Set(confirmedElsewhere.map(d => new Date(d).getTime()));
        takenTimes.add(new Date(attemptedStart).getTime());

        const remainingPicks = picks.filter(p => !takenTimes.has(p.start.getTime()));

        return {
            conflict: true,
            blockedSlot: { start: attemptedStart },
            remainingPicks,
            needsReoffer: remainingPicks.length === 0
        };
    }

    // slots_offered | slot_selected -> shortlisted
    async cancelOffer(applicationId, requester, reason, reasonText) {
        const application = await jobApplicationService._loadOwnedApplication(applicationId, requester);
        if (!['slots_offered', 'slot_selected'].includes(application.status)) {
            throw new UnprocessableEntityError(`Cannot cancel an interview offer from status ${application.status}`);
        }

        const actorId = actorIdOf(requester);
        application.status = 'shortlisted';
        if (application.interview.offer) {
            application.interview.offer.cancelledAt = new Date();
            application.interview.offer.cancelReason = reason;
            application.interview.offer.cancelReasonText = reasonText || null;
        }
        application.interview.candidatePicks = undefined;
        application.interview.pickedAt = null;
        application.pushHistory('shortlisted', actorId, reason);

        await application.save();
        await notificationEmitter.emitInterviewCancelled(application, 'hospital', reason, reasonText);
        return application.toObject();
    }

    // confirmed -> slots_offered — releases the old slot and opens a fresh
    // offer in one write. Also the mechanics behind markNoShow(reoffer:true).
    async rescheduleInterview(applicationId, requester, { slots, durationMinutes }, reason, reasonText) {
        const application = await jobApplicationService._loadOwnedApplication(applicationId, requester);
        if (application.status !== 'confirmed') {
            throw new UnprocessableEntityError(`Cannot reschedule from status ${application.status}`);
        }

        const cap = await systemConfigService.getEffective('interview.rescheduleCap');
        if (application.interview.rescheduleCount >= cap) {
            throw new ConflictError(
                `This application has already been rescheduled ${cap} times — the only remaining moves are to hold the interview or cancel it.`
            );
        }

        const resolvedDuration = durationMinutes || await systemConfigService.getEffective('interview.slotDurationDefault');
        await this._validateSlotWindow(slots, resolvedDuration);
        const { normalizedSlots, offeredAt, expiresAt } = await this._buildOfferWindow(slots);

        const previousSlot = application.interview.confirmedSlot?.start
            ? { start: application.interview.confirmedSlot.start, end: application.interview.confirmedSlot.end }
            : null;
        const isLateChange = await this._computeIsLateChange(application.interview.confirmedSlot?.start);
        const actorId = actorIdOf(requester);
        const by = requester.role === 'hospital' ? 'hospital' : 'staff';

        application.status = 'slots_offered';
        // Unsets confirmedSlot.start/end (no default in the schema — see the
        // model's comment), which removes this document from the partial
        // unique index's filter and frees that wall-clock time immediately.
        application.interview.confirmedSlot = undefined;
        application.interview.confirmedAt = null;
        application.interview.confirmedBy = null;
        application.interview.offer = {
            slots: normalizedSlots,
            durationMinutes: resolvedDuration,
            offeredAt,
            offeredBy: actorId,
            expiresAt,
            cancelledAt: null,
            cancelReason: null,
            cancelReasonText: null,
            nudgesSent: { day3: false, day10: false, day18: false }
        };
        application.interview.candidatePicks = undefined;
        application.interview.pickedAt = null;
        application.interview.rescheduleCount += 1;
        application.interview.rescheduleHistory.push({ by, reason, reasonText: reasonText || undefined, previousSlot });
        application.pushHistory('slots_offered', actorId, reason, isLateChange);

        await application.save();
        await notificationEmitter.emitInterviewRescheduled(application);
        return application.toObject();
    }

    // confirmed -> shortlisted, either side.
    async cancelInterview(applicationId, requester, reason, reasonText) {
        const isHospital = requester.role === 'hospital';
        const application = isHospital
            ? await jobApplicationService._loadOwnedApplication(applicationId, requester)
            : await jobApplicationService._loadOwnApplicantApplication(applicationId, actorIdOf(requester));

        if (application.status !== 'confirmed') {
            throw new UnprocessableEntityError(`Cannot cancel an interview from status ${application.status}`);
        }

        const isLateChange = await this._computeIsLateChange(application.interview.confirmedSlot?.start);
        const actorId = actorIdOf(requester);

        application.status = 'shortlisted';
        application.interview.confirmedSlot = undefined;
        application.interview.confirmedAt = null;
        application.interview.confirmedBy = null;
        application.interview.offer = undefined;
        application.interview.candidatePicks = undefined;
        application.pushHistory('shortlisted', actorId, reason, isLateChange);

        await application.save();
        await notificationEmitter.emitInterviewCancelled(application, isHospital ? 'staff' : 'hospital', reason, reasonText);
        return application.toObject();
    }

    // confirmed -> confirmed (flagged). Candidate-only — cannot move the
    // interview themselves, this just surfaces the request to the recruiter.
    async requestReschedule(applicationId, userId, reason, reasonText) {
        const application = await jobApplicationService._loadOwnApplicantApplication(applicationId, userId);
        if (application.status !== 'confirmed') {
            throw new UnprocessableEntityError(`Cannot request a reschedule from status ${application.status}`);
        }

        application.interview.rescheduleRequest = {
            requestedAt: new Date(), reason, reasonText: reasonText || null, pending: true
        };
        await application.save();
        await notificationEmitter.emitRescheduleRequested(application);
        return application.toObject();
    }

    // Recruiter-only, before the interview starts.
    async updateMeetingLink(applicationId, requester, { meetingLink, interviewerName, interviewerDesignation }) {
        const application = await jobApplicationService._loadOwnedApplication(applicationId, requester);
        if (application.status !== 'confirmed') {
            throw new UnprocessableEntityError('The meeting link can only be changed while the interview is confirmed.');
        }
        if (application.interview.confirmedSlot?.start && new Date() >= application.interview.confirmedSlot.start) {
            throw new UnprocessableEntityError('The meeting link can no longer be changed — the interview has started.');
        }

        const actorId = actorIdOf(requester);
        application.interview.meetingLink = meetingLink;
        if (interviewerName) application.interview.interviewerName = interviewerName;
        if (interviewerDesignation) application.interview.interviewerDesignation = interviewerDesignation;
        application.interview.linkHistory.push({ link: meetingLink, changedAt: new Date(), changedBy: actorId });

        await application.save();
        await notificationEmitter.emitMeetingLinkChanged(application);
        return application.toObject();
    }

    // confirmed -> interviewed -> {offered|rejected}, one atomic call. See
    // the build spec §03's resolved ambiguity on why `interviewed` is
    // transient here rather than its own separate recruiter action.
    async recordOutcome(applicationId, requester, { result, reason, reasonText }) {
        const application = await jobApplicationService._loadOwnedApplication(applicationId, requester);
        if (application.status !== 'confirmed') {
            throw new UnprocessableEntityError(`Cannot record an outcome from status ${application.status}`);
        }

        const actorId = actorIdOf(requester);
        application.pushHistory('interviewed', actorId);
        application.interview.outcome = { result, recordedAt: new Date(), recordedBy: actorId };

        if (result === 'offer') {
            application.status = 'offered';
            application.pushHistory('offered', actorId);
        } else {
            application.status = 'rejected';
            application.rejectionReason = reason;
            application.rejectionReasonText = reasonText || null;
            application.pushHistory('rejected', actorId, reason);
        }

        await application.save();

        if (result === 'offer') {
            await notificationEmitter.emitJobOfferExtended(application);
        } else {
            await notificationEmitter.emitApplicationRejected(application, reason, reasonText);
        }

        return application.toObject();
    }

    // Recruiter marks the candidate absent. reoffer:true performs the same
    // mechanics as rescheduleInterview (no penalty); reoffer:false rejects
    // with the no-show reason and runs the penalty pipeline.
    async markNoShow(applicationId, requester, { reoffer, newSlots, durationMinutes, reasonText }) {
        const application = await jobApplicationService._loadOwnedApplication(applicationId, requester);
        if (application.status !== 'confirmed') {
            throw new UnprocessableEntityError(`Cannot mark a no-show from status ${application.status}`);
        }

        await this._assertNoShowGraceElapsed(application.interview.confirmedSlot?.start);

        if (reoffer) {
            return this.rescheduleInterview(
                applicationId, requester, { slots: newSlots, durationMinutes },
                'rescheduling', reasonText || 'Re-offered after a missed interview'
            );
        }

        const actorId = actorIdOf(requester);
        application.interview.noShow = {
            by: 'candidate', markedBy: actorId, markedAt: new Date(), disputeStatus: 'none'
        };
        application.interview.outcome = { result: 'no_show', recordedAt: new Date(), recordedBy: actorId };
        application.pushHistory('interviewed', actorId, 'Candidate no-show');
        application.status = 'rejected';
        application.rejectionReason = 'did_not_attend_interview';
        application.rejectionReasonText = reasonText || null;
        application.pushHistory('rejected', actorId, 'did_not_attend_interview');

        await application.save();
        await notificationEmitter.emitMarkedNoShow(application);
        return application.toObject();
    }

    // Candidate marks the hospital absent. Zero candidate-side effect —
    // flags the hospital and is visible to operations only.
    async reportNoShow(applicationId, userId) {
        const application = await jobApplicationService._loadOwnApplicantApplication(applicationId, userId);
        if (application.status !== 'confirmed') {
            throw new UnprocessableEntityError(`Cannot report a no-show from status ${application.status}`);
        }

        await this._assertNoShowGraceElapsed(application.interview.confirmedSlot?.start);

        application.interview.noShow = {
            by: 'hospital', markedBy: userId, markedAt: new Date(), disputeStatus: 'none'
        };
        application.status = 'shortlisted';
        application.interview.confirmedSlot = undefined;
        application.pushHistory('shortlisted', userId, 'Hospital did not join the interview');

        await application.save();
        await notificationEmitter.emitHospitalNoShowReported(application);
        return application.toObject();
    }

    async disputeNoShow(applicationId, userId, reason) {
        const application = await jobApplicationService._loadOwnApplicantApplication(applicationId, userId);
        const noShow = application.interview.noShow;
        if (!noShow?.markedAt || noShow.by !== 'candidate') {
            throw new UnprocessableEntityError('There is no no-show marked against you on this application.');
        }
        if (noShow.disputeStatus !== 'none') {
            throw new ConflictError(`This no-show has already been ${noShow.disputeStatus === 'open' ? 'disputed' : noShow.disputeStatus}.`);
        }

        const windowDays = await systemConfigService.getEffective('interview.disputeWindowDays');
        const deadline = new Date(noShow.markedAt.getTime() + windowDays * 24 * 60 * 60 * 1000);
        if (new Date() > deadline) {
            throw new UnprocessableEntityError(`The ${windowDays}-day dispute window for this no-show has passed.`);
        }

        application.interview.noShow.disputeStatus = 'open';
        application.interview.noShow.disputeReason = reason;
        application.interview.noShow.disputedAt = new Date();

        await application.save();
        return application.toObject();
    }

    // offered -> hired (accept) | withdrawn (decline)
    async respondToOffer(applicationId, userId, accept) {
        const application = await jobApplicationService._loadOwnApplicantApplication(applicationId, userId);
        if (application.status !== 'offered') {
            throw new UnprocessableEntityError(`Cannot respond to a job offer from status ${application.status}`);
        }

        if (accept) {
            application.status = 'hired';
            application.contactRelease = { releasedAt: new Date(), releasedTo: application.hospitalId };
            application.pushHistory('hired', userId);
            await application.save();
            await notificationEmitter.emitApplicationHired(application);
            await notificationEmitter.emitContactDetailsReleased(application);
        } else {
            application.status = 'withdrawn';
            application.withdrawnAt = new Date();
            application.withdrawReason = 'no_longer_interested';
            application.pushHistory('withdrawn', userId, 'Declined job offer');
            await application.save();
            await notificationEmitter.emitApplicationWithdrawn(application);
        }

        return application.toObject();
    }

    // Operations resolves a dispute opened via disputeNoShow(). 'uphold'
    // re-activates the held penalty (disputeStatus leaves 'open', so the
    // live trailing-window queries in noShowPenalty.service.js count it
    // again); 'void' clears the mark entirely going forward. Neither
    // rewrites application.status — status is already past that point by
    // the time a dispute is resolved.
    async resolveNoShowDispute(applicationId, adminUserId, decision) {
        const application = await JobApplication.findById(applicationId);
        if (!application) {
            throw new NotFoundError('Application not found');
        }
        if (application.interview.noShow?.disputeStatus !== 'open') {
            throw new ConflictError('This application has no open no-show dispute.');
        }

        application.interview.noShow.disputeStatus = decision === 'uphold' ? 'upheld' : 'voided';
        application.interview.noShow.resolvedAt = new Date();
        application.interview.noShow.resolvedBy = adminUserId;
        await application.save();
        return application.toObject();
    }

    // ─── Shared validation / helpers ────────────────────────────────────────

    async _validateSlotWindow(slots, durationMinutes) {
        if (!Array.isArray(slots) || slots.length === 0) {
            throw new UnprocessableEntityError('At least one slot is required.');
        }

        const [min, max, minHours, maxDays] = await Promise.all([
            systemConfigService.getEffective('interview.slotsPerOfferMin'),
            systemConfigService.getEffective('interview.slotsPerOfferMax'),
            systemConfigService.getEffective('interview.schedulingWindowMinHours'),
            systemConfigService.getEffective('interview.schedulingWindowMaxDays')
        ]);

        if (slots.length < min) {
            throw new UnprocessableEntityError(`At least ${min} slots are required so the candidate has real choice.`);
        }
        if (slots.length > max) {
            throw new UnprocessableEntityError(`No more than ${max} slots are allowed.`);
        }

        const now = Date.now();
        const minMs = now + minHours * 60 * 60 * 1000;
        const maxMs = now + maxDays * 24 * 60 * 60 * 1000;
        const granularityMs = SLOT_GRANULARITY_MINUTES * 60 * 1000;

        for (const slot of slots) {
            const start = toDate(slot.start).getTime();
            const end = toDate(slot.end).getTime();

            // Epoch-aligned 15-minute check is timezone-safe here specifically
            // because IST's UTC offset (+5:30 = 330 minutes) is itself an
            // exact multiple of 15 minutes — any UTC instant on a 15-minute
            // boundary is also on one in IST.
            if (start % granularityMs !== 0) {
                throw new UnprocessableEntityError('Every slot must start on a 15-minute boundary (:00, :15, :30, :45 IST).');
            }
            if (start < minMs || start > maxMs) {
                throw new UnprocessableEntityError(`Every slot must start between ${minHours} hours and ${maxDays} days from now.`);
            }
            if (end - start !== durationMinutes * 60 * 1000) {
                throw new UnprocessableEntityError('Every slot must match the offer duration.');
            }
        }
    }

    // = min(offeredAt + offerExpiryDays, the LATEST offered slot's start) —
    // the "collapsed window" behaviour: an offer for slots next week doesn't
    // live the full offerExpiryDays, it dies when the last slot begins.
    async _buildOfferWindow(slots) {
        const normalizedSlots = slots.map(s => ({ start: toDate(s.start), end: toDate(s.end) }));
        const offeredAt = new Date();
        const lastSlotStart = new Date(Math.max(...normalizedSlots.map(s => s.start.getTime())));
        const offerExpiryDays = await systemConfigService.getEffective('interview.offerExpiryDays');
        const maxExpiry = new Date(offeredAt.getTime() + offerExpiryDays * 24 * 60 * 60 * 1000);
        const expiresAt = lastSlotStart < maxExpiry ? lastSlotStart : maxExpiry;
        return { normalizedSlots, offeredAt, expiresAt };
    }

    async _assertNoShowGraceElapsed(slotStart) {
        if (!slotStart) {
            throw new UnprocessableEntityError('This application has no confirmed interview slot.');
        }
        const graceMin = await systemConfigService.getEffective('interview.noShowGraceMin');
        const deadline = new Date(toDate(slotStart).getTime() + graceMin * 60 * 1000);
        if (new Date() < deadline) {
            throw new UnprocessableEntityError(`No-show cannot be marked until ${graceMin} minutes past the interview start time.`);
        }
    }

    async _computeIsLateChange(referenceSlotStart) {
        if (!referenceSlotStart) return false;
        const thresholdHours = await systemConfigService.getEffective('interview.lateChangeThresholdHours');
        const thresholdMs = thresholdHours * 60 * 60 * 1000;
        return (toDate(referenceSlotStart).getTime() - Date.now()) < thresholdMs;
    }
}

module.exports = new InterviewSchedulingService();
