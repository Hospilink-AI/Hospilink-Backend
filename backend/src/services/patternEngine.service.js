const PatternFlag = require('../models/PatternFlag');
const Ticket = require('../models/Ticket');
const Hospital = require('../models/Hospital');
const MedicalStaff = require('../models/MedicalStaff');
const adminService = require('./admin.service');
const systemConfigService = require('./systemConfig.service');
const notificationEmitter = require('./notificationEmitter');
const activityLogEmitter = require('./activityLogEmitter');
const { ACTIVITY_ACTIONS } = require('../utils/activityLog.constants');
const { PATTERN_DEFINITIONS } = require('../utils/patternDefinitions');
const { NotFoundError, ForbiddenError, ConflictError, UnprocessableEntityError } = require('../middleware/error.middleware');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');

// Same floor ladder ticket.service.js uses for queue access — duplicated
// (3 lines) rather than importing a private constant across services.
const REVIEW_FLOOR_RANK = { OPERATIONS: 1, SUPER_ADMIN: 2 };
const SUB_ROLE_FLOOR = { operations_manager: 1, super_admin: 2 }; // tech_support never reaches patterns

function canReview(adminSubRole, reviewFloor) {
    if (adminSubRole === 'super_admin') return true;
    const adminFloor = SUB_ROLE_FLOOR[adminSubRole] || 0;
    return adminFloor >= (REVIEW_FLOOR_RANK[reviewFloor] || 99);
}

function allowedReviewFloors(adminSubRole) {
    if (adminSubRole === 'super_admin') return ['OPERATIONS', 'SUPER_ADMIN'];
    const adminFloor = SUB_ROLE_FLOOR[adminSubRole] || 0;
    return Object.keys(REVIEW_FLOOR_RANK).filter(f => REVIEW_FLOOR_RANK[f] <= adminFloor);
}

async function resolveProfile(userId, partyRole) {
    if (partyRole === 'hospital') return Hospital.findOne({ user: userId });
    return MedicalStaff.findOne({ user: userId });
}

class PatternEngineService {
    async _createFlag({ party, partyRole, patternType, windowDays, thresholdCount, actualCount, casesRelied, raises, reviewFloor }) {
        const flagData = {
            party, partyRole, patternType, windowDays, thresholdCount, actualCount,
            casesRelied, raises, status: 'open'
        };

        if (raises === 'suspension_proposal') {
            const responseDays = await systemConfigService.getEffective('ticket.suspensionResponseWindowDays');
            flagData.proposal = { responseDeadline: new Date(Date.now() + responseDays * 24 * 60 * 60 * 1000) };
        }

        const flag = await PatternFlag.create(flagData);

        activityLogEmitter.emitSystemActivity(
            raises === 'suspension_proposal' ? ACTIVITY_ACTIONS.SUSPENSION_PROPOSED : ACTIVITY_ACTIONS.PATTERN_FLAG_RAISED,
            { flagId: flag._id.toString(), party: party.toString(), patternType, raises, reviewFloor }
        ).catch(err => console.error('emitSystemActivity(flag-raised) failed:', err));

        if (raises === 'suspension_proposal') {
            notificationEmitter.emitSuspensionProposed(flag).catch(err => console.error('emitSuspensionProposed failed:', err));
        } else {
            notificationEmitter.emitPatternFlagRaised(flag).catch(err => console.error('emitPatternFlagRaised failed:', err));
        }

        return flag;
    }

    // Called from ticket.service.js#_finalizeResolution, right after every
    // real resolution — same trigger point Phase 4 established, not a
    // separate cron. Only ever creates a flag for the highest tier that's
    // both newly crossed AND doesn't already have an open flag of that
    // exact (patternType, raises) pair — an escalation to a higher tier
    // still creates a new, more severe flag even if a lower-tier one is
    // already open for the same pattern.
    async evaluateForTicket(ticket) {
        if (!ticket.raisedAgainst) return;

        const party = ticket.raisedAgainst.user;
        const partyRole = ticket.raisedAgainst.role;

        for (const def of PATTERN_DEFINITIONS) {
            if (def.categories && !def.categories.includes(ticket.category)) continue;
            if (def.upheldOnly && !['UPHELD', 'PARTLY_UPHELD'].includes(ticket.resolutionOutcome)) continue;

            for (const tier of def.tiers) {
                const cutoff = new Date(Date.now() - tier.windowDays * 24 * 60 * 60 * 1000);
                const query = {
                    'raisedAgainst.user': party,
                    status: { $in: ['RESOLVED', 'REJECTED'] },
                    updatedAt: { $gte: cutoff }
                };
                if (def.categories) query.category = { $in: def.categories };
                if (def.upheldOnly) query.resolutionOutcome = { $in: ['UPHELD', 'PARTLY_UPHELD'] };

                const matchingTickets = await Ticket.find(query).select('_id').limit(50).lean();
                if (matchingTickets.length < tier.thresholdCount) continue;

                const existingOpen = await PatternFlag.findOne({
                    party, patternType: def.patternType, raises: tier.raises, status: 'open'
                }).lean();
                if (existingOpen) break; // already flagged at this exact tier — don't duplicate

                await this._createFlag({
                    party, partyRole, patternType: def.patternType,
                    windowDays: tier.windowDays, thresholdCount: tier.thresholdCount,
                    actualCount: matchingTickets.length,
                    casesRelied: matchingTickets.map(t => t._id),
                    raises: tier.raises, reviewFloor: tier.reviewFloor
                });
                break; // one flag per definition per resolution — the highest qualifying tier wins
            }
        }
    }

    // FLAG_FOR_SUSPENSION / APPLY_PRECAUTIONARY_RESTRICTION / ISSUE_WARNING
    // consequence handlers all call this — an admin's own judgment already
    // is the threshold, so no count/window math, just a direct record.
    async createManualFlag({ party, partyRole, raises, reason, ticketId }) {
        return this._createFlag({
            party, partyRole, patternType: 'admin_flagged',
            windowDays: 0, thresholdCount: 1, actualCount: 1,
            casesRelied: [ticketId], raises,
            reviewFloor: raises === 'operations_flag' ? 'OPERATIONS' : 'SUPER_ADMIN'
        });
    }

    // RESTORE_ACCOUNT consequence handler.
    async voidFlag(flagId, adminId) {
        const flag = await PatternFlag.findById(flagId);
        if (!flag) throw new NotFoundError('Pattern flag not found');

        const wasSuspended = flag.raises === 'suspension_proposal' && flag.proposal?.decision === 'suspend';
        flag.status = 'voided';
        await flag.save();

        if (wasSuspended) {
            const profile = await resolveProfile(flag.party, flag.partyRole);
            if (profile) {
                if (flag.partyRole === 'hospital') await adminService.unsuspendHospital(profile._id);
                else await adminService.unsuspendMedicalStaff(profile._id);
            }
        }

        return flag.toObject();
    }

    async respondToProposal(flagId, user, { text }) {
        const userId = user._id || user.id;
        const flag = await PatternFlag.findById(flagId);
        if (!flag) throw new NotFoundError('Pattern flag not found');
        if (flag.party.toString() !== userId.toString()) {
            throw new ForbiddenError('You can only respond to a proposal against your own account.');
        }
        if (flag.raises !== 'suspension_proposal') {
            throw new UnprocessableEntityError('This flag has no proposal to respond to.');
        }
        if (flag.proposal?.partyResponse?.submittedAt) {
            throw new ConflictError('You have already responded to this proposal.');
        }
        if (flag.status === 'decided') {
            throw new UnprocessableEntityError('This proposal has already been decided.');
        }

        flag.proposal.partyResponse = { text, submittedAt: new Date(), lapsed: false };
        flag.status = 'responded';
        await flag.save();

        return flag.toObject();
    }

    async decideProposal(flagId, admin, { decision, decisionReason }) {
        const adminId = admin._id || admin.id;
        const flag = await PatternFlag.findById(flagId);
        if (!flag) throw new NotFoundError('Pattern flag not found');
        if (flag.raises !== 'suspension_proposal') {
            throw new UnprocessableEntityError('This flag is not a suspension proposal.');
        }
        if (flag.status === 'decided') {
            throw new ConflictError('This proposal has already been decided.');
        }

        if (decision === 'suspend') {
            const profile = await resolveProfile(flag.party, flag.partyRole);
            if (!profile) throw new NotFoundError(`${flag.partyRole} profile not found for this account`);
            if (flag.partyRole === 'hospital') await adminService.suspendHospital(profile._id, decisionReason);
            else await adminService.suspendMedicalStaff(profile._id, decisionReason);
        }

        flag.proposal.decidedBy = adminId;
        flag.proposal.decision = decision;
        flag.proposal.decisionReason = decisionReason;
        flag.proposal.decidedAt = new Date();
        flag.status = 'decided';
        await flag.save();

        notificationEmitter.emitSuspensionDecided(flag).catch(err => console.error('emitSuspensionDecided failed:', err));
        activityLogEmitter.emitSystemActivity(
            ACTIVITY_ACTIONS.SUSPENSION_DECIDED,
            { flagId: flag._id.toString(), decidedBy: adminId.toString(), decision }
        ).catch(err => console.error('emitSystemActivity(SUSPENSION_DECIDED) failed:', err));

        return flag.toObject();
    }

    async listForAdmin(admin, filters, pagination) {
        const { page, limit, skip } = getPaginationParams(pagination.page, pagination.limit);
        // reviewFloor isn't stored on the flag — derived from patternType via
        // the definitions table (admin_flagged flags are visible wherever
        // their raises type would normally land: operations_flag ->
        // Operations, everything else -> Super Admin).
        const allowedFloors = allowedReviewFloors(admin.adminSubRole);
        const defByType = Object.fromEntries(PATTERN_DEFINITIONS.map(d => [d.patternType, d]));

        const query = {};
        if (filters.status) query.status = filters.status;
        if (filters.raises) query.raises = filters.raises;

        const [flags, total] = await Promise.all([
            PatternFlag.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
            PatternFlag.countDocuments(query)
        ]);

        const visible = flags.filter(f => {
            const tier = defByType[f.patternType]?.tiers.find(t => t.raises === f.raises);
            const reviewFloor = tier?.reviewFloor || (f.raises === 'operations_flag' ? 'OPERATIONS' : 'SUPER_ADMIN');
            return allowedFloors.includes(reviewFloor);
        });

        return { flags: visible, pagination: getPaginationMeta(total, page, limit) };
    }

    async getById(flagId, admin) {
        const flag = await PatternFlag.findById(flagId).lean();
        if (!flag) throw new NotFoundError('Pattern flag not found');

        const defByType = Object.fromEntries(PATTERN_DEFINITIONS.map(d => [d.patternType, d]));
        const tier = defByType[flag.patternType]?.tiers.find(t => t.raises === flag.raises);
        const reviewFloor = tier?.reviewFloor || (flag.raises === 'operations_flag' ? 'OPERATIONS' : 'SUPER_ADMIN');

        if (!canReview(admin.adminSubRole, reviewFloor)) {
            throw new ForbiddenError("You don't have permission to view this flag.");
        }
        return flag;
    }

    async listSuspensionProposals(admin, pagination) {
        return this.listForAdmin(admin, { raises: 'suspension_proposal' }, pagination);
    }

    // spec §10.04: "every flag is visible to the party it concerns" — never
    // a shadow record.
    async listForParty(user) {
        const userId = user._id || user.id;
        return PatternFlag.find({ party: userId, status: { $ne: 'voided' } }).sort({ createdAt: -1 }).lean();
    }
}

module.exports = new PatternEngineService();
