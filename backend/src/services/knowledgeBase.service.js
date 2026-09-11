const KnowledgeBaseArticle = require('../models/KnowledgeBaseArticle');
const cacheService = require('./cache.service');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const { NotFoundError } = require('../middleware/error.middleware');

const CACHE_KEY = 'chatbot:knowledgeBase:active';
const CACHE_TTL_SECONDS = 300;

class KnowledgeBaseService {
    // Read on every chatbot turn (ticketIntentClassifier.service.js), so
    // cached the same way systemConfig.service.js caches its own hot reads.
    async listActive() {
        const cached = await cacheService.get(CACHE_KEY);
        if (cached !== null) return cached;

        const articles = await KnowledgeBaseArticle.find({ isActive: true })
            .select('question answer category')
            .sort({ category: 1, createdAt: 1 })
            .lean();

        await cacheService.set(CACHE_KEY, articles, CACHE_TTL_SECONDS);
        return articles;
    }

    async _invalidate() {
        await cacheService.del(CACHE_KEY);
    }

    async create(admin, { question, answer, category, keywords }) {
        const adminId = admin?._id || admin?.id || null;
        const article = await KnowledgeBaseArticle.create({
            question, answer, category, keywords: keywords || [], createdBy: adminId
        });
        await this._invalidate();
        return article.toObject();
    }

    async update(id, admin, { question, answer, category, keywords }) {
        const adminId = admin?._id || admin?.id || null;
        const article = await KnowledgeBaseArticle.findById(id);
        if (!article) throw new NotFoundError('Knowledge base article not found');

        if (question !== undefined) article.question = question;
        if (answer !== undefined) article.answer = answer;
        if (category !== undefined) article.category = category;
        if (keywords !== undefined) article.keywords = keywords;
        article.updatedBy = adminId;
        await article.save();

        await this._invalidate();
        return article.toObject();
    }

    async setActive(id, admin, isActive) {
        const adminId = admin?._id || admin?.id || null;
        const article = await KnowledgeBaseArticle.findByIdAndUpdate(
            id, { isActive, updatedBy: adminId }, { new: true }
        );
        if (!article) throw new NotFoundError('Knowledge base article not found');

        await this._invalidate();
        return article.toObject();
    }

    async list(filters, pagination) {
        const { page, limit, skip } = getPaginationParams(pagination.page, pagination.limit);
        const query = {};
        if (filters.category) query.category = filters.category;
        if (filters.isActive !== undefined) query.isActive = filters.isActive;

        const [articles, total] = await Promise.all([
            KnowledgeBaseArticle.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
            KnowledgeBaseArticle.countDocuments(query)
        ]);

        return { articles, pagination: getPaginationMeta(total, page, limit) };
    }

    async getById(id) {
        const article = await KnowledgeBaseArticle.findById(id).lean();
        if (!article) throw new NotFoundError('Knowledge base article not found');
        return article;
    }
}

module.exports = new KnowledgeBaseService();
