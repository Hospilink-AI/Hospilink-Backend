const Ticket = require('../models/Ticket');
const Duty = require('../models/Duty');
const JobApplication = require('../models/JobApplication');
const MedicalStaff = require('../models/MedicalStaff');
const { hasCapability } = require('../config/adminPermissions.config');
const { NotFoundError, ForbiddenError, ConflictError, UnprocessableEntityError } = require('../middleware/error.middleware');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const {
    REGIME_BY_DOMAIN, REGIME_SLA, ACTIVE_STATUSES, VALID_OUTCOMES_BY_CLASS,
    TERMINAL_STATUS_BY_OUTCOME, DEFAULT_TERMINAL_STATUS, APPEAL_OUTCOMES,
    PRIORITY_SLA, DATA_DOMAIN_SLA, DUTY_URGENCY_THRESHOLDS,
    CLAIM_TIMEOUT_MINUTES_BY_PRIORITY
} = require('../utils/ticket.constants');
const notificationEmitter = require('./notificationEmitter');
const activityLogEmitter = require('./activityLogEmitter');
const { ACTIVITY_ACTIONS } = require('../utils/activityLog.constants');
const systemConfigService = require('./systemConfig.service');
const ticketCategoryConfigService = require('./ticketCategoryConfig.service');
const ticketConsequenceService = require('./ticketConsequence.service');
const patternEngineService = require('./patternEngine.service');
const s3Service = require('./s3.service');
const { v4: uuidv4 } = require('uuid');

// Admin floor ladder for queue access (spec §07.02: "the route is a floor,
// not a ceiling" — a higher floor sees everything at or below it).
// GRIEVANCE_OFFICER and FEEDBACK_BOARD aren't on this ladder — the former is
// Super Admin-only, the latter isn't a worked queue at all this phase.
const QUEUE_FLOOR = { SUPPORT: 1, OPERATIONS: 2, SUPER_ADMIN: 3 };
const SUB_ROLE_FLOOR = { tech_support: 1, operations_manager: 2, super_admin: 3 };

// Phase 1 built creation/list-mine/role-shaped detail. Phase 2 adds the
// admin work queue (list/claim/reassign/recategorize/priority-override) and
// raiser withdraw. Still no respondent flow, decision/approval, or
// consequence engine — those need the SLA-pause machinery and land next.
class TicketService {
    // Best-effort context snapshot at creation time (spec §04 linkedContext,
    // §06.06 "context is fetched, never asked for"). Deliberately narrow
    // this phase — just enough for an admin to orient on the case file
    // later; richer per-category snapshots are a chatbot-phase refinement.
    async _resolveLinkedContext(subjectType, subjectId) {
        if (!subjectType || subjectType === 'NONE' || !subjectId) return {};

        try {
            if (subjectType === 'DUTY') {
                const duty = await Duty.findById(subjectId)
                    .select('hospital assignedTo status date startTime endTime staffRole statusHistory')
                    .lean();
                return duty ? { duty } : {};
            }
            if (subjectType === 'APPLICATION' || subjectType === 'INTERVIEW') {
                const application = await JobApplication.findById(subjectId)
                    .select('vacancy hospitalId staff status interview.confirmedSlot interview.noShow')
                    .lean();
                return application ? { application } : {};
            }
            // PAYMENT resolves to the same Duty document (Duty.paymentMethod
            // / totalPayment) — no separate Payment collection.
            if (subjectType === 'PAYMENT') {
                const duty = await Duty.findById(subjectId)
                    .select('paymentMethod isPaid totalPayment offeredRate')
                    .lean();
                return duty ? { payment: duty } : {};
            }
        } catch (err) {
            // Context is a convenience, not a correctness requirement —
            // never block ticket creation over a bad/stale subjectId.
            return {};
        }
        return {};
    }

    // Priority-derived operational targets (slaFirstReplyBy/slaDecideBy) plus
    // the unchanged domain-regime backstop (slaCeilingBy). data.* categories
    // get their operational targets from DATA_DOMAIN_SLA instead of the
    // priority table, even though they still carry a P4 priority value for
    // queue sorting.
    _computeSla(domain, priority) {
        const regimeName = REGIME_BY_DOMAIN[domain];
        const regime = REGIME_SLA[regimeName];
        const now = new Date();

        const operational = domain === 'data'
            ? { firstReplyMs: DATA_DOMAIN_SLA.firstReplyHours * 60 * 60 * 1000, decideMs: DATA_DOMAIN_SLA.decideDays * 24 * 60 * 60 * 1000 }
            : { firstReplyMs: PRIORITY_SLA[priority].firstReplyMinutes * 60 * 1000, decideMs: PRIORITY_SLA[priority].decideHours * 60 * 60 * 1000 };

        return {
            slaAcknowledgeBy: new Date(now.getTime() + regime.ackHours * 60 * 60 * 1000),
            slaFirstReplyBy: new Date(now.getTime() + operational.firstReplyMs),
            slaDecideBy: new Date(now.getTime() + operational.decideMs),
            slaCeilingBy: new Date(now.getTime() + regime.decideDays * 24 * 60 * 60 * 1000)
        };
    }

    // Three-way duty-urgency tier shared by the P1/P2 priority waterfall
    // here and Day 2's respondent-window tiers — same 4h/24h boundaries
    // (spec update), replacing the old single 12h-threshold check.
    async _dutyUrgencyTier(duty) {
        if (!duty || !duty.date || !duty.startTime || !duty.endTime) return 'NORMAL';

        const [startH, startM] = duty.startTime.split(':').map(Number);
        const [endH, endM] = duty.endTime.split(':').map(Number);

        const dutyStart = new Date(duty.date);
        dutyStart.setHours(startH, startM, 0, 0);
        const dutyEnd = new Date(duty.date);
        dutyEnd.setHours(endH, endM, 0, 0);
        if (dutyEnd <= dutyStart) dutyEnd.setDate(dutyEnd.getDate() + 1); // overnight duty

        const now = new Date();
        const { liveOrImminentHours, withinADayHours } = DUTY_URGENCY_THRESHOLDS;
        const liveOrImminentFrom = new Date(dutyStart.getTime() - liveOrImminentHours * 60 * 60 * 1000);
        const withinADayFrom = new Date(dutyStart.getTime() - withinADayHours * 60 * 60 * 1000);

        if (now >= liveOrImminentFrom && now <= dutyEnd) return 'LIVE_OR_IMMINENT';
        if (now >= withinADayFrom && now < liveOrImminentFrom) return 'WITHIN_A_DAY';
        return 'NORMAL';
    }

    // True if `now` falls between (dutyStart − imminentDutyThresholdHours)
    // and dutyEnd — spec §16: "2h where the duty is live or within 12h".
    // Thin wrapper over _dutyUrgencyTier so existing callers (the respondent-
    // deadline computation) don't need to change this pass.
    async _isImminentOrLiveDuty(duty) {
        return (await this._dutyUrgencyTier(duty)) === 'LIVE_OR_IMMINENT';
    }

    // account.access_locked is only P1 when it locks someone out mid-duty —
    // needs the MedicalStaff profile id, not the User id (Duty.assignedTo
    // refs MedicalStaff), mirroring patternEngine.service's own resolution.
    async _hasActiveDuty(userId) {
        const staff = await MedicalStaff.findOne({ user: userId }).select('_id').lean();
        if (!staff) return false;
        const duty = await Duty.findOne({
            assignedTo: staff._id,
            status: { $in: ['assigned', 'enroute', 'in-progress'] }
        }).select('_id').lean();
        return !!duty;
    }

    // Priority waterfall (spec update §03) — first match wins.
    // P1: safety domain · live/imminent duty · blocked-from-start/end-shift
    //     categories · locked out mid-duty.
    // P2: duty within a day · payment domain · verification stalls ·
    //     interview within 24h.
    // P3: fallback for any ADJUDICATED ticket not already caught above.
    // P4: everything else (data.* included — its SLA targets come from
    //     DATA_DOMAIN_SLA regardless of landing here).
    async _computePriority({ domain, category, subjectType, resolutionClass, linkedContext, raisedBy }) {
        const duty = linkedContext?.duty;
        const urgencyTier = await this._dutyUrgencyTier(duty);

        if (
            domain === 'safety' ||
            urgencyTier === 'LIVE_OR_IMMINENT' ||
            ['duty.start_otp_failure', 'duty.end_otp_unverified'].includes(category) ||
            (category === 'account.access_locked' && await this._hasActiveDuty(raisedBy.user))
        ) {
            return 'P1';
        }

        const confirmedSlotStart = linkedContext?.application?.interview?.confirmedSlot?.start;
        const interviewWithin24h = subjectType === 'INTERVIEW' && confirmedSlotStart &&
            new Date(confirmedSlotStart).getTime() - Date.now() <= 24 * 60 * 60 * 1000;

        if (
            urgencyTier === 'WITHIN_A_DAY' ||
            domain === 'payment' ||
            ['account.verification_delay', 'account.verification_rejected'].includes(category) ||
            interviewWithin24h
        ) {
            return 'P2';
        }

        if (resolutionClass === 'ADJUDICATED') return 'P3';

        return 'P4';
    }

    // spec update: 3-tier window — 24h normally, 4h if the linked duty
    // starts within a day, 60min if it's live or within 4h. Tier comes from
    // the same _dutyUrgencyTier boundaries the priority waterfall uses.
    async _computeRespondentDeadline(subjectType, linkedContext) {
        const duty = subjectType === 'DUTY' ? linkedContext.duty : null;
        const [tier, normalHours, withinADayHours, liveHours] = await Promise.all([
            this._dutyUrgencyTier(duty),
            systemConfigService.getEffective('ticket.respondentWindowNormalHours'),
            systemConfigService.getEffective('ticket.respondentWindowWithinADayHours'),
            systemConfigService.getEffective('ticket.respondentWindowLiveHours')
        ]);

        const hours = { NORMAL: normalHours, WITHIN_A_DAY: withinADayHours, LIVE_OR_IMMINENT: liveHours }[tier];
        const now = new Date();
        return { respondentNotifiedAt: now, respondentDeadline: new Date(now.getTime() + hours * 60 * 60 * 1000) };
    }

    async createTicket(user, { category, subjectType, subjectId, raisedAgainst, text, source = 'IN_APP_FORM', botCategory, botConfidence }) {
        const userId = user._id || user.id;
        const userRole = user.role;
        const domain = category.split('.')[0];
        const linkedContext = await this._resolveLinkedContext(subjectType, subjectId);

        // Looked up ahead of construction (not left to Ticket.js's own
        // pre-validate hook) specifically so respondentNotifiedAt/Deadline
        // can be set on the same initial write for ADJUDICATED tickets,
        // rather than a second update right after — the hook still re-runs
        // this same (cached) lookup itself to set resolutionClass/queue.
        const { resolutionClass } = await ticketCategoryConfigService.getByCategory(category);
        const isAdjudicated = resolutionClass === 'ADJUDICATED';

        const priority = await this._computePriority({
            domain, category, subjectType, resolutionClass, linkedContext, raisedBy: { user: userId }
        });
        const { slaAcknowledgeBy, slaFirstReplyBy, slaDecideBy, slaCeilingBy } = this._computeSla(domain, priority);

        // Migration from the old bespoke no-show dispute flow (see
        // _openNoShowDispute) — gates ticket creation on the same
        // eligibility checks the old disputeNoShow() enforced, so an
        // ineligible dispute never produces a ticket.
        if (category === 'jobs.interview_no_show' && subjectType === 'INTERVIEW' && subjectId) {
            await this._openNoShowDispute(subjectId, userId, text);
        }

        const ticketData = {
            category,
            subjectType: subjectType || 'NONE',
            subjectId: subjectId || null,
            raisedBy: { user: userId, role: userRole },
            raisedAgainst: raisedAgainst ? { user: raisedAgainst.userId, role: raisedAgainst.role } : undefined,
            source,
            botCategory: botCategory || null,
            botConfidence: botConfidence ?? null,
            priority,
            slaAcknowledgeBy,
            slaFirstReplyBy,
            slaDecideBy,
            slaCeilingBy,
            linkedContext,
            // The submission text lives as the ticket's opening entry in its
            // own conversation thread for the chatbot path (source: 'CHATBOT');
            // for the form path, it's carried on statusHistory's first entry.
            statusHistory: [{ status: 'NEW', changedBy: userId, reason: text }]
        };

        if (isAdjudicated && raisedAgainst) {
            const { respondentNotifiedAt, respondentDeadline } = await this._computeRespondentDeadline(subjectType, linkedContext);
            ticketData.respondentNotifiedAt = respondentNotifiedAt;
            ticketData.respondentDeadline = respondentDeadline;
        }

        const ticket = new Ticket(ticketData);

        try {
            await ticket.save();
        } catch (err) {
            if (err.code === 11000) {
                throw new ConflictError('You already have an open ticket for this — check "My Tickets" instead of raising a new one.');
            }
            throw err;
        }

        notificationEmitter.emitTicketCreated(ticket).catch(err => console.error('emitTicketCreated failed:', err));
        activityLogEmitter.emitTicketActivity(
            ACTIVITY_ACTIONS.TICKET_CREATED, ticket, { userId, name: user.name, role: userRole }
        ).catch(err => console.error('emitTicketActivity(TICKET_CREATED) failed:', err));

        // spec §08.01/§13 — fires immediately, independent of any agent
        // claiming the ticket.
        if (ticket.respondentNotifiedAt) {
            notificationEmitter.emitClaimExists(ticket).catch(err => console.error('emitClaimExists failed:', err));
            // System-triggered (no admin acted) — logSystemActivity doesn't
            // need a User-ref actor, unlike emitTicketActivity above.
            activityLogEmitter.emitSystemActivity(
                ACTIVITY_ACTIONS.TICKET_RESPONDENT_NOTIFIED,
                { ticketId: ticket._id?.toString(), ticketRef: ticket.ticketId, respondentDeadline: ticket.respondentDeadline }
            ).catch(err => console.error('emitSystemActivity(TICKET_RESPONDENT_NOTIFIED) failed:', err));
        }

        return ticket.toObject();
    }

    async listMine(userId, filters, pagination) {
        const { page, limit, skip } = getPaginationParams(pagination.page, pagination.limit);

        const query = { 'raisedBy.user': userId };
        if (filters.status) query.status = filters.status;
        if (filters.category) query.category = filters.category;

        const [tickets, total] = await Promise.all([
            Ticket.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
            Ticket.countDocuments(query)
        ]);

        return { tickets, pagination: getPaginationMeta(total, page, limit) };
    }

    // spec §08.01: the respondent gets "the category and the substance, not
    // the raiser's verbatim words, and never the raiser's contact details."
    // Strips raisedBy entirely (no user-ref to look up contact details
    // from), statusHistory (Phase 1 stores the raiser's raw submission text
    // in its first entry — real leak risk if left in), and any evidence the
    // raiser supplied (spec §08.03: evidence is visible to admins and to
    // whoever supplied it, never the counterparty).
    _shapeForRespondent(ticket) {
        const { raisedBy, statusHistory, evidence, ...rest } = ticket;
        return {
            ...rest,
            evidence: (evidence || []).filter(e => e.suppliedBy !== 'raiser')
        };
    }

    // Mirrors _shapeForRespondent for the other direction (spec §08.03 is
    // symmetric: evidence is visible to admins and whoever supplied it,
    // never the counterparty — this was missing until now, so a raiser
    // could see the respondent's evidence). raisedBy/statusHistory stay —
    // those are the raiser's own submission, not the respondent's.
    _shapeForRaiser(ticket) {
        const { evidence, ...rest } = ticket;
        return {
            ...rest,
            evidence: (evidence || []).filter(e => e.suppliedBy !== 'respondent')
        };
    }

    _relationToTicket(ticket, user) {
        const userId = (user._id || user.id).toString();
        if (ticket.raisedBy.user.toString() === userId) return 'raiser';
        if (ticket.raisedAgainst && ticket.raisedAgainst.user.toString() === userId) return 'respondent';
        if (user.role === 'admin' && hasCapability(user.adminSubRole, 'ticket.view')) return 'admin';
        return null;
    }

    // One shared read path, response shaped by the caller's relation to the
    // ticket (spec §07: "the user's chat thread and the admin's work item
    // are two views of one record"). Admin-only counterparty history is a
    // later-phase addition once patterns exist to show.
    async getById(ticketId, user) {
        const ticket = await Ticket.findById(ticketId).lean();
        if (!ticket) {
            throw new NotFoundError('Ticket not found');
        }

        const relation = this._relationToTicket(ticket, user);
        if (relation === 'raiser') return this._shapeForRaiser(ticket);
        if (relation === 'respondent') return this._shapeForRespondent(ticket);
        if (relation === 'admin') return ticket;

        throw new ForbiddenError("You don't have permission to view this ticket.");
    }

    // spec §08.03: images and PDF, 5 files, 10 MB each, from either party.
    // The 10 MB/5-file numbers are read live from SystemConfig, not the
    // generous static ceiling upload.middleware.js's multer instance
    // enforces — that ceiling exists only so multer can reject something
    // absurd before this ever runs.
    async addEvidence(ticketId, user, files) {
        const ticket = await Ticket.findById(ticketId);
        if (!ticket) throw new NotFoundError('Ticket not found');

        const relation = this._relationToTicket(ticket, user);
        if (!relation) {
            throw new ForbiddenError("You don't have permission to add evidence to this ticket.");
        }
        if (['CLOSED', 'WITHDRAWN', 'DUPLICATE', 'AUTO_CLOSED'].includes(ticket.status)) {
            throw new UnprocessableEntityError(`Cannot add evidence to a ticket that is already ${ticket.status}.`);
        }
        if (!files || files.length === 0) {
            throw new UnprocessableEntityError('At least one file is required.');
        }

        const [maxFiles, maxSizeMB] = await Promise.all([
            systemConfigService.getEffective('ticket.evidenceMaxFiles'),
            systemConfigService.getEffective('ticket.evidenceMaxSizeMB')
        ]);
        if (ticket.evidence.length + files.length > maxFiles) {
            throw new UnprocessableEntityError(`This ticket can have at most ${maxFiles} evidence files (${ticket.evidence.length} already attached).`);
        }
        const oversized = files.find(f => f.size > maxSizeMB * 1024 * 1024);
        if (oversized) {
            throw new UnprocessableEntityError(`"${oversized.originalname}" exceeds the ${maxSizeMB} MB limit.`);
        }

        const userId = user._id || user.id;
        const uploaded = [];
        for (const file of files) {
            const key = `tickets/${ticket._id}/evidence/${uuidv4()}-${file.originalname}`;
            await s3Service.uploadToS3(file.buffer, key, file.mimetype);
            uploaded.push({
                s3Key: key,
                originalFileName: file.originalname,
                mimeType: file.mimetype,
                sizeBytes: file.size,
                suppliedBy: relation,
                uploadedBy: userId
            });
        }

        ticket.evidence.push(...uploaded);

        // The raiser adding evidence is treated as their reply to an
        // outstanding info request — the closest signal available until
        // Day 3's live chat gives them an actual text-reply channel.
        if (relation === 'raiser' && ticket.status === 'AWAITING_RAISER') {
            if (ticket.slaPauseStartedAt) {
                ticket.slaPausedMs += Date.now() - ticket.slaPauseStartedAt.getTime();
                ticket.slaPauseStartedAt = null;
            }
            ticket.status = 'IN_REVIEW';
        }

        ticket.pushHistory(ticket.status, userId, `${uploaded.length} evidence file(s) added by ${relation}`);
        await ticket.save();

        activityLogEmitter.emitTicketActivity(
            ACTIVITY_ACTIONS.TICKET_EVIDENCE_ADDED, ticket, { userId, name: user.name, role: user.role }, { count: uploaded.length, relation }
        ).catch(err => console.error('emitTicketActivity(TICKET_EVIDENCE_ADDED) failed:', err));

        // Return the caller's own shaped view, same redaction rules as getById.
        const plain = ticket.toObject();
        if (relation === 'raiser') return this._shapeForRaiser(plain);
        if (relation === 'respondent') return this._shapeForRespondent(plain);
        return plain;
    }

    async listAgainstMe(user, filters, pagination) {
        const userId = user._id || user.id;
        const { page, limit, skip } = getPaginationParams(pagination.page, pagination.limit);

        const query = { 'raisedAgainst.user': userId };
        if (filters.status) query.status = filters.status;
        if (filters.category) query.category = filters.category;

        const [tickets, total] = await Promise.all([
            Ticket.find(query).sort({ respondentDeadline: 1, createdAt: -1 }).skip(skip).limit(limit).lean(),
            Ticket.countDocuments(query)
        ]);

        return { tickets: tickets.map(t => this._shapeForRespondent(t)), pagination: getPaginationMeta(total, page, limit) };
    }

    // ─── Admin: queue & ticket management ──────────────────────────────────

    _canAccessQueue(adminSubRole, queue) {
        if (adminSubRole === 'super_admin') return true;
        if (queue === 'GRIEVANCE_OFFICER') return false; // Super Admin only
        if (queue === 'FEEDBACK_BOARD') return false;     // not a worked queue
        const adminFloor = SUB_ROLE_FLOOR[adminSubRole] || 0;
        const queueFloor = QUEUE_FLOOR[queue] || 99;
        return adminFloor >= queueFloor;
    }

    _allowedQueuesFor(adminSubRole) {
        if (adminSubRole === 'super_admin') return ['SUPPORT', 'OPERATIONS', 'SUPER_ADMIN'];
        const adminFloor = SUB_ROLE_FLOOR[adminSubRole] || 0;
        return Object.keys(QUEUE_FLOOR).filter(q => QUEUE_FLOOR[q] <= adminFloor);
    }

    async listQueue(admin, filters, pagination) {
        const { page, limit, skip } = getPaginationParams(pagination.page, pagination.limit);

        const allowedQueues = this._allowedQueuesFor(admin.adminSubRole);
        const query = { status: { $nin: ['NEW', 'TRIAGE'] } };
        query.queue = filters.queue
            ? (allowedQueues.includes(filters.queue) ? filters.queue : '__none__')
            : { $in: allowedQueues };
        if (filters.domain) query.domain = filters.domain;
        if (filters.category) query.category = filters.category;
        if (filters.priority) query.priority = filters.priority;
        if (filters.status) query.status = filters.status;

        const [tickets, total] = await Promise.all([
            Ticket.find(query).sort({ priority: 1, createdAt: 1 }).skip(skip).limit(limit).lean(),
            Ticket.countDocuments(query)
        ]);

        return { tickets, pagination: getPaginationMeta(total, page, limit) };
    }

    async listTriage(admin, pagination) {
        const { page, limit, skip } = getPaginationParams(pagination.page, pagination.limit);
        const allowedQueues = this._allowedQueuesFor(admin.adminSubRole);
        const query = { status: 'TRIAGE', queue: { $in: allowedQueues } };

        const [tickets, total] = await Promise.all([
            Ticket.find(query).sort({ createdAt: 1 }).skip(skip).limit(limit).lean(),
            Ticket.countDocuments(query)
        ]);

        return { tickets, pagination: getPaginationMeta(total, page, limit) };
    }

    // Conditional write — no claim-then-check race window, same pattern as
    // JobApplication's slot confirmation. Treats OPEN as instantaneous:
    // spec §05 names it but never describes a distinct trigger for leaving
    // it, so claiming goes straight to IN_REVIEW or AWAITING_RESPONDENT.
    async claim(ticketId, admin) {
        const existing = await Ticket.findById(ticketId)
            .select('queue respondentNotifiedAt respondentDeadline respondentStatement firstReplyAt')
            .lean();
        if (!existing) throw new NotFoundError('Ticket not found');
        if (!this._canAccessQueue(admin.adminSubRole, existing.queue)) {
            throw new ForbiddenError("You don't have permission to claim this ticket.");
        }

        // The ticket has an active, unanswered respondent window — the
        // agent has nothing to do yet, so land straight on
        // AWAITING_RESPONDENT (SLA paused) instead of IN_REVIEW.
        const isAwaitingRespondent = !!existing.respondentNotifiedAt &&
            !existing.respondentStatement?.submittedAt &&
            !existing.respondentStatement?.lapsed &&
            existing.respondentDeadline > new Date();
        const landingStatus = isAwaitingRespondent ? 'AWAITING_RESPONDENT' : 'IN_REVIEW';

        const adminId = admin._id || admin.id;
        const setFields = { assignedTo: adminId, claimedAt: new Date(), status: landingStatus };
        if (isAwaitingRespondent) setFields.slaPauseStartedAt = new Date();
        // Interim proxy for the "first human reply" SLA clock — claiming
        // isn't the same as actually replying, but it's the closest signal
        // available until Day 3's live chat lands with a real reply event.
        if (!existing.firstReplyAt) setFields.firstReplyAt = new Date();

        const ticket = await Ticket.findOneAndUpdate(
            { _id: ticketId, assignedTo: null, status: { $in: ['NEW', 'TRIAGE'] } },
            {
                $set: setFields,
                $push: { statusHistory: { status: landingStatus, timestamp: new Date(), changedBy: adminId, reason: 'Claimed' } }
            },
            { new: true }
        );
        if (!ticket) {
            throw new ConflictError('This ticket has already been claimed.');
        }

        activityLogEmitter.emitTicketActivity(
            ACTIVITY_ACTIONS.TICKET_CLAIMED, ticket, { userId: adminId, name: admin.name, role: 'admin' }
        ).catch(err => console.error('emitTicketActivity(TICKET_CLAIMED) failed:', err));

        return ticket.toObject();
    }

    async reassign(ticketId, admin, { to, reason }) {
        const adminId = admin._id || admin.id;
        const ticket = await Ticket.findById(ticketId);
        if (!ticket) throw new NotFoundError('Ticket not found');
        if (!this._canAccessQueue(admin.adminSubRole, ticket.queue)) {
            throw new ForbiddenError("You don't have permission to reassign this ticket.");
        }

        ticket.reassignmentHistory.push({ from: ticket.assignedTo, to, reason, at: new Date() });
        ticket.assignedTo = to;
        ticket.pushHistory(ticket.status, adminId, `Reassigned: ${reason}`);
        await ticket.save();

        activityLogEmitter.emitTicketActivity(
            ACTIVITY_ACTIONS.TICKET_REASSIGNED, ticket, { userId: adminId, name: admin.name, role: 'admin' }, { to, reason }
        ).catch(err => console.error('emitTicketActivity(TICKET_REASSIGNED) failed:', err));

        return ticket.toObject();
    }

    // Ticket.js's own pre('validate') hook (isModified('category')) already
    // re-derives resolutionClass/queue when category changes — nothing
    // extra needed here to keep those consistent.
    async recategorize(ticketId, admin, { category, reason }) {
        const adminId = admin._id || admin.id;
        const ticket = await Ticket.findById(ticketId);
        if (!ticket) throw new NotFoundError('Ticket not found');
        if (!this._canAccessQueue(admin.adminSubRole, ticket.queue)) {
            throw new ForbiddenError("You don't have permission to recategorize this ticket.");
        }

        const oldCategory = ticket.category;
        const oldQueue = ticket.queue;
        const oldResolutionClass = ticket.resolutionClass;

        ticket.category = category;
        ticket.pushHistory(ticket.status, adminId, `Recategorized from ${oldCategory}: ${reason}`);
        await ticket.save();

        activityLogEmitter.emitTicketActivity(
            ACTIVITY_ACTIONS.TICKET_RECATEGORIZED, ticket, { userId: adminId, name: admin.name, role: 'admin' },
            { oldCategory, newCategory: category, reason }
        ).catch(err => console.error('emitTicketActivity(TICKET_RECATEGORIZED) failed:', err));

        // spec §13: only notify the raiser when this actually changes what
        // happens next — not on a same-route, same-class relabel.
        if (ticket.queue !== oldQueue || ticket.resolutionClass !== oldResolutionClass) {
            notificationEmitter.emitTicketRecategorized(ticket, oldCategory)
                .catch(err => console.error('emitTicketRecategorized failed:', err));
        }

        return ticket.toObject();
    }

    async priorityOverride(ticketId, admin, { value, reason }) {
        const adminId = admin._id || admin.id;
        const ticket = await Ticket.findById(ticketId);
        if (!ticket) throw new NotFoundError('Ticket not found');
        if (!this._canAccessQueue(admin.adminSubRole, ticket.queue)) {
            throw new ForbiddenError("You don't have permission to override this ticket's priority.");
        }

        // Raising urgency (lower rank number) is self-evidently safe and
        // needs no justification; lowering it needs one on record. The
        // current priority is whatever's actually in effect right now — an
        // existing override if there is one, otherwise the computed value.
        const PRIORITY_RANK = { P1: 1, P2: 2, P3: 3, P4: 4 };
        const currentValue = ticket.priorityOverride?.value || ticket.priority;
        if (PRIORITY_RANK[value] === PRIORITY_RANK[currentValue]) {
            throw new UnprocessableEntityError(`Priority is already ${currentValue}.`);
        }
        const isLowering = PRIORITY_RANK[value] > PRIORITY_RANK[currentValue];
        if (isLowering && !reason) {
            throw new UnprocessableEntityError('A reason is required when lowering a ticket\'s priority.');
        }

        ticket.priorityOverride = { value, reason: reason || null, by: adminId, at: new Date() };
        ticket.pushHistory(ticket.status, adminId, reason ? `Priority overridden to ${value}: ${reason}` : `Priority overridden to ${value}`);
        await ticket.save();

        activityLogEmitter.emitTicketActivity(
            ACTIVITY_ACTIONS.TICKET_PRIORITY_OVERRIDDEN, ticket, { userId: adminId, name: admin.name, role: 'admin' },
            { value, reason }
        ).catch(err => console.error('emitTicketActivity(TICKET_PRIORITY_OVERRIDDEN) failed:', err));

        return ticket.toObject();
    }

    // Pauses a ticket on the raiser instead of deciding — mirrors decide()'s
    // own guard (only the admin who claimed it, only from IN_REVIEW). SLA
    // pauses the same way AWAITING_RESPONDENT already does; sweepAwaitingRaiser
    // nudges at day 1/3 and auto-closes at ticket.awaitingRaiserAutoCloseDays.
    async requestInfo(ticketId, admin, { message }) {
        const adminId = admin._id || admin.id;
        const ticket = await Ticket.findById(ticketId);
        if (!ticket) throw new NotFoundError('Ticket not found');
        if (!ticket.assignedTo || ticket.assignedTo.toString() !== adminId.toString()) {
            throw new ForbiddenError('Only the admin who claimed this ticket can request more information.');
        }
        if (ticket.status !== 'IN_REVIEW') {
            throw new UnprocessableEntityError(`Cannot request information on a ticket in status ${ticket.status}.`);
        }

        ticket.status = 'AWAITING_RAISER';
        ticket.infoRequestedAt = new Date();
        ticket.slaPauseStartedAt = new Date();
        // Reset in case this is a second request-info cycle on the same ticket.
        ticket.reminders.raiserDay1 = false;
        ticket.reminders.raiserDay3 = false;
        ticket.pushHistory('AWAITING_RAISER', adminId, `Info requested: ${message}`);
        await ticket.save();

        notificationEmitter.emitInfoRequested(ticket, message).catch(err => console.error('emitInfoRequested failed:', err));
        activityLogEmitter.emitTicketActivity(
            ACTIVITY_ACTIONS.TICKET_INFO_REQUESTED, ticket, { userId: adminId, name: admin.name, role: 'admin' }, { message }
        ).catch(err => console.error('emitTicketActivity(TICKET_INFO_REQUESTED) failed:', err));

        return ticket.toObject();
    }

    // ─── Raiser: withdraw ───────────────────────────────────────────────────

    async withdraw(ticketId, user, reason) {
        const userId = user._id || user.id;
        const ticket = await Ticket.findById(ticketId);
        if (!ticket) throw new NotFoundError('Ticket not found');
        if (ticket.raisedBy.user.toString() !== userId.toString()) {
            throw new ForbiddenError('Only the person who raised this ticket can withdraw it.');
        }
        if (!ACTIVE_STATUSES.includes(ticket.status)) {
            throw new ConflictError(`Cannot withdraw a ticket that is already ${ticket.status}.`);
        }

        ticket.status = 'WITHDRAWN';
        ticket.pushHistory('WITHDRAWN', userId, reason || 'Withdrawn by raiser');
        await ticket.save();

        activityLogEmitter.emitTicketActivity(
            ACTIVITY_ACTIONS.TICKET_WITHDRAWN, ticket, { userId, name: user.name, role: user.role }, { reason }
        ).catch(err => console.error('emitTicketActivity(TICKET_WITHDRAWN) failed:', err));

        return ticket.toObject();
    }

    // ─── Respondent: answer a claim ────────────────────────────────────────

    async respond(ticketId, user, { text }) {
        const userId = user._id || user.id;
        const ticket = await Ticket.findById(ticketId);
        if (!ticket) throw new NotFoundError('Ticket not found');

        if (!ticket.raisedAgainst || ticket.raisedAgainst.user.toString() !== userId.toString()) {
            throw new ForbiddenError('Only the party this claim was raised against can respond.');
        }
        if (ticket.respondentStatement?.submittedAt) {
            throw new ConflictError('You have already responded to this ticket.');
        }
        if (!ACTIVE_STATUSES.includes(ticket.status)) {
            throw new UnprocessableEntityError(`Cannot respond — this ticket is already ${ticket.status}.`);
        }

        ticket.respondentStatement.text = text;
        ticket.respondentStatement.submittedAt = new Date();
        // Deliberately doesn't touch respondentStatement.lapsed if the sweep
        // already set it true — a late reply still gets captured, but the
        // lapse stays on record as a fact, per spec §08.01.

        if (ticket.status === 'AWAITING_RESPONDENT') {
            if (ticket.slaPauseStartedAt) {
                ticket.slaPausedMs += Date.now() - ticket.slaPauseStartedAt.getTime();
                ticket.slaPauseStartedAt = null;
            }
            ticket.status = 'IN_REVIEW';
        }
        ticket.pushHistory(ticket.status, userId, 'Respondent replied');
        await ticket.save();

        activityLogEmitter.emitTicketActivity(
            ACTIVITY_ACTIONS.TICKET_RESPONDED, ticket, { userId, name: user.name, role: user.role }
        ).catch(err => console.error('emitTicketActivity(TICKET_RESPONDED) failed:', err));

        return ticket.toObject();
    }

    // ─── Cron: respondent-window reminders & lapse ─────────────────────────

    // One pass, bundling both checks (same "bundle several checks into one
    // scheduled run" convention as DutyService's pending-confirmation job
    // and InterviewLifecycleService). Called from cronJobs.js every 15 min.
    async sweepRespondentWindow() {
        const now = new Date();
        const pending = await Ticket.find({
            respondentNotifiedAt: { $ne: null },
            'respondentStatement.submittedAt': null,
            'respondentStatement.lapsed': false
        }).select('ticketId raisedAgainst respondentNotifiedAt respondentDeadline reminders status slaPauseStartedAt slaPausedMs statusHistory');

        let remindersSent = 0;
        let lapsed = 0;

        for (const ticket of pending) {
            const windowMs = ticket.respondentDeadline.getTime() - ticket.respondentNotifiedAt.getTime();
            const halfwayAt = new Date(ticket.respondentNotifiedAt.getTime() + windowMs / 2);
            const twoHoursLeftAt = new Date(ticket.respondentDeadline.getTime() - 2 * 60 * 60 * 1000);

            if (now >= ticket.respondentDeadline) {
                ticket.respondentStatement.lapsed = true;
                if (ticket.status === 'AWAITING_RESPONDENT') {
                    if (ticket.slaPauseStartedAt) {
                        ticket.slaPausedMs += now.getTime() - ticket.slaPauseStartedAt.getTime();
                        ticket.slaPauseStartedAt = null;
                    }
                    ticket.status = 'IN_REVIEW';
                }
                ticket.pushHistory(ticket.status, 'system', 'Response window lapsed — no reply received');
                await ticket.save();
                lapsed++;
                continue;
            }

            if (!ticket.reminders.respondentTwoHoursLeft && now >= twoHoursLeftAt) {
                ticket.reminders.respondentTwoHoursLeft = true;
                await ticket.save();
                notificationEmitter.emitResponseWindowClosing(ticket, '2 hours').catch(err => console.error('emitResponseWindowClosing failed:', err));
                remindersSent++;
            } else if (!ticket.reminders.respondentHalfWindow && now >= halfwayAt) {
                ticket.reminders.respondentHalfWindow = true;
                await ticket.save();
                notificationEmitter.emitResponseWindowClosing(ticket, 'half the response window').catch(err => console.error('emitResponseWindowClosing failed:', err));
                remindersSent++;
            }
        }

        if (lapsed > 0) {
            activityLogEmitter.emitSystemActivity(
                ACTIVITY_ACTIONS.TICKET_RESPONSE_LAPSED, { count: lapsed, timestamp: now.toISOString() }
            ).catch(err => console.error('emitSystemActivity(TICKET_RESPONSE_LAPSED) failed:', err));
        }

        return { remindersSent, lapsed };
    }

    // Day-1/day-3 nudges + auto-close for tickets an admin parked on
    // requestInfo() — same halfway/lapse shape as sweepRespondentWindow
    // above, just against infoRequestedAt instead of respondentNotifiedAt.
    async sweepAwaitingRaiser() {
        const now = new Date();
        const autoCloseDays = await systemConfigService.getEffective('ticket.awaitingRaiserAutoCloseDays');

        const pending = await Ticket.find({
            status: 'AWAITING_RAISER',
            infoRequestedAt: { $ne: null }
        }).select('ticketId raisedBy infoRequestedAt reminders slaPauseStartedAt slaPausedMs statusHistory');

        let remindersSent = 0;
        let autoClosed = 0;

        for (const ticket of pending) {
            const day1At = new Date(ticket.infoRequestedAt.getTime() + 1 * 24 * 60 * 60 * 1000);
            const day3At = new Date(ticket.infoRequestedAt.getTime() + 3 * 24 * 60 * 60 * 1000);
            const deadline = new Date(ticket.infoRequestedAt.getTime() + autoCloseDays * 24 * 60 * 60 * 1000);

            if (now >= deadline) {
                if (ticket.slaPauseStartedAt) {
                    ticket.slaPausedMs += now.getTime() - ticket.slaPauseStartedAt.getTime();
                    ticket.slaPauseStartedAt = null;
                }
                ticket.status = 'AUTO_CLOSED';
                ticket.pushHistory('AUTO_CLOSED', 'system', `Auto-closed — no response to information request after ${autoCloseDays} days`);
                await ticket.save();
                autoClosed++;
                continue;
            }

            if (!ticket.reminders.raiserDay3 && now >= day3At) {
                ticket.reminders.raiserDay3 = true;
                await ticket.save();
                notificationEmitter.emitInfoRequestReminder(ticket, '3 days ago').catch(err => console.error('emitInfoRequestReminder failed:', err));
                remindersSent++;
            } else if (!ticket.reminders.raiserDay1 && now >= day1At) {
                ticket.reminders.raiserDay1 = true;
                await ticket.save();
                notificationEmitter.emitInfoRequestReminder(ticket, '1 day ago').catch(err => console.error('emitInfoRequestReminder failed:', err));
                remindersSent++;
            }
        }

        if (autoClosed > 0) {
            activityLogEmitter.emitSystemActivity(
                ACTIVITY_ACTIONS.TICKET_AUTO_CLOSED, { count: autoClosed, timestamp: now.toISOString() }
            ).catch(err => console.error('emitSystemActivity(TICKET_AUTO_CLOSED) failed:', err));
        }

        return { remindersSent, autoClosed };
    }

    // Priority-based claim timeout (spec update) — an admin who claims a
    // ticket but leaves it untouched in IN_REVIEW past their priority's
    // window loses the claim; it returns to the queue for anyone to pick up.
    // Lands on NEW rather than TRIAGE — by the time a ticket is claimable it
    // already has a resolved category/queue, so TRIAGE's "needs a human to
    // categorise this" meaning no longer applies.
    async sweepClaimTimeout() {
        const now = new Date();
        const claimed = await Ticket.find({
            status: 'IN_REVIEW',
            assignedTo: { $ne: null },
            claimedAt: { $ne: null }
        }).select('ticketId priority priorityOverride assignedTo claimedAt statusHistory');

        let returned = 0;

        for (const ticket of claimed) {
            const effectivePriority = ticket.priorityOverride?.value || ticket.priority;
            const timeoutMinutes = CLAIM_TIMEOUT_MINUTES_BY_PRIORITY[effectivePriority];
            const deadline = new Date(ticket.claimedAt.getTime() + timeoutMinutes * 60 * 1000);

            if (now >= deadline) {
                ticket.assignedTo = null;
                ticket.claimedAt = null;
                ticket.status = 'NEW';
                ticket.pushHistory('NEW', 'system', `Returned to queue — unclaimed/untouched for ${timeoutMinutes} minutes (${effectivePriority})`);
                await ticket.save();
                returned++;
            }
        }

        if (returned > 0) {
            activityLogEmitter.emitSystemActivity(
                ACTIVITY_ACTIONS.TICKET_CLAIM_TIMEOUT, { count: returned, timestamp: now.toISOString() }
            ).catch(err => console.error('emitSystemActivity(TICKET_CLAIM_TIMEOUT) failed:', err));
        }

        return { returned };
    }

    // ─── Decision, approval & consequence execution ────────────────────────

    // spec §07.04's checkable-today subset: the admin can't be a party to
    // their own ticket. "Created the subject" / "took the call that
    // produced it" needs cross-referencing linkedContext's own audit trail
    // (e.g. Duty.statusHistory's changedBy) — flagged as a follow-up, not
    // built this phase.
    _isSelfAdjudicating(ticket, adminId) {
        const id = adminId.toString();
        return ticket.raisedBy.user.toString() === id ||
            (ticket.raisedAgainst && ticket.raisedAgainst.user.toString() === id);
    }

    // Shared by decide()'s direct-resolve path and approveDecision(): runs
    // the consequence engine, derives the terminal status, and syncs the
    // one category-specific side effect that isn't a generic
    // resolutionAction (see _syncNoShowDisputeOnDecision). Does not save —
    // callers push their own statusHistory entry first.
    async _finalizeResolution(ticket, adminId) {
        await ticketConsequenceService.execute(ticket, adminId, ticket.actionTakenStatement);
        ticket.status = TERMINAL_STATUS_BY_OUTCOME[ticket.resolutionOutcome] || DEFAULT_TERMINAL_STATUS;
        await this._syncNoShowDisputeOnDecision(ticket, adminId);

        // spec §10 — repeat-behaviour thresholds, evaluated on every real
        // resolution (not a separate cron). Never blocks the resolution
        // itself on a pattern-detection failure.
        patternEngineService.evaluateForTicket(ticket).catch(err => console.error('evaluateForTicket failed:', err));

        // spec §05: once an appeal resolves, the original ticket closes —
        // it was already APPEALED, not sitting open this whole time.
        if (ticket.appealOf) {
            await Ticket.findByIdAndUpdate(ticket.appealOf, {
                status: 'CLOSED',
                $push: { statusHistory: { status: 'CLOSED', timestamp: new Date(), changedBy: 'system', reason: `Appeal ${ticket.ticketId} decided` } }
            });
        }
    }

    // Migration note: this replaces the old bespoke
    // interviewScheduling.service.js#resolveNoShowDispute. That method set
    // JobApplication.interview.noShow.disputeStatus to 'upheld' (dispute
    // rejected, mark stands) or 'voided' (dispute succeeded, mark cleared) —
    // same mapping here, just triggered by a ticket decision instead of a
    // dedicated admin endpoint. noShowPenalty.service.js's live trailing-
    // window computation already excludes 'voided' and only 'open' disputes
    // are held — unchanged by this migration.
    async _syncNoShowDisputeOnDecision(ticket, adminId) {
        if (ticket.category !== 'jobs.interview_no_show' || ticket.subjectType !== 'INTERVIEW' || !ticket.subjectId) {
            return;
        }
        const disputeStatus = ticket.status === 'REJECTED' ? 'upheld' : 'voided';
        await JobApplication.findByIdAndUpdate(ticket.subjectId, {
            'interview.noShow.disputeStatus': disputeStatus,
            'interview.noShow.resolvedAt': new Date(),
            'interview.noShow.resolvedBy': adminId
        });
    }

    // Migration note: replaces the old
    // interviewScheduling.service.js#disputeNoShow's precondition checks and
    // 'open' transition — called from createTicket() before the ticket
    // itself is saved, so an ineligible dispute never produces a ticket.
    async _openNoShowDispute(applicationId, userId, reason) {
        const application = await JobApplication.findById(applicationId);
        if (!application) {
            throw new NotFoundError('Application not found');
        }
        const noShow = application.interview?.noShow;
        if (!noShow?.markedAt || noShow.by !== 'candidate') {
            throw new UnprocessableEntityError('There is no no-show marked against you on this application.');
        }
        if (!application.user || application.user.toString() !== userId.toString()) {
            throw new ForbiddenError('You can only dispute a no-show marked against your own application.');
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
    }

    // ─── Appeals ─────────────────────────────────────────────────────────

    _nextFloorQueue(queue) {
        if (queue === 'SUPPORT') return 'OPERATIONS';
        // OPERATIONS -> SUPER_ADMIN, and SUPER_ADMIN stays SUPER_ADMIN —
        // spec §11: "a different Super Admin hears it," not a higher floor
        // (there isn't one). GRIEVANCE_OFFICER/FEEDBACK_BOARD tickets aren't
        // adjudicated in the first place, so they never reach an appeal.
        return 'SUPER_ADMIN';
    }

    async appeal(originalTicketId, user, { reasonText }) {
        const userId = user._id || user.id;
        const original = await Ticket.findById(originalTicketId);
        if (!original) throw new NotFoundError('Ticket not found');

        const isRaiser = original.raisedBy.user.toString() === userId.toString();
        const isRespondent = original.raisedAgainst && original.raisedAgainst.user.toString() === userId.toString();
        if (!isRaiser && !isRespondent) {
            throw new ForbiddenError('Only a party to this ticket can appeal it.');
        }

        if (!['RESOLVED', 'REJECTED'].includes(original.status)) {
            throw new UnprocessableEntityError(`Cannot appeal a ticket in status ${original.status}.`);
        }
        // spec §11: "Not ACTIONED housekeeping" — eligible only if there was
        // a real finding or a real consequence.
        const eligibleOutcome = ['UPHELD', 'PARTLY_UPHELD', 'DECLINED'].includes(original.resolutionOutcome);
        const hasConsequence = original.resolutionActions.length > 0;
        if (!eligibleOutcome && !hasConsequence) {
            throw new UnprocessableEntityError('This ticket closed as routine housekeeping and cannot be appealed.');
        }

        const isSuspensionRelated = original.resolutionActions.some(a => a.action === 'FLAG_FOR_SUSPENSION');
        const windowDays = await systemConfigService.getEffective(
            isSuspensionRelated ? 'ticket.appealWindowSuspensionDays' : 'ticket.appealWindowDays'
        );
        const decidedAt = original.statusHistory[original.statusHistory.length - 1]?.timestamp || original.updatedAt;
        const deadline = new Date(decidedAt.getTime() + windowDays * 24 * 60 * 60 * 1000);
        if (new Date() > deadline) {
            throw new UnprocessableEntityError(`The ${windowDays}-day appeal window for this ticket has passed.`);
        }

        // One round only (spec §11).
        const existingAppeal = await Ticket.findOne({ appealOf: originalTicketId }).select('_id').lean();
        if (existingAppeal) {
            throw new ConflictError('This ticket has already been appealed once. A second appeal is not available — see external routes for further recourse.');
        }

        const appellant = isRaiser ? original.raisedBy : original.raisedAgainst;
        // Only set when the original actually had a counterparty — an
        // appeal of a non-adjudicated ticket (consequence attached, but no
        // raisedAgainst on the original at all) has no one on the other
        // side, and must NOT get a respondent notice.
        const otherParty = original.raisedAgainst ? (isRaiser ? original.raisedAgainst : original.raisedBy) : undefined;
        const category = isSuspensionRelated ? 'account.suspension_appeal' : original.category;
        const domain = category.split('.')[0];
        const queue = this._nextFloorQueue(original.queue);

        const linkedContext = await this._resolveLinkedContext(original.subjectType, original.subjectId);
        const { resolutionClass } = await ticketCategoryConfigService.getByCategory(category);
        const priority = await this._computePriority({
            domain, category, subjectType: original.subjectType, resolutionClass, linkedContext, raisedBy: appellant
        });
        const { slaAcknowledgeBy, slaFirstReplyBy, slaDecideBy, slaCeilingBy } = this._computeSla(domain, priority);

        const appealData = {
            category,
            subjectType: original.subjectType,
            subjectId: original.subjectId,
            raisedBy: appellant,
            raisedAgainst: otherParty,
            appealOf: originalTicketId,
            source: 'IN_APP_FORM',
            priority,
            slaAcknowledgeBy,
            slaFirstReplyBy,
            slaDecideBy,
            slaCeilingBy,
            linkedContext,
            statusHistory: [{ status: 'NEW', changedBy: userId, reason: reasonText }]
        };

        if (otherParty) {
            const { respondentNotifiedAt, respondentDeadline } = await this._computeRespondentDeadline(original.subjectType, linkedContext);
            appealData.respondentNotifiedAt = respondentNotifiedAt;
            appealData.respondentDeadline = respondentDeadline;
        }

        const appealTicket = new Ticket(appealData);
        await appealTicket.save();

        // Ticket.js's pre('validate') hook always re-derives `queue` from
        // the category's default route for a new document — it has no way
        // to know this save is an appeal that must route one floor up
        // instead. Corrected here, right after, rather than teaching the
        // shared hook about a one-off appeal exception.
        if (appealTicket.queue !== queue) {
            await Ticket.updateOne({ _id: appealTicket._id }, { queue });
            appealTicket.queue = queue;
        }

        original.status = 'APPEALED';
        original.pushHistory('APPEALED', userId, `Appealed via ${appealTicket.ticketId}`);
        await original.save();

        if (otherParty) {
            notificationEmitter.emitClaimExists(appealTicket).catch(err => console.error('emitClaimExists (appeal) failed:', err));
        }
        activityLogEmitter.emitTicketActivity(
            ACTIVITY_ACTIONS.TICKET_APPEALED, appealTicket, { userId, name: user.name, role: user.role }, { originalTicketId }
        ).catch(err => console.error('emitTicketActivity(TICKET_APPEALED) failed:', err));

        return appealTicket.toObject();
    }

    async decide(ticketId, admin, { resolutionOutcome, resolutionActions, note, evidenceReliedOn }) {
        const adminId = admin._id || admin.id;
        const ticket = await Ticket.findById(ticketId);
        if (!ticket) throw new NotFoundError('Ticket not found');

        if (!ticket.assignedTo || ticket.assignedTo.toString() !== adminId.toString()) {
            throw new ForbiddenError('Only the admin who claimed this ticket can decide it.');
        }
        if (ticket.status !== 'IN_REVIEW') {
            throw new UnprocessableEntityError(`Cannot decide a ticket in status ${ticket.status}.`);
        }
        if (this._isSelfAdjudicating(ticket, adminId)) {
            throw new ForbiddenError('You cannot decide a ticket you are a party to.');
        }
        if (ticket.appealOf) {
            // spec §11: "never the same person" as whoever decided the
            // original ticket this is an appeal of.
            const original = await Ticket.findById(ticket.appealOf).select('decidedBy').lean();
            if (original?.decidedBy && original.decidedBy.toString() === adminId.toString()) {
                throw new ForbiddenError('An appeal cannot be decided by the same admin who decided the original ticket.');
            }
        }

        const validOutcomes = ticket.appealOf ? APPEAL_OUTCOMES : (VALID_OUTCOMES_BY_CLASS[ticket.resolutionClass] || []);
        if (!validOutcomes.includes(resolutionOutcome)) {
            throw new UnprocessableEntityError(
                `${resolutionOutcome} is not a valid outcome for a ${ticket.resolutionClass} ticket. Allowed: ${validOutcomes.join(', ')}`
            );
        }

        for (const entry of resolutionActions) {
            if (!ticketConsequenceService.isImplemented(entry.action) && !ticketConsequenceService.isGated(entry.action)) {
                throw new UnprocessableEntityError(`${entry.action} is not implemented yet.`);
            }
        }

        ticket.resolutionOutcome = resolutionOutcome;
        ticket.resolutionActions = resolutionActions.map(a => ({ action: a.action, details: a.details || {} }));
        ticket.decidedBy = adminId;
        ticket.actionTakenStatement = await ticketConsequenceService.buildStatement(ticket, note);

        // jobs.interview_no_show always has a candidate-standing side effect
        // (see _syncNoShowDisputeOnDecision) even when no explicit
        // resolutionActions entry needs approval — treat it as consequential
        // regardless of which actions were chosen.
        const needsApproval = ticketConsequenceService.requiresApproval(ticket.resolutionActions) ||
            ticket.category === 'jobs.interview_no_show';

        if (needsApproval) {
            ticket.status = 'PENDING_APPROVAL';
            ticket.pushHistory('PENDING_APPROVAL', adminId, 'Decision proposed, awaiting sign-off');
            await ticket.save();
        } else {
            await this._finalizeResolution(ticket, adminId);
            ticket.pushHistory(ticket.status, adminId, 'Decided');
            await ticket.save();
            notificationEmitter.emitTicketOutcomeDecided(ticket).catch(err => console.error('emitTicketOutcomeDecided failed:', err));
            if (ticket.appealOf) {
                notificationEmitter.emitAppealOutcome(ticket).catch(err => console.error('emitAppealOutcome failed:', err));
            }
        }

        activityLogEmitter.emitTicketActivity(
            ACTIVITY_ACTIONS.TICKET_DECIDED, ticket, { userId: adminId, name: admin.name, role: 'admin' },
            { resolutionOutcome, actions: ticket.resolutionActions.map(a => a.action), needsApproval, evidenceReliedOn }
        ).catch(err => console.error('emitTicketActivity(TICKET_DECIDED) failed:', err));

        return ticket.toObject();
    }

    async listApprovalQueue(admin, pagination) {
        const { page, limit, skip } = getPaginationParams(pagination.page, pagination.limit);
        const allowedQueues = this._allowedQueuesFor(admin.adminSubRole);
        const query = { status: 'PENDING_APPROVAL', queue: { $in: allowedQueues } };

        const [tickets, total] = await Promise.all([
            Ticket.find(query).sort({ createdAt: 1 }).skip(skip).limit(limit).lean(),
            Ticket.countDocuments(query)
        ]);

        return { tickets, pagination: getPaginationMeta(total, page, limit) };
    }

    async approveDecision(ticketId, admin) {
        const adminId = admin._id || admin.id;
        const ticket = await Ticket.findById(ticketId);
        if (!ticket) throw new NotFoundError('Ticket not found');

        if (ticket.status !== 'PENDING_APPROVAL') {
            throw new UnprocessableEntityError(`Cannot approve a ticket in status ${ticket.status}.`);
        }
        if (!ticket.decidedBy || ticket.decidedBy.toString() === adminId.toString()) {
            throw new ForbiddenError('The approver must be a different admin from whoever proposed the decision.');
        }
        if (!this._canAccessQueue(admin.adminSubRole, ticket.queue)) {
            throw new ForbiddenError("You don't have permission to approve this ticket.");
        }

        await this._finalizeResolution(ticket, adminId);
        ticket.approvedBy = adminId;
        ticket.pushHistory(ticket.status, adminId, 'Approved');
        await ticket.save();

        notificationEmitter.emitTicketOutcomeDecided(ticket).catch(err => console.error('emitTicketOutcomeDecided failed:', err));
        if (ticket.appealOf) {
            notificationEmitter.emitAppealOutcome(ticket).catch(err => console.error('emitAppealOutcome failed:', err));
        }
        activityLogEmitter.emitTicketActivity(
            ACTIVITY_ACTIONS.TICKET_APPROVED, ticket, { userId: adminId, name: admin.name, role: 'admin' }
        ).catch(err => console.error('emitTicketActivity(TICKET_APPROVED) failed:', err));

        return ticket.toObject();
    }

    async returnForReview(ticketId, admin, reason) {
        const adminId = admin._id || admin.id;
        const ticket = await Ticket.findById(ticketId);
        if (!ticket) throw new NotFoundError('Ticket not found');

        if (ticket.status !== 'PENDING_APPROVAL') {
            throw new UnprocessableEntityError(`Cannot return a ticket in status ${ticket.status}.`);
        }
        if (!ticket.decidedBy || ticket.decidedBy.toString() === adminId.toString()) {
            throw new ForbiddenError('The approver must be a different admin from whoever proposed the decision.');
        }

        ticket.resolutionOutcome = null;
        ticket.resolutionActions = [];
        ticket.actionTakenStatement = null;
        ticket.decidedBy = null;
        ticket.status = 'IN_REVIEW';
        ticket.pushHistory('IN_REVIEW', adminId, `Returned for review: ${reason}`);
        await ticket.save();

        activityLogEmitter.emitTicketActivity(
            ACTIVITY_ACTIONS.TICKET_RETURNED_FOR_REVIEW, ticket, { userId: adminId, name: admin.name, role: 'admin' }, { reason }
        ).catch(err => console.error('emitTicketActivity(TICKET_RETURNED_FOR_REVIEW) failed:', err));

        return ticket.toObject();
    }
}

module.exports = new TicketService();
