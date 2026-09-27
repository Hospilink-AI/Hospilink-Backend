const mongoose = require('mongoose');
const { DOMAINS } = require('../utils/ticket.constants');

// Chatbot intake Phase 4 — the informational-answer content the classifier
// reads from, replacing Phase 1's single hand-written context paragraph.
// A plain growable collection (not SystemConfig's versioned store) — unlike
// SLA/routing rules, an FAQ answer doesn't need point-in-time correctness,
// it just needs to be editable without a deploy.
const knowledgeBaseArticleSchema = new mongoose.Schema({
    question: { type: String, required: true, trim: true, maxlength: 500 },
    answer: { type: String, required: true, trim: true, maxlength: 2000 },
    category: { type: String, enum: [...DOMAINS, 'general'], default: 'general' },
    // Not consulted yet — listActive() returns everything and lets Gemini
    // reason over the full set (see ticketIntentClassifier.service.js).
    // Kept here so a future relevance-ranked retrieval pass has something
    // to key off without a schema migration.
    keywords: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
    // Optional, same as SystemConfig.createdBy — a seed script populating
    // starter content has no real acting admin.
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, {
    timestamps: true
});

knowledgeBaseArticleSchema.index({ isActive: 1, category: 1 });

const KnowledgeBaseArticle = mongoose.model('KnowledgeBaseArticle', knowledgeBaseArticleSchema);

module.exports = KnowledgeBaseArticle;
