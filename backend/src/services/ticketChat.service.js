const Ticket = require('../models/Ticket');
const TicketChatThread = require('../models/TicketChatThread');
const User = require('../models/User');
const ticketService = require('./ticket.service');
const notificationEmitter = require('./notificationEmitter');
const activityLogEmitter = require('./activityLogEmitter');
const { ACTIVITY_ACTIONS } = require('../utils/activityLog.constants');
const { NotFoundError, ForbiddenError, UnprocessableEntityError } = require('../middleware/error.middleware');

// Same terminal-status list addEvidence already blocks on — chat shouldn't
// be reachable on a ticket that's done, evidence or not.
const CLOSED_STATUSES = ['CLOSED', 'WITHDRAWN', 'DUPLICATE', 'AUTO_CLOSED'];

// "Priya, HospiLink Operations" — spec's display format for an admin's
// identity in a party-facing thread view. Team label, not literal sub-role.
const ADMIN_TEAM_LABEL = { tech_support: 'Support', operations_manager: 'Operations', super_admin: 'Admin' };

class TicketChatService {
    // Raiser/respondent party resolution reuses ticketService's own
    // raisedBy/raisedAgainst matching rather than duplicating it — an admin
    // caller never resolves through here, callers branch on user.role first.
    _resolveParty(ticket, user) {
        const relation = ticketService._relationToTicket(ticket, user);
        if (relation !== 'raiser' && relation !== 'respondent') {
            throw new ForbiddenError("You don't have permission to chat on this ticket.");
        }
        return relation;
    }

    async sendMessage(ticketId, sender, { text, party, files }) {
        const ticket = await Ticket.findById(ticketId);
        if (!ticket) throw new NotFoundError('Ticket not found');

        let resolvedParty;
        let senderType;
        if (sender.role === 'admin') {
            if (!ticketService._canAccessQueue(sender.adminSubRole, ticket.queue)) {
                throw new ForbiddenError("You don't have permission to chat on this ticket.");
            }
            resolvedParty = party || (ticket.raisedAgainst ? null : 'raiser');
            if (!resolvedParty) {
                throw new UnprocessableEntityError('party is required (raiser or respondent) when this ticket has a respondent.');
            }
            if (resolvedParty === 'respondent' && !ticket.raisedAgainst) {
                throw new UnprocessableEntityError('This ticket has no respondent to chat with.');
            }
            senderType = 'admin';
        } else {
            resolvedParty = this._resolveParty(ticket, sender);
            senderType = 'user';
        }

        if (!ticket.assignedTo) {
            throw new UnprocessableEntityError('Chat opens once an agent has claimed this ticket.');
        }
        if (CLOSED_STATUSES.includes(ticket.status)) {
            throw new UnprocessableEntityError(`Cannot chat on a ticket that is already ${ticket.status}.`);
        }
        if (!text && (!files || files.length === 0)) {
            throw new UnprocessableEntityError('A message needs text or at least one file.');
        }

        // Files auto-attach as evidence — reuses the existing upload/size
        // checks and suppliedBy resolution rather than duplicating them
        // (spec: "Files sent in chat auto-attach to the ticket as evidence").
        let evidenceRefs = [];
        if (files && files.length > 0) {
            const updatedTicket = await ticketService.addEvidence(ticketId, sender, files);
            evidenceRefs = updatedTicket.evidence.slice(-files.length).map(e => e._id);
        }

        const senderUserId = sender._id || sender.id;
        const participantUserId = resolvedParty === 'raiser' ? ticket.raisedBy.user : ticket.raisedAgainst.user;

        const thread = await TicketChatThread.findOneAndUpdate(
            { ticket: ticketId, party: resolvedParty },
            {
                $setOnInsert: { ticket: ticketId, party: resolvedParty, participantUserId },
                $push: { messages: { sender: senderType, senderUserId, text: text || null, evidenceRefs, at: new Date() } },
                $set: { lastMessageAt: new Date() }
            },
            { upsert: true, new: true }
        );

        // Chat never changes ticket state (spec update) — deliberately no
        // status/SLA write here, unlike addEvidence's own AWAITING_RAISER
        // unpause. That's a separate, unrelated mechanism from Day 2.

        let senderDisplay = null;
        const recipientUserId = senderType === 'admin' ? participantUserId : ticket.assignedTo;
        if (senderType === 'admin') {
            const adminUser = await User.findById(senderUserId).select('name').lean();
            const firstName = (adminUser?.name || 'Agent').split(' ')[0];
            senderDisplay = `${firstName}, HospiLink ${ADMIN_TEAM_LABEL[sender.adminSubRole] || 'Support'}`;
        }

        notificationEmitter.emitChatMessage(ticket, recipientUserId, { text, hasFiles: evidenceRefs.length > 0, senderDisplay })
            .catch(err => console.error('emitChatMessage failed:', err));
        activityLogEmitter.emitTicketActivity(
            ACTIVITY_ACTIONS.TICKET_CHAT_MESSAGE, ticket, { userId: senderUserId, name: sender.name, role: sender.role }, { party: resolvedParty }
        ).catch(err => console.error('emitTicketActivity(TICKET_CHAT_MESSAGE) failed:', err));

        return this._shapeThread(thread, senderType === 'admin' ? 'admin' : 'party');
    }

    async getThread(ticketId, requester, party) {
        const ticket = await Ticket.findById(ticketId).select('raisedBy raisedAgainst queue').lean();
        if (!ticket) throw new NotFoundError('Ticket not found');

        let resolvedParty;
        let viewerType;
        if (requester.role === 'admin') {
            if (!ticketService._canAccessQueue(requester.adminSubRole, ticket.queue)) {
                throw new ForbiddenError("You don't have permission to view this ticket's chat.");
            }
            resolvedParty = party || (ticket.raisedAgainst ? null : 'raiser');
            if (!resolvedParty) {
                throw new UnprocessableEntityError('party is required (raiser or respondent) when this ticket has a respondent.');
            }
            viewerType = 'admin';
        } else {
            resolvedParty = this._resolveParty(ticket, requester);
            viewerType = 'party';
        }

        const thread = await TicketChatThread.findOne({ ticket: ticketId, party: resolvedParty }).lean();
        if (!thread) return { ticket: ticketId, party: resolvedParty, messages: [] };

        return this._shapeThread(thread, viewerType);
    }

    // Internal (admin) view keeps real identities, same as getById's admin
    // branch. Party-facing view redacts any admin sender down to a display
    // name — never the raw senderUserId — mirroring _shapeForRaiser/
    // _shapeForRespondent's "shape at read time" pattern.
    async _shapeThread(thread, viewerType) {
        const plain = thread.toObject ? thread.toObject() : thread;
        if (viewerType === 'admin') return plain;

        const adminIds = [...new Set(
            plain.messages.filter(m => m.sender === 'admin').map(m => m.senderUserId.toString())
        )];
        const admins = adminIds.length
            ? await User.find({ _id: { $in: adminIds } }).select('name adminSubRole').lean()
            : [];
        const adminById = new Map(admins.map(a => [a._id.toString(), a]));

        return {
            ...plain,
            messages: plain.messages.map(m => {
                const { senderUserId, ...rest } = m;
                if (m.sender !== 'admin') return rest;

                const admin = adminById.get(senderUserId.toString());
                const firstName = (admin?.name || 'Agent').split(' ')[0];
                const team = ADMIN_TEAM_LABEL[admin?.adminSubRole] || 'Support';
                return { ...rest, displayName: `${firstName}, HospiLink ${team}` };
            })
        };
    }
}

module.exports = new TicketChatService();
