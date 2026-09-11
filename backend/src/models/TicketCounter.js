const mongoose = require('mongoose');

// Atomic per-domain-per-month sequence backing Ticket.ticketId
// (HL-<DOM>-<YYMM>-<seq>). A single findOneAndUpdate $inc, so concurrent
// ticket creation never collides or leaves a gap silently swallowed.
const ticketCounterSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true }, // e.g. "DTY-2608"
    seq: { type: Number, default: 0 }
});

const TicketCounter = mongoose.model('TicketCounter', ticketCounterSchema);

module.exports = TicketCounter;
