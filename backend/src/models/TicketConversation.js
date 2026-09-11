const mongoose = require('mongoose');
const { CATEGORIES } = require('../utils/ticket.constants');

// A chat thread exists independently of a Ticket — most chats resolve
// through the bot's own answers and never produce one (spec §06's "what the
// bot may resolve without a ticket"). `ticket` stays null for those; it's
// set once (if ever) at the point a ticket is actually created from this
// conversation.
const messageSchema = new mongoose.Schema({
    sender: { type: String, enum: ['user', 'bot'], required: true },
    text: { type: String, default: null },
    buttons: { type: [String], default: undefined }, // options offered, on a bot turn
    selectedButton: { type: String, default: null },  // which one the user tapped, if any
    evidenceRefs: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    at: { type: Date, default: Date.now }
}, { _id: false });

const ticketConversationSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['staff', 'hospital'], required: true },
    language: { type: String, enum: ['en', 'hi', 'mr'], default: 'en' },

    messages: { type: [messageSchema], default: [] },

    // Stored separately from Ticket.botCategory/botConfidence so the gap
    // between the two is visible even for chats that never became a
    // ticket — "the only honest measure of whether the bot works" per §06.09.
    botCategory: { type: String, enum: CATEGORIES, default: null },
    botConfidence: { type: Number, min: 0, max: 1, default: null },

    ticket: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', default: null },
    status: { type: String, enum: ['active', 'completed', 'abandoned'], default: 'active' }
}, {
    timestamps: true
});

ticketConversationSchema.index({ user: 1, createdAt: -1 });
ticketConversationSchema.index({ ticket: 1 });

const TicketConversation = mongoose.model('TicketConversation', ticketConversationSchema);

module.exports = TicketConversation;
