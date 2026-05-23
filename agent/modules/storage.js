/**
 * CONVERTED TO COMMONJS for backend compatibility
 */
/**
 * Storage Module - Production-grade MongoDB operations
 * Optimized for high concurrency with connection pooling and bulk operations
 */
const mongoose = require('mongoose');
const config = require('../utils/config');
const logger = require('../utils/logger');
const { invalidateStatsCache, invalidateJobsCache } = require('../utils/cache');

const jobSchema = new mongoose.Schema({
    role: { type: String, index: true },
    location: { type: String, index: true },
    hospital_name: { type: String, index: true },
    emails: [String],
    phones: [String],
    whatsapp: String,
    hr_contact: String,
    salary: String,
    salary_min: Number,
    salary_max: Number,
    job_description: String,
    apply_link: String,
    source_url: { type: String, unique: true, index: true },
    posted_date: String,
    search_query: String,

    scraped_at: { type: Date, default: Date.now, index: true, expires: 7 * 24 * 60 * 60 }, // 7 days TTL
    updated_at: { type: Date, default: Date.now },
    is_active: { type: Boolean, default: true, index: true },
    stale: { type: Boolean, default: false, index: true },
    retired: { type: Boolean, default: false },

    validated: { type: Boolean, default: false },
    confidence_score: Number,
    outreach_status: { type: String, enum: ['ready', 'partial', 'no_direct_outreach'], default: 'no_direct_outreach', index: true },
    urgency: String,
    shift_type: String,
    experience_level: String,
    ranking_score: Number,
    enriched_emails: Boolean,
    enriched_phones: Boolean,
    coordinates: {
        latitude: { type: Number },
        longitude: { type: Number }
    }
}, {
    timestamps: false
});

jobSchema.index({
    hospital_name: 'text',
    role: 'text',
    location: 'text',
    job_description: 'text'
});

jobSchema.index({ coordinates: 1 });
jobSchema.index({ is_active: 1, scraped_at: -1 });
jobSchema.index({ role: 1, location: 1, is_active: 1 });
jobSchema.index({ outreach_status: 1, is_active: 1 });
jobSchema.index({ is_active: 1, role: 1, location: 1 }); // For filtered queries
jobSchema.index({ hospital_name: 'text', role: 'text', location: 'text' }); // Text search indexes

const Job = mongoose.model('Job', jobSchema);

let isConnected = false;
let connectionPromise = null;

let inMemoryJobs = [];
const MAX_IN_MEMORY_JOBS = 10000;

async function connect() {
    // Check if MongoDB is already connected
    if (mongoose.connection.readyState === 1) {
        logger.info('MongoDB already connected');
        isConnected = true;
        return true;
    }

    // Check if main app connection exists and reuse it
    if (mongoose.connection.readyState !== 0 && mongoose.connection.name) {
        logger.info('Reusing existing MongoDB connection from main app');
        isConnected = true;
        return true;
    }

    if (isConnected) return true;
    if (connectionPromise) return connectionPromise;

    connectionPromise = (async () => {
        try {
            // Agent establishes its own MongoDB connection
            const mongoConfig = {
                dbName: "Hospilink",
                maxPoolSize: config.mongodb?.poolSize || 10,
                minPoolSize: 5,
                serverSelectionTimeoutMS: config.mongodb?.serverSelectionTimeoutMS || 10000,
                socketTimeoutMS: config.mongodb?.socketTimeoutMS || 45000,
                maxIdleTimeMS: config.mongodb?.maxIdleTimeMS || 30000,
                retryWrites: true,
                retryReads: true,
                bufferCommands: false
            };

            mongoose.connection.on('connected', () => {
                logger.info('Agent MongoDB connected');
                isConnected = true;
            });

            mongoose.connection.on('disconnected', () => {
                logger.warn('Agent MongoDB disconnected');
                isConnected = false;
            });

            mongoose.connection.on('error', (err) => {
                logger.error('Agent MongoDB error', { error: err.message });
            });

            mongoose.connection.on('reconnected', () => {
                logger.info('Agent MongoDB reconnected');
                isConnected = true;
            });

            await mongoose.connect(config.mongodbUri, mongoConfig);
            isConnected = true;

            logger.info('Agent connected to MongoDB', {
                host: mongoose.connection.host,
                database: mongoose.connection.name,
                poolSize: mongoConfig.maxPoolSize
            });

            return true;

        } catch (error) {
            logger.warn('Agent MongoDB connection failed - using in-memory mode', { error: error.message });
            isConnected = false;
            return false;
        } finally {
            connectionPromise = null;
        }
    })();

    return connectionPromise;
}

async function disconnect() {
    if (!isConnected) return;

    try {
        await mongoose.disconnect();
        isConnected = false;
        logger.info('Disconnected from MongoDB');
    } catch (error) {
        logger.error('Error disconnecting from MongoDB', { error: error.message });
    }
}

function getConnectionStatus() {
    const readyState = mongoose.connection.readyState;
    return {
        isConnected: readyState === 1,  // Always derive from mongoose, not stale local var
        readyState,
        host: mongoose.connection.host,
        name: mongoose.connection.name
    };
}

async function storeJobs(jobs, searchQuery, options = {}) {
    if (!jobs || jobs.length === 0) return { inserted: 0, updated: 0, errors: 0 };

    logger.info(`Storing ${jobs.length} jobs`);
    const now = new Date();

    // Ensure we're connected to MongoDB before storing
    await connect();

    if (!isConnected) {
        logger.warn('MongoDB not connected, using in-memory storage');
        return storeJobsInMemory(jobs, searchQuery, now);
    }

    return storeJobsMongoDB(jobs, searchQuery, now);
}

function storeJobsInMemory(jobs, searchQuery, now) {
    let inserted = 0;
    let updated = 0;

    for (const job of jobs) {
        const jobData = {
            ...job,
            search_query: searchQuery,
            updated_at: now,
            is_active: true,
            stale: false
        };

        const existingIndex = inMemoryJobs.findIndex(j => j.source_url === job.source_url);
        if (existingIndex >= 0) {
            inMemoryJobs[existingIndex] = {
                ...inMemoryJobs[existingIndex],
                ...jobData,
                scraped_at: inMemoryJobs[existingIndex].scraped_at
            };
            updated++;
        } else {
            inMemoryJobs.unshift({
                ...jobData,
                scraped_at: now,
                _id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
            });
            inserted++;

            if (inMemoryJobs.length > MAX_IN_MEMORY_JOBS) {
                inMemoryJobs = inMemoryJobs.slice(0, MAX_IN_MEMORY_JOBS);
            }
        }
    }

    logger.info('Storage completed (in-memory)', { inserted, updated });
    return { inserted, updated, errors: 0 };
}

async function storeJobsMongoDB(jobs, searchQuery, now) {
    let inserted = 0;
    let updated = 0;
    let errors = 0;

    const bulkOps = jobs.map(job => ({
        updateOne: {
            filter: { source_url: job.source_url },
            update: {
                $set: {
                    ...job,
                    search_query: searchQuery,
                    updated_at: now,
                    is_active: true,
                    stale: false
                },
                $setOnInsert: { scraped_at: now }
            },
            upsert: true
        }
    }));

    const BATCH_SIZE = 100;
    for (let i = 0; i < bulkOps.length; i += BATCH_SIZE) {
        const batch = bulkOps.slice(i, i + BATCH_SIZE);

        try {
            const result = await Job.bulkWrite(batch, { ordered: false });
            inserted += result.upsertedCount || 0;
            updated += result.modifiedCount || 0;
        } catch (error) {
            if (error.writeErrors) {
                errors += error.writeErrors.length;
                inserted += error.result?.nUpserted || 0;
                updated += error.result?.nModified || 0;
            } else {
                logger.error('Bulk write failed', { error: error.message });
                errors += batch.length;
            }
        }
    }

    await Promise.all([invalidateStatsCache(), invalidateJobsCache()]).catch(() => { });

    logger.info('Storage completed (MongoDB bulk)', { inserted, updated, errors });
    return { inserted, updated, errors };
}

async function getJobs(criteria = {}, limit = 100, skip = 0) {
    if (!isConnected) {
        let jobs = [...inMemoryJobs];

        if (criteria.validated === true) {
            jobs = jobs.filter(j => j.validated);
        }
        if (typeof criteria.is_active !== 'undefined') {
            jobs = jobs.filter(j => j.is_active === criteria.is_active);
        }
        if (typeof criteria.stale !== 'undefined') {
            jobs = jobs.filter(j => j.stale === criteria.stale);
        }
        if (criteria.role) {
            jobs = jobs.filter(j => j.role?.toLowerCase().includes(criteria.role.toLowerCase()));
        }
        if (criteria.location) {
            jobs = jobs.filter(j => j.location?.toLowerCase().includes(criteria.location.toLowerCase()));
        }

        return jobs.slice(skip, skip + limit);
    }

    return Job.find(criteria)
        .sort({ scraped_at: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .maxTimeMS(5000)             // add 5 sec timeout
        .exec();
}

async function getJobById(id) {
    if (!isConnected) {
        return inMemoryJobs.find(j => j._id === id) || null;
    }

    return Job.findById(id).lean().exec();
}

async function searchJobs(searchText, limit = 100) {
    if (!searchText) {
        return getJobs({ is_active: true }, limit);
    }

    if (!isConnected) {
        const lowerSearch = searchText.toLowerCase();
        return inMemoryJobs.filter(job =>
            job.is_active !== false &&
            ((job.role && job.role.toLowerCase().includes(lowerSearch)) ||
                (job.location && job.location.toLowerCase().includes(lowerSearch)) ||
                (job.hospital_name && job.hospital_name.toLowerCase().includes(lowerSearch)))
        ).slice(0, limit);
    }

    return Job.find({
        $text: { $search: searchText },
        is_active: true
    })
        .sort({ score: { $meta: 'textScore' } })
        .limit(limit)
        .lean()
        .exec();
}

async function getStats() {
    if (!isConnected) {
        const activeJobs = inMemoryJobs.filter(j => j.is_active !== false);
        return {
            total: activeJobs.length,
            validated: activeJobs.filter(j => j.validated).length,
            withEmail: activeJobs.filter(j => j.emails?.length > 0).length,
            withPhone: activeJobs.filter(j => j.phones?.length > 0).length,
            withBoth: activeJobs.filter(j => j.emails?.length > 0 && j.phones?.length > 0).length,
            inactive: inMemoryJobs.filter(j => j.is_active === false).length,
            ready: activeJobs.filter(j => j.outreach_status === 'ready').length
        };
    }

    const [total, validated, withEmail, withPhone, withBoth, inactive, ready] = await Promise.all([
        Job.countDocuments({ is_active: true }),
        Job.countDocuments({ is_active: true, validated: true }),
        Job.countDocuments({ is_active: true, 'emails.0': { $exists: true } }),
        Job.countDocuments({ is_active: true, 'phones.0': { $exists: true } }),
        Job.countDocuments({
            is_active: true,
            'emails.0': { $exists: true },
            'phones.0': { $exists: true }
        }),
        Job.countDocuments({ is_active: false }),
        Job.countDocuments({ is_active: true, outreach_status: 'ready' })
    ]);

    return { total, validated, withEmail, withPhone, withBoth, inactive, ready };
}

async function getDetailedStats() {
    if (!isConnected) {
        return getStats();
    }

    const [basicStats, roleStats, locationStats, recentJobs] = await Promise.all([
        getStats(),
        Job.aggregate([
            { $match: { is_active: true } },
            { $group: { _id: '$role', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 10 }
        ]),
        Job.aggregate([
            { $match: { is_active: true } },
            { $group: { _id: '$location', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 10 }
        ]),
        Job.countDocuments({
            is_active: true,
            scraped_at: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
        })
    ]);

    return {
        ...basicStats,
        recentJobs24h: recentJobs,
        topRoles: roleStats.map(r => ({ role: r._id, count: r.count })),
        topLocations: locationStats.map(l => ({ location: l._id, count: l.count }))
    };
}

async function cleanOldJobs(days = 7) {
    if (!isConnected) {
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const before = inMemoryJobs.length;
        inMemoryJobs = inMemoryJobs.filter(j => j.scraped_at > cutoff);
        return before - inMemoryJobs.length;
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const result = await Job.deleteMany({
        scraped_at: { $lt: cutoffDate }
    });

    if (result.deletedCount > 0) {
        await Promise.all([invalidateStatsCache(), invalidateJobsCache()]).catch(() => { });
        logger.info(`Cleaned ${result.deletedCount} old jobs`);
    }

    return result.deletedCount;
}

async function markJobsInactive(days = config.inactiveDays || 7) {
    if (!isConnected) {
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        let count = 0;
        for (const job of inMemoryJobs) {
            if (job.scraped_at < cutoff && job.is_active) {
                job.is_active = false;
                count++;
            }
        }
        return count;
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const result = await Job.updateMany(
        {
            scraped_at: { $lt: cutoffDate },
            is_active: true
        },
        {
            $set: { is_active: false }
        }
    );

    if (result.modifiedCount > 0) {
        await invalidateStatsCache().catch(() => { });
        logger.info(`Marked ${result.modifiedCount} jobs as inactive (older than ${days} days)`);
    }

    return result.modifiedCount;
}

async function clearAllJobs() {
    if (!isConnected) {
        inMemoryJobs = [];
        return { deletedCount: 0, message: 'Cleared in-memory jobs' };
    }

    try {
        const result = await Job.deleteMany({});
        await Promise.all([invalidateStatsCache(), invalidateJobsCache()]).catch(() => { });
        logger.info(`Cleared all jobs from database (${result.deletedCount} documents)`);
        return { deletedCount: result.deletedCount };
    } catch (error) {
        logger.error('Failed to clear database', { error: error.message });
        throw error;
    }
}

async function updateJobOutreachStatus(jobId, status) {
    if (!isConnected) {
        const job = inMemoryJobs.find(j => j._id === jobId);
        if (job) {
            job.outreach_status = status;
            return job;
        }
        return null;
    }

    return Job.findByIdAndUpdate(
        jobId,
        { $set: { outreach_status: status, updated_at: new Date() } },
        { new: true }
    ).lean().exec();
}

function isDbConnected() {
    return isConnected;
}

module.exports = {
    connect,
    disconnect,
    getConnectionStatus,
    storeJobs,
    getJobs,
    getJobById,
    searchJobs,
    getStats,
    getDetailedStats,
    cleanOldJobs,
    clearAllJobs,
    markJobsInactive,
    updateJobOutreachStatus,
    isDbConnected,
    Job,
    isConnected,
    inMemoryJobs
};