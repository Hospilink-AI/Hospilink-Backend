const mongoose = require('mongoose');

// One thread per (ticket, party) — DB-enforced via the unique index below,
// not just a convention, so "separate threads, never a joint one" (spec
// update) can't accidentally be violated by a race between two upserts.
const chatMessageSchema = new mongoose.Schema({
    sender: { type: String, enum: ['user', 'admin'], required: true },
    senderUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, default: null },
    // Ticket.evidence _ids for any files sent alongside this message — the
    // files themselves are uploaded via the existing ticketService.addEvidence,
    // not duplicated here.
    evidenceRefs: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    at: { type: Date, default: Date.now }
}, { _id: false });

// Distinct from TicketConversation — that model is the chatbot's own
// pre-ticket intake thread (sender: 'user'|'bot'), unrelated to this
// post-claim, two-party admin<->raiser / admin<->respondent chat.
const ticketChatThreadSchema = new mongoose.Schema({
    ticket: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', required: true },
    party: { type: String, enum: ['raiser', 'respondent'], required: true },
    participantUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    messages: { type: [chatMessageSchema], default: [] },
    lastMessageAt: { type: Date, default: null }
}, {
    timestamps: true
});

ticketChatThreadSchema.index({ ticket: 1, party: 1 }, { unique: true });
ticketChatThreadSchema.index({ participantUserId: 1, lastMessageAt: -1 });

module.exports = mongoose.model('TicketChatThread', ticketChatThreadSchema);
