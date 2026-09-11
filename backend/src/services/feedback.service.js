const PlatformFeedback = require('../models/PlatformFeedback');
const User = require('../models/User');
const Ticket = require('../models/Ticket');
const ticketService = require('./ticket.service');
const { NotFoundError } = require('../middleware/error.middleware');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');

// Keyword heuristic standing in for the spec's "bot's reading" of tone
// (§12) — deliberately not a Gemini call yet. A real classifier belongs
// with the chatbot phase's own intent-classification design (same
// infrastructure, same confidence-threshold thinking); building a second,
// separate AI integration now would just mean redoing it. The admin
// override this feeds (sentimentOverriddenBy) exists specifically to
// compensate for this being a rough first pass.
const SEVERE_WORDS = ['crash', 'crashed', 'crashing', 'broken', "doesn't work", 'not working', 'failed', 'failure', 'stuck', 'frozen', 'freeze'];
const URGENCY_WORDS = ['now', 'right now', "can't", 'cannot', 'urgent', 'immediately', 'blocked', 'blocking'];
const NEGATIVE_WORDS = ['bad', 'slow', 'annoying', 'confusing', 'difficult', 'frustrating', 'issue', 'problem', 'bug'];
const POSITIVE_WORDS = ['great', 'love', 'awesome', 'helpful', 'easy', 'good', 'nice', 'thanks', 'thank you'];

function countMatches(text, words) {
    return words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
}

class FeedbackService {
    _classify(text) {
        const lower = text.toLowerCase();
        const severeHits = countMatches(lower, SEVERE_WORDS);
        const urgencyHits = countMatches(lower, URGENCY_WORDS);
        const negativeHits = countMatches(lower, NEGATIVE_WORDS);
        const positiveHits = countMatches(lower, POSITIVE_WORDS);

        const urgencySignal = urgencyHits > 0 && severeHits > 0;

        let sentiment = 'NEUTRAL';
        if (severeHits > 0) sentiment = 'SEVERE_NEGATIVE';
        else if (negativeHits > positiveHits) sentiment = 'NEGATIVE';
        else if (positiveHits > 0) sentiment = 'POSITIVE';

        return { sentiment, urgencySignal };
    }

    async submit(user, { text, area }) {
        const userId = user._id || user.id;
        const { sentiment, urgencySignal } = this._classify(text);

        const feedback = await PlatformFeedback.create({
            user: userId, role: user.role, text, area, sentiment, urgencySignal
        });

        // spec §12: "someone reporting that OTPs never arrive is reporting
        // an outage, not leaving a review" — auto-convert, and tell the
        // raiser it's been picked up.
        if (sentiment === 'SEVERE_NEGATIVE' && urgencySignal) {
            const fullUser = await User.findById(userId).select('name email');
            const ticket = await ticketService.createTicket(
                { _id: userId, role: user.role, name: fullUser?.name },
                { category: 'platform.app_fault', subjectType: 'NONE', text }
            );
            feedback.convertedToTicket = ticket._id;
            await feedback.save();
        }

        return feedback.toObject();
    }

    async listMine(user) {
        const userId = user._id || user.id;
        return PlatformFeedback.find({ user: userId }).sort({ createdAt: -1 }).lean();
    }

    // Spec update — Support-level access is scoped to their own
    // conversations only. Until live chat exists, "their own" is read as
    // "feedback that auto-converted into a ticket assigned to them"
    // (feedback.submit already does this conversion for severe+urgent
    // feedback) — the closest real signal available today. Operations/Super
    // Admin keep the original unscoped view.
    async listForAdmin(admin, filters, pagination) {
        const { page, limit, skip } = getPaginationParams(pagination.page, pagination.limit);
        const query = {};
        if (filters.area) query.area = filters.area;
        if (filters.sentiment) query.sentiment = filters.sentiment;

        if (admin.adminSubRole === 'tech_support') {
            const adminId = admin._id || admin.id;
            const myTickets = await Ticket.find({ assignedTo: adminId }).select('_id').lean();
            query.convertedToTicket = { $in: myTickets.map(t => t._id) };
        }

        const [feedback, total] = await Promise.all([
            PlatformFeedback.find(query).sort({ sentiment: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
            PlatformFeedback.countDocuments(query)
        ]);

        return { feedback, pagination: getPaginationMeta(total, page, limit) };
    }

    async overrideSentiment(feedbackId, admin, sentiment) {
        const adminId = admin._id || admin.id;
        const feedback = await PlatformFeedback.findByIdAndUpdate(
            feedbackId,
            { sentiment, sentimentOverriddenBy: adminId },
            { new: true }
        );
        if (!feedback) throw new NotFoundError('Feedback not found');
        return feedback.toObject();
    }
}

module.exports = new FeedbackService();
