// Notifications: support tickets, disputes, rating penalties and suspension patterns
// Methods of NotificationEmitter; mixed into the class in ../notificationEmitter.js, so `this` is the service.
const notificationService = require('../notificationService');
const notificationDelivery = require('../notificationDelivery.service');
const { humanizeTicketCategory } = require('./helpers');

module.exports = {
    // spec §13's first notification row: raiser gets the ticket ID and the
    // published SLA date — deliberately no minute-level ETA.
    async emitTicketCreated(ticket) {
        try {
            const payload = {
                type: 'TICKET_CREATED',
                ticket: { id: ticket._id, ticketId: ticket.ticketId },
                message: `Your ticket ${ticket.ticketId} has been received. We'll get back to you by ${new Date(ticket.slaDecideBy).toLocaleDateString()}.`,
                timestamp: new Date().toISOString()
            };
            const recipient = ticket.raisedBy.user;
            const { unreadCount } = await notificationService.createNotificationWithCount(recipient, 'TICKET_CREATED', payload);
            await notificationDelivery.deliverToUser(recipient, 'TICKET_CREATED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting ticket-created notification:', error);
        }
    },

    // spec §13: "Recategorised → Raiser, only where it changes what happens
    // next" — the caller (ticket.service#recategorize) only invokes this
    // when the route/class actually differs from before.
    async emitTicketRecategorized(ticket, oldCategory) {
        try {
            const payload = {
                type: 'TICKET_RECATEGORIZED',
                ticket: { id: ticket._id, ticketId: ticket.ticketId },
                oldCategory,
                newCategory: ticket.category,
                message: `Your ticket ${ticket.ticketId} was recategorised, which may change who handles it and when you'll hear back.`,
                timestamp: new Date().toISOString()
            };
            const recipient = ticket.raisedBy.user;
            const { unreadCount } = await notificationService.createNotificationWithCount(recipient, 'TICKET_RECATEGORIZED', payload);
            await notificationDelivery.deliverToUser(recipient, 'TICKET_RECATEGORIZED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting ticket-recategorized notification:', error);
        }
    },

    // spec §08.01/§13 — fires immediately at creation for ADJUDICATED
    // tickets, independent of any agent claiming it. Deliberately never
    // includes the raiser's exact words or contact details — only the
    // category and the deadline.
    async emitClaimExists(ticket) {
        try {
            const isLive = ticket.respondentDeadline &&
                (ticket.respondentDeadline.getTime() - ticket.respondentNotifiedAt.getTime()) <= 2 * 60 * 60 * 1000;
            const payload = {
                type: 'TICKET_CLAIM_EXISTS',
                ticket: { id: ticket._id, ticketId: ticket.ticketId, category: ticket.category },
                message: isLive
                    ? `A claim has been raised regarding ${ticket.category.replace('.', ' — ')}. Because this concerns a shift happening now, please respond within 2 hours.`
                    : `A claim has been raised regarding ${ticket.category.replace('.', ' — ')}. You have until ${new Date(ticket.respondentDeadline).toLocaleString()} to respond.`,
                respondentDeadline: ticket.respondentDeadline,
                timestamp: new Date().toISOString()
            };
            const recipient = ticket.raisedAgainst.user;
            const { unreadCount } = await notificationService.createNotificationWithCount(recipient, 'TICKET_CLAIM_EXISTS', payload);
            await notificationDelivery.deliverToUser(recipient, 'TICKET_CLAIM_EXISTS', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting claim-exists notification:', error);
        }
    },

    // spec §13 — "Response window closing → Respondent, at half the window
    // and again at two hours remaining."
    async emitResponseWindowClosing(ticket, label) {
        try {
            const payload = {
                type: 'TICKET_RESPONSE_WINDOW_CLOSING',
                ticket: { id: ticket._id, ticketId: ticket.ticketId },
                message: `You have ${label} left to respond to the claim on ticket ${ticket.ticketId}.`,
                respondentDeadline: ticket.respondentDeadline,
                timestamp: new Date().toISOString()
            };
            const recipient = ticket.raisedAgainst.user;
            const { unreadCount } = await notificationService.createNotificationWithCount(recipient, 'TICKET_RESPONSE_WINDOW_CLOSING', payload);
            await notificationDelivery.deliverToUser(recipient, 'TICKET_RESPONSE_WINDOW_CLOSING', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting response-window-closing notification:', error);
        }
    },

    // spec §13: "Outcome decided → Both parties, the action-taken
    // statement, in the recipient's language." Same statement to both
    // sides — only the notification's framing differs by recipient role.
    async emitTicketOutcomeDecided(ticket) {
        try {
            const recipients = [ticket.raisedBy.user];
            if (ticket.raisedAgainst?.user) recipients.push(ticket.raisedAgainst.user);

            await Promise.all(recipients.map(async (recipient) => {
                const payload = {
                    type: 'TICKET_OUTCOME_DECIDED',
                    ticket: { id: ticket._id, ticketId: ticket.ticketId },
                    resolutionOutcome: ticket.resolutionOutcome,
                    statement: ticket.actionTakenStatement,
                    message: ticket.actionTakenStatement,
                    timestamp: new Date().toISOString()
                };
                const { unreadCount } = await notificationService.createNotificationWithCount(recipient, 'TICKET_OUTCOME_DECIDED', payload);
                await notificationDelivery.deliverToUser(recipient, 'TICKET_OUTCOME_DECIDED', payload, unreadCount);
            }));
        } catch (error) {
            console.error('Error emitting ticket-outcome-decided notification:', error);
        }
    },

    // Day 2 spec update — an admin asked the raiser for more detail before
    // going further. Mirrors emitClaimExists's shape, but to the raiser
    // instead of the respondent, and with the admin's actual question
    // rather than a fixed category-based message.
    async emitInfoRequested(ticket, message) {
        try {
            const payload = {
                type: 'TICKET_INFO_REQUESTED',
                ticket: { id: ticket._id, ticketId: ticket.ticketId },
                message: `More information is needed on your ticket ${ticket.ticketId}: ${message}`,
                timestamp: new Date().toISOString()
            };
            const recipient = ticket.raisedBy.user;
            const { unreadCount } = await notificationService.createNotificationWithCount(recipient, 'TICKET_INFO_REQUESTED', payload);
            await notificationDelivery.deliverToUser(recipient, 'TICKET_INFO_REQUESTED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting info-requested notification:', error);
        }
    },

    // Day 2 spec update — day-1/day-3 nudges while a ticket sits in
    // AWAITING_RAISER, ahead of the 5-day auto-close. Mirrors
    // emitResponseWindowClosing exactly, just to the raiser.
    async emitInfoRequestReminder(ticket, label) {
        try {
            const payload = {
                type: 'TICKET_INFO_REQUEST_REMINDER',
                ticket: { id: ticket._id, ticketId: ticket.ticketId },
                message: `We still need more information on your ticket ${ticket.ticketId} (asked ${label}). Reply soon or it will be automatically closed.`,
                timestamp: new Date().toISOString()
            };
            const recipient = ticket.raisedBy.user;
            const { unreadCount } = await notificationService.createNotificationWithCount(recipient, 'TICKET_INFO_REQUEST_REMINDER', payload);
            await notificationDelivery.deliverToUser(recipient, 'TICKET_INFO_REQUEST_REMINDER', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting info-request-reminder notification:', error);
        }
    },

    // Day 3 spec update — a chat message on a ticket, pushed to whichever
    // side didn't send it. Reuses the exact same online/offline routing
    // every other ticket notification already goes through
    // (notificationDelivery.deliverToUser), which is what "reusing existing
    // Socket.IO infrastructure" means here — no bespoke push path.
    async emitChatMessage(ticket, recipientUserId, { text, hasFiles, senderDisplay }) {
        try {
            const preview = text
                ? (text.length > 80 ? `${text.slice(0, 80)}…` : text)
                : (hasFiles ? 'Sent a file' : '');
            const payload = {
                type: 'TICKET_CHAT_MESSAGE',
                ticket: { id: ticket._id, ticketId: ticket.ticketId },
                message: senderDisplay
                    ? `New message from ${senderDisplay} on ticket ${ticket.ticketId}: ${preview}`
                    : `New message on ticket ${ticket.ticketId}: ${preview}`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(recipientUserId, 'TICKET_CHAT_MESSAGE', payload);
            await notificationDelivery.deliverToUser(recipientUserId, 'TICKET_CHAT_MESSAGE', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting chat-message notification:', error);
        }
    },

    // spec §13: "Appeal outcome → Appellant, Fresh statement." Only the
    // appellant — the appeal's respondent already gets the standard
    // TICKET_OUTCOME_DECIDED notification when the appeal ticket resolves.
    async emitAppealOutcome(appealTicket) {
        try {
            const payload = {
                type: 'TICKET_APPEAL_OUTCOME',
                ticket: { id: appealTicket._id, ticketId: appealTicket.ticketId },
                appealOf: appealTicket.appealOf,
                resolutionOutcome: appealTicket.resolutionOutcome,
                statement: appealTicket.actionTakenStatement,
                message: appealTicket.actionTakenStatement,
                timestamp: new Date().toISOString()
            };
            const recipient = appealTicket.raisedBy.user;
            const { unreadCount } = await notificationService.createNotificationWithCount(recipient, 'TICKET_APPEAL_OUTCOME', payload);
            await notificationDelivery.deliverToUser(recipient, 'TICKET_APPEAL_OUTCOME', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting appeal-outcome notification:', error);
        }
    },

    // TICKET_OUTCOME_DECIDED's own statement only ever says "Action taken:
    // apply rating penalty" — same generic wording regardless of category or
    // point value, sent identically to both parties, so the respondent can't
    // tell from it alone that THEY'RE the one who lost points. This is the
    // specific one, to the respondent only.
    async emitRatingPenaltyApplied(ticket, points) {
        try {
            const recipient = ticket.raisedAgainst.user;
            const payload = {
                type: 'RATING_PENALTY_APPLIED',
                ticket: { id: ticket._id, ticketId: ticket.ticketId },
                category: ticket.category,
                points,
                message: `A ${points}-point rating penalty was applied to your account following ticket ${ticket.ticketId} (${humanizeTicketCategory(ticket.category)}). You can appeal this from the ticket.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(recipient, 'RATING_PENALTY_APPLIED', payload);
            await notificationDelivery.deliverToUser(recipient, 'RATING_PENALTY_APPLIED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting rating-penalty-applied notification:', error);
        }
    },

    // The appellant already gets emitAppealOutcome's generic statement; this
    // adds the specifics (category, points). The ORIGINAL ticket's raiser —
    // whoever's complaint the penalty came from, and who benefited from it
    // existing — otherwise gets no notice at all that it's been reversed;
    // included here as a second recipient when different from the appellant.
    async emitRatingPenaltyReversed(appealTicket, originalTicket, points) {
        try {
            const appellantId = appealTicket.raisedBy.user.toString();
            const recipients = [appealTicket.raisedBy.user];
            if (originalTicket?.raisedBy?.user && originalTicket.raisedBy.user.toString() !== appellantId) {
                recipients.push(originalTicket.raisedBy.user);
            }

            await Promise.all(recipients.map(async (recipient) => {
                const isAppellant = recipient.toString() === appellantId;
                const payload = {
                    type: 'RATING_PENALTY_REVERSED',
                    ticket: { id: appealTicket._id, ticketId: appealTicket.ticketId },
                    category: appealTicket.category,
                    points,
                    message: isAppellant
                        ? `Your appeal succeeded — the ${points}-point rating penalty from this dispute has been reversed.`
                        : `A rating penalty related to a case you raised (ticket ${originalTicket.ticketId}) has been reversed on appeal.`,
                    timestamp: new Date().toISOString()
                };
                const { unreadCount } = await notificationService.createNotificationWithCount(recipient, 'RATING_PENALTY_REVERSED', payload);
                await notificationDelivery.deliverToUser(recipient, 'RATING_PENALTY_REVERSED', payload, unreadCount);
            }));
        } catch (error) {
            console.error('Error emitting rating-penalty-reversed notification:', error);
        }
    },

    // spec §13: "Pattern flag raised → Flagged party, the specific cases
    // relied on." Never a shadow record (§10.04).
    async emitPatternFlagRaised(flag) {
        try {
            const payload = {
                type: 'PATTERN_FLAG_RAISED',
                flag: { id: flag._id, patternType: flag.patternType },
                casesRelied: flag.casesRelied,
                message: `A pattern has been flagged on your account (${flag.patternType.replace(/_/g, ' ')}), based on ${flag.casesRelied.length} case(s). You can review the specific cases in your account.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(flag.party, 'PATTERN_FLAG_RAISED', payload);
            await notificationDelivery.deliverToUser(flag.party, 'PATTERN_FLAG_RAISED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting pattern-flag-raised notification:', error);
        }
    },

    // spec §13: "Suspension proposed → Proposed party, reasons, the 14-day
    // window, and how to respond."
    async emitSuspensionProposed(flag) {
        try {
            const payload = {
                type: 'SUSPENSION_PROPOSED',
                flag: { id: flag._id, patternType: flag.patternType },
                casesRelied: flag.casesRelied,
                responseDeadline: flag.proposal?.responseDeadline,
                message: `A suspension has been proposed on your account based on ${flag.casesRelied.length} case(s). You have until ${new Date(flag.proposal?.responseDeadline).toLocaleDateString()} to respond.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(flag.party, 'SUSPENSION_PROPOSED', payload);
            await notificationDelivery.deliverToUser(flag.party, 'SUSPENSION_PROPOSED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting suspension-proposed notification:', error);
        }
    },

    async emitSuspensionDecided(flag) {
        try {
            const payload = {
                type: 'SUSPENSION_DECIDED',
                flag: { id: flag._id, patternType: flag.patternType },
                decision: flag.proposal?.decision,
                decisionReason: flag.proposal?.decisionReason,
                message: flag.proposal?.decision === 'suspend'
                    ? `Your account has been suspended. Reason: ${flag.proposal.decisionReason}`
                    : `The proposed suspension on your account was not upheld. Reason: ${flag.proposal?.decisionReason || ''}`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(flag.party, 'SUSPENSION_DECIDED', payload);
            await notificationDelivery.deliverToUser(flag.party, 'SUSPENSION_DECIDED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting suspension-decided notification:', error);
        }
    }
};
