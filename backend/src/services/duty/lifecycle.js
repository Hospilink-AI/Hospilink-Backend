// Duties: creating, accepting, editing, status changes, admin assignment
// Methods of DutyService; mixed into the class in ../duty.service.js, so `this` is the service.
const Duty = require('../../models/Duty');
const Hospital = require('../../models/Hospital');
const MedicalStaff = require('../../models/MedicalStaff');
const mongoose = require('mongoose');
const {
    doDutiesOverlap,
    toIST,
    getCurrentIST,
    normalizeRole
} = require('../../utils/helpers');
const notificationEmitter = require('../notificationEmitter');
const dutyOfferService = require('../dutyOffer.service');
const systemConfigService = require('../systemConfig.service');
const { priceRuleError } = require('../../utils/dutyPricing');
const {
    ValidationError,
    NotFoundError,
    ConflictError,
    ForbiddenError,
    UnprocessableEntityError
} = require('../../middleware/error.middleware');
const { acquireDutyLock, releaseDutyLock } = require('./helpers');

module.exports = {
    async createDuty(dutyData, userId) {
        // Find the hospital profile for this user
        const hospital = await Hospital.findOne({ user: userId });
        if (!hospital) {
            throw new NotFoundError('Hospital profile not found. Please complete your profile first.');
        }

        // Additional server-side validation (double-check)
        const now = getCurrentIST();
        const dutyDate = new Date(dutyData.date);
        const [startHours, startMinutes] = dutyData.startTime.split(':');

        // Convert duty date to IST and set time
        const istDutyDate = toIST(dutyDate);
        const dutyStartTime = new Date(istDutyDate);
        dutyStartTime.setHours(parseInt(startHours), parseInt(startMinutes), 0, 0);

        // Add 15 minute buffer
        const bufferTime = new Date(dutyStartTime.getTime() - 15 * 60 * 1000);

        if (bufferTime <= now) {
            throw new ValidationError('Duty start time must be at least 15 minutes in the future. Cannot create duties for past or immediate times.');
        }

        // "Feature default on new duties" (spec §09) — admin-editable via
        // systemConfig; an explicit value on dutyData (once the frontend
        // opt-out checkbox exists) always wins over the default.
        const featureDefaultEnabled = await systemConfigService.getEffective('autoRelist.featureDefaultEnabled');
        const autoRelistEnabled = dutyData.autoRelist?.enabled ?? featureDefaultEnabled;

        const duty = await Duty.create({
            ...dutyData,
            hospital: hospital._id,
            ...(hospital.isDemo && { isDemo: true }),
            autoRelist: { enabled: autoRelistEnabled },
            statusHistory: [{
                status: 'available',
                timestamp: getCurrentIST(),
                changedBy: userId,
                reason: 'Duty created by hospital'
            }]
        });

        // Populate the created duty
        await duty.populate('hospital');

        return {
            success: true,
            duty
        };
    },

    async acceptDuty(dutyId, userId) {
        // ── Per-staff idempotency lock ────────────────────────────────────────
        // Prevents the same staff member from firing duplicate requests
        // (e.g. double-tap, network retry) within the lock window.
        const staffLockAcquired = await acquireDutyLock(dutyId, userId.toString());
        if (!staffLockAcquired) {
            throw new ConflictError('Your acceptance request is already being processed. Please wait.');
        }

        // Use a MongoDB session for the overlap check + atomic claim so both
        // operations are isolated from concurrent writes to the same staff member.
        const session = await mongoose.startSession();

        try {
            let claimedDuty;

            await session.withTransaction(async () => {

                // ── 1. Load staff profile ─────────────────────────────────────
                const medicalStaff = await MedicalStaff.findOne({ user: userId }).session(session);
                if (!medicalStaff) {
                    throw new NotFoundError('Medical staff profile not found. Please complete your profile first.');
                }

                // ── 2. Load duty for validation ───────────────────────────────
                const duty = await Duty.findById(dutyId)
                    .populate({ path: 'hospital', populate: { path: 'user', select: 'name email' } })
                    .session(session);

                if (!duty) {
                    throw new NotFoundError('Duty not found');
                }

                // ── 3. Role check ─────────────────────────────────────────────
                const normalizedStaffRole = normalizeRole(medicalStaff.jobRole);
                const normalizedDutyRole = normalizeRole(duty.staffRole);

                if (normalizedStaffRole !== normalizedDutyRole) {
                    throw new ForbiddenError(`Role mismatch: This duty requires a ${duty.staffRole}, but your profile shows ${medicalStaff.jobRole}`);
                }

                // ── 3b. Auto-relist exclusion check ───────────────────────────
                // A staff member who cancelled this duty earlier can never
                // reclaim it, even by hitting this endpoint directly with the
                // duty ID (bypassing the browse-list/detail-fetch guards).
                const isExcludedFromRelist = (duty.autoRelist?.excludedStaff || [])
                    .some(id => id.toString() === medicalStaff._id.toString());
                if (isExcludedFromRelist) {
                    throw new ForbiddenError('You previously cancelled this duty and cannot re-accept it.');
                }

                // ── 3c. Staged offer check ────────────────────────────────────
                // A staged duty can only be accepted once it has been offered
                // to this doctor (in range of its current ring, in the city for
                // emergencies, or notified about it).
                if (!(await dutyOfferService.isEligible(duty, medicalStaff))) {
                    throw new ForbiddenError('This duty has not been offered to you yet.');
                }

                // ── 4. Status check ───────────────────────────────────────────
                if (duty.status !== 'available') {
                    throw new ConflictError('Duty is no longer available');
                }

                // ── 5. Start time check ───────────────────────────────────────
                const now = getCurrentIST();
                const istDutyDate = toIST(new Date(duty.date));
                const [startHours, startMinutes] = duty.startTime.split(':');
                const dutyStartTime = new Date(istDutyDate);
                dutyStartTime.setHours(parseInt(startHours), parseInt(startMinutes), 0, 0);

                if (now >= dutyStartTime) {
                    throw new UnprocessableEntityError('Cannot accept duty after start time.');
                }

                // ── 6. Overlap check (inside transaction = consistent read) ───
                // Reading within the same session ensures we see any duties
                // committed by concurrent transactions before this one started.
                const existingDuties = await Duty.find({
                    assignedTo: medicalStaff._id,
                    status: 'assigned',
                    $or: [
                        { date: duty.date },
                        ...(duty.isOvernightDuty && duty.endDate ? [{ date: duty.endDate }] : [])
                    ]
                }).session(session);

                for (const existingDuty of existingDuties) {
                    if (doDutiesOverlap(duty, existingDuty)) {
                        throw new ConflictError(
                            `Time conflict: You already have a duty from ${existingDuty.startTime} to ${existingDuty.endTime}. ` +
                            `New duty from ${duty.startTime} to ${duty.endTime} overlaps.`
                        );
                    }
                }

                
                // findOneAndUpdate with status:'available' as the guard.
                // Inside a transaction this is both atomic AND isolated —
                // concurrent transactions trying the same duty will block
                // until this one commits, then find status='assigned' and abort.
                const assignedAt = getCurrentIST();
                claimedDuty = await Duty.findOneAndUpdate(
                    { _id: dutyId, status: 'available', 'autoRelist.excludedStaff': { $ne: medicalStaff._id } },
                    {
                        $set: {
                            status: 'assigned',
                            assignedTo: medicalStaff._id,
                            assignedAt
                        },
                        $push: {
                            statusHistory: {
                                status: 'assigned',
                                timestamp: assignedAt,
                                changedBy: medicalStaff.user,
                                reason: 'Duty accepted by staff'
                            }
                        }
                    },
                    { new: true, runValidators: true, session }
                ).populate({ path: 'hospital', populate: { path: 'user', select: 'name email' } });

                if (!claimedDuty) {
                    throw new ConflictError('Duty is no longer available');
                }

            }); // transaction auto-commits or auto-aborts

            // Populate assignedTo outside transaction (read-only, no isolation needed)
            await claimedDuty.populate({
                path: 'assignedTo',
                populate: { path: 'user', select: 'name email' }
            });

            // Backfill the pair-watchlist data point (spec §07): whoever
            // just accepted this relisted duty, on its most recent relist
            // history entry. Read assignedTo._id, not assignedTo directly —
            // it's populated by now, so the bare field is a MedicalStaff
            // document, not the ObjectId this needs. Best-effort: a failure
            // here must never fail the accept itself.
            if (claimedDuty.autoRelist?.history?.length > 0) {
                const lastIndex = claimedDuty.autoRelist.history.length - 1;
                Duty.updateOne(
                    { _id: dutyId },
                    { $set: { [`autoRelist.history.${lastIndex}.acceptedBy`]: claimedDuty.assignedTo._id } }
                ).catch(err => console.error('Failed to backfill autoRelist history acceptedBy:', err));
            }

            return claimedDuty;

        } finally {
            session.endSession();
            // Always release the per-staff lock regardless of outcome
            await releaseDutyLock(dutyId, userId.toString());
        }
    },

    async changeDutyStatus(dutyId, userId, newStatus) {
        // Find the medical staff profile for this user
        const medicalStaff = await MedicalStaff.findOne({ user: userId });
        if (!medicalStaff) {
            throw new NotFoundError('Medical staff profile not found. Please complete your profile first.');
        }

        const duty = await Duty.findById(dutyId)
            .populate({
                path: 'hospital',
                populate: {
                    path: 'user',
                    select: 'name email'
                }
            });

        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        // Validate staff assignment
        const validation = duty.canChangeStatus(newStatus, medicalStaff._id);
        if (!validation.allowed) {
            if (validation.reason.includes('assigned to you')) {
                throw new ForbiddenError(validation.reason);
            }
            throw new ValidationError(validation.reason);
        }

        // Additional timing validations
        if (newStatus === 'enroute') {
            if (duty.status !== 'assigned') {
                throw new ValidationError('Duty must be assigned before marking enroute');
            }
            duty.enrouteAt = getCurrentIST();
        }

        // Update status and add to history
        const previousStatus = duty.status;
        duty.status = newStatus;

        duty.statusHistory.push({
            status: newStatus,
            timestamp: getCurrentIST(),
            changedBy: medicalStaff._id,
            reason: `Status changed from ${previousStatus} to ${newStatus}`
        });

        await duty.save();

        // Populate staff information for response
        await duty.populate({
            path: 'assignedTo',
            populate: {
                path: 'user',
                select: 'name email'
            }
        });

        return duty;
    },

    // asAdmin: admin editing on the hospital's behalf, skips the ownership check
    async editDuty(dutyId, userId, updateData, { asAdmin = false } = {}) {
        // Find the hospital profile for this user
        let hospital;
        if (!asAdmin) {
            hospital = await Hospital.findOne({ user: userId });
            if (!hospital) {
                throw new NotFoundError('Hospital profile not found. Please complete your profile first.');
            }
        }

        const duty = await Duty.findById(dutyId);
        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        // Verify this duty belongs to the requesting hospital
        if (!asAdmin && duty.hospital.toString() !== hospital._id.toString()) {
            throw new ForbiddenError('You can only edit your own duties');
        }

        const isEmergencyOrCritical = duty.urgency === 'emergency';
        const isPricingOnlyUpdate = updateData.offeredRate !== undefined &&
            Object.keys(updateData).every(k => k === 'offeredRate');

        // For emergency duties: allow pricing-only edit until 1 min before start
        if (isEmergencyOrCritical && isPricingOnlyUpdate) {
            const pricingValidation = duty.canEditPricing();
            if (!pricingValidation.allowed) {
                throw new ValidationError(pricingValidation.reason);
            }
            this._checkPriceRules(duty, { offeredRate: updateData.offeredRate });
            duty.offeredRate = updateData.offeredRate;
            await duty.save();
            await duty.populate({ path: 'hospital', populate: { path: 'user', select: 'name email' } });
            return duty;
        }

        // Standard edit: check 30-minute rule
        const editValidation = duty.canEditDuty();
        if (!editValidation.allowed) {
            // For emergency duties that are still available, suggest pricing-only edit
            if (isEmergencyOrCritical && duty.status === 'available') {
                throw new ValidationError('Emergency duties can only have their pricing edited within 30 minutes of start time. Use offeredRate only.');
            }
            throw new ValidationError(editValidation.reason);
        }

        // Validate and update allowed fields
        const allowedFields = [
            'staffRole', 'date', 'endDate', 'startTime', 'endTime',
            'urgency', 'description', 'offeredRate', 'isOvernightDuty', 'dutySubType'
        ];

        const updates = {};
        for (const field of allowedFields) {
            if (updateData[field] !== undefined) {
                updates[field] = updateData[field];
            }
        }

        // RMO sub-type: required for rmo, not allowed for other roles (same as creation)
        const effectiveRole = updates.staffRole || duty.staffRole;
        if (effectiveRole === 'rmo') {
            if (!updates.dutySubType && !duty.dutySubType) {
                throw new ValidationError('Sub-type is required for RMO duties');
            }
        } else if (updates.dutySubType) {
            throw new ValidationError('Sub-type is only allowed for RMO duties');
        } else if (duty.dutySubType) {
            updates.dutySubType = undefined;
        }

        // Validate the new start time is at least 15 minutes in the future.
        // Use the incoming date if provided, otherwise fall back to the existing duty's date.
        if (updates.startTime) {
            const now = getCurrentIST();
            const refDate = new Date(updates.date || duty.date);
            const [startHours, startMinutes] = updates.startTime.split(':');
            const istRefDate = toIST(refDate);
            const newStartTime = new Date(istRefDate);
            newStartTime.setHours(parseInt(startHours), parseInt(startMinutes), 0, 0);
            const bufferTime = new Date(newStartTime.getTime() - 15 * 60 * 1000);
            if (bufferTime <= now) {
                throw new ValidationError('New start time must be at least 15 minutes in the future');
            }
        }

        this._checkPriceRules(duty, updates);

        // Apply updates
        Object.assign(duty, updates);
        await duty.save();

        // Populate the updated duty
        await duty.populate({
            path: 'hospital',
            populate: {
                path: 'user',
                select: 'name email'
            }
        });

        return duty;
    },

    // Price rules on an edit that changes the rate or the times. Edits that leave
    // them alone don't fail on duties posted before the rules existed.
    _checkPriceRules(duty, updates) {
        const priceFields = ['offeredRate', 'date', 'endDate', 'startTime', 'endTime', 'isOvernightDuty'];
        if (!priceFields.some(field => updates[field] !== undefined)) return;

        const merged = {};
        for (const field of priceFields) {
            merged[field] = updates[field] !== undefined ? updates[field] : duty[field];
        }
        merged.category = duty.category;

        const error = priceRuleError(merged);
        if (error) {
            throw new ValidationError(error);
        }
    },

    // "stays editable while the duty is available or assigned...
    // turning it off later does not undo a rise already applied" — a status
    // check, not the 30-minute canEditDuty() time-window used for regular
    // field edits, so this is deliberately its own method rather than routed
    // through editDuty().
    async setAutoRelistEnabled(dutyId, userId, enabled) {
        const hospital = await Hospital.findOne({ user: userId });
        if (!hospital) {
            throw new NotFoundError('Hospital profile not found. Please complete your profile first.');
        }

        const duty = await Duty.findById(dutyId);
        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        if (duty.hospital.toString() !== hospital._id.toString()) {
            throw new ForbiddenError('You can only edit your own duties');
        }

        if (!['available', 'assigned'].includes(duty.status)) {
            throw new ValidationError('Auto-relist can only be changed while the duty is available or assigned');
        }

        duty.autoRelist = duty.autoRelist || {};
        duty.autoRelist.enabled = enabled;
        await duty.save();

        return duty;
    },

    async assignDutyByAdmin({ hospitalId, dutyId, staffId, adminId }) {

        // 1. Hospital validation
        const hospital = await Hospital.findById(hospitalId);
        if (!hospital) {
            throw new NotFoundError('Hospital not found');
        }

        // 2. Duty validation
        const duty = await Duty.findById(dutyId);
        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        // 3. Check duty belongs to hospital
        if (duty.hospital.toString() !== hospitalId) {
            throw new UnprocessableEntityError('Duty does not belong to this hospital');
        }

        // 4. Only one staff can take duty
        if (duty.status !== 'available') {
            throw new ConflictError('Duty is already assigned or not available');
        }

        // 5. Staff validation
        const staff = await MedicalStaff.findById(staffId);
        if (!staff) {
            throw new NotFoundError('Medical staff not found');
        }

        // 6. Role match
        const normalizedStaffRole = normalizeRole(staff.jobRole);
        const normalizedDutyRole = normalizeRole(duty.staffRole);

        if (normalizedStaffRole !== normalizedDutyRole) {
            throw new UnprocessableEntityError(`Role mismatch: duty requires ${duty.staffRole}`);
        }

        // 7. Time validation (same as hospital)
        const now = getCurrentIST();
        const dutyDate = new Date(duty.date);
        const [startHours, startMinutes] = duty.startTime.split(':');

        const istDutyDate = toIST(dutyDate);
        const dutyStartTime = new Date(istDutyDate);
        dutyStartTime.setHours(parseInt(startHours), parseInt(startMinutes), 0, 0);

        if (now >= dutyStartTime) {
            throw new UnprocessableEntityError('Cannot assign duty after start time');
        }

        // 8. Overlap check 
        const existingDuties = await Duty.find({
            assignedTo: staff._id,
            status: 'assigned',
            $or: [
                { date: duty.date },
                ...(duty.isOvernightDuty && duty.endDate ? [{ date: duty.endDate }] : [])
            ]
        });

        for (const existing of existingDuties) {
            if (doDutiesOverlap(duty, existing)) {
                throw new ConflictError('Staff already has overlapping duty');
            }
        }

        // 9. Assign duty
        duty.status = 'assigned';
        duty.assignedTo = staff._id;
        duty.assignedAt = getCurrentIST();

        duty.statusHistory.push({
            status: 'assigned',
            timestamp: getCurrentIST(),
            changedBy: adminId,
            reason: 'Assigned by admin'
        });

        await duty.save();

        await duty.populate({
            path: 'assignedTo',
            populate: {
                path: 'user',
                select: 'name email'
            }
        });

        // Tell the doctor and the hospital; neither made this booking themselves
        const hospitalDoc = await Hospital.findById(duty.hospital).select('user hospitalLegalName').lean();
        const shift = notificationEmitter.describeShift(duty);
        const staffName = duty.assignedTo?.fullName || duty.assignedTo?.user?.name || 'A doctor';
        await notificationEmitter.emitDutyNotice('DUTY_ASSIGNED_BY_ADMIN', duty, [duty.assignedTo?.user?._id],
            `HospiLink assigned you to a ${shift} at ${hospitalDoc?.hospitalLegalName || 'a hospital'}.`);
        await notificationEmitter.emitDutyNotice('DUTY_ASSIGNED_BY_ADMIN', duty, [hospitalDoc?.user],
            `HospiLink assigned ${staffName} to your ${shift}.`, { staff: { id: duty.assignedTo?._id, name: staffName } });

        return duty;
    }
};
