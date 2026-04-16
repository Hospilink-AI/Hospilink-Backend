const mongoose = require('mongoose');
const { 
    ACTIVITY_ACTIONS, 
    ACTIVITY_CATEGORIES, 
    ACTIVITY_STATUSES 
} = require('../utils/activityLog.constants');

const activityLogSchema = new mongoose.Schema({
    timestamp: {
        type: Date,
        default: Date.now,
        required: true,
        index: true
    },
    actor: {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            index: true
        },
        name: {
            type: String,
            required: true
        },
        role: {
            type: String,
            enum: ['staff', 'hospital', 'admin', 'system'],
            required: true,
            index: true
        },
        email: {
            type: String
        }
    },
    action: {
        type: String,
        enum: Object.values(ACTIVITY_ACTIONS),
        required: true,
        index: true
    },
    category: {
        type: String,
        enum: Object.values(ACTIVITY_CATEGORIES),
        required: true,
        index: true
    },
    target: {
        type: {
            type: String,
            enum: ['duty', 'user', 'document', 'hospital', 'staff', 'review', 'system']
        },
        id: {
            type: mongoose.Schema.Types.ObjectId
        },
        name: {
            type: String
        }
    },
    details: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    location: {
        type: String,
        index: true
    },
    ipAddress: {
        type: String,
        index: true
    },
    userAgent: {
        type: String
    },
    status: {
        type: String,
        enum: Object.values(ACTIVITY_STATUSES),
        required: true,
        default: ACTIVITY_STATUSES.SUCCESS,
        index: true
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    }
}, {
    timestamps: false // We manage timestamp manually
});

// Compound indexes for common query patterns
activityLogSchema.index({ timestamp: -1, category: 1 });
activityLogSchema.index({ timestamp: -1, action: 1 });
activityLogSchema.index({ timestamp: -1, status: 1 });
activityLogSchema.index({ 'actor.userId': 1, timestamp: -1 });
activityLogSchema.index({ 'target.type': 1, 'target.id': 1, timestamp: -1 });
activityLogSchema.index({ category: 1, status: 1, timestamp: -1 });

// Text index for search functionality
activityLogSchema.index({ 
    'actor.name': 'text', 
    'target.name': 'text', 
    location: 'text',
    action: 'text'
});

// TTL index for automatic deletion after retention period (90 days)
activityLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 7776000 }); // 90 days

// Virtual for formatted timestamp
activityLogSchema.virtual('formattedTimestamp').get(function() {
    return this.timestamp.toISOString();
});

// Method to sanitize log before saving (remove sensitive data)
activityLogSchema.methods.sanitize = function() {
    const sensitiveFields = ['password', 'token', 'otp', 'pin'];
    
    if (this.details) {
        sensitiveFields.forEach(field => {
            if (this.details[field]) {
                this.details[field] = '[REDACTED]';
            }
        });
    }
    
    if (this.metadata) {
        sensitiveFields.forEach(field => {
            if (this.metadata[field]) {
                this.metadata[field] = '[REDACTED]';
            }
        });
    }
    
    return this;
};

// Static method to get logs with pagination and filters
activityLogSchema.statics.getFilteredLogs = async function(filters = {}, options = {}) {
    const {
        page = 1,
        limit = 50,
        sortBy = 'timestamp',
        sortOrder = 'desc'
    } = options;

    const query = {};

    // Predefined date ranges
    if (filters.dateRange) {
        if (filters.dateRange === 'today') {
            const start = new Date();
            start.setHours(0, 0, 0, 0);
            query.timestamp = { $gte: start };
        } else if (filters.dateRange === 'lastweek') {
            const start = new Date();
            start.setDate(start.getDate() - 7);
            start.setHours(0, 0, 0, 0);
            query.timestamp = { $gte: start };
        }
    }

    // Custom date range filter (dd-mm-yyyy)
    if (!filters.dateRange && (filters.startDate || filters.endDate)) {
        const parseDate = (str) => {
            const match = str.match(/^(\d{2})-(\d{2})-(\d{4})$/);
            if (match) return new Date(match[3], match[2] - 1, match[1]);
            return new Date(str);
        };
        query.timestamp = {};
        if (filters.startDate) {
            const d = parseDate(filters.startDate);
            d.setHours(0, 0, 0, 0);
            query.timestamp.$gte = d;
        }
        if (filters.endDate) {
            const d = parseDate(filters.endDate);
            d.setHours(23, 59, 59, 999);
            query.timestamp.$lte = d;
        }
    }

    // Category filter
    if (filters.category) {
        query.category = filters.category;
    }

    // Action filter
    if (filters.action) {
        query.action = filters.action;
    }

    // Status filter
    if (filters.status) {
        query.status = filters.status;
    }

    // Actor filter
    if (filters.actorId) {
        query['actor.userId'] = filters.actorId;
    }

    // Role filter
    if (filters.role) {
        query['actor.role'] = filters.role;
    }

    // Target filter
    if (filters.targetId) {
        query['target.id'] = filters.targetId;
    }

    // Location filter
    if (filters.location) {
        query.location = new RegExp(filters.location, 'i');
    }

    // IP address filter
    if (filters.ipAddress) {
        query.ipAddress = filters.ipAddress;
    }

    const skip = (page - 1) * limit;
    const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

    const [logs, total] = await Promise.all([
        this.find(query)
            .sort(sort)
            .limit(limit)
            .skip(skip)
            .lean(),
        this.countDocuments(query)
    ]);

    return {
        logs,
        pagination: {
            currentPage: page,
            totalPages: Math.ceil(total / limit),
            totalLogs: total,
            limit,
            hasNextPage: page < Math.ceil(total / limit),
            hasPrevPage: page > 1
        }
    };
};

// Static method to get activity statistics
activityLogSchema.statics.getStatistics = async function(filters = {}) {
    const query = {};

    // Date range filter
    if (filters.startDate || filters.endDate) {
        query.timestamp = {};
        if (filters.startDate) {
            query.timestamp.$gte = new Date(filters.startDate);
        }
        if (filters.endDate) {
            query.timestamp.$lte = new Date(filters.endDate);
        }
    }

    const [
        totalActivities,
        byCategory,
        byStatus,
        topActions,
        criticalActivities
    ] = await Promise.all([
        // Total count
        this.countDocuments(query),

        // Group by category
        this.aggregate([
            { $match: query },
            { $group: { _id: '$category', count: { $sum: 1 } } },
            { $sort: { count: -1 } }
        ]),

        // Group by status
        this.aggregate([
            { $match: query },
            { $group: { _id: '$status', count: { $sum: 1 } } },
            { $sort: { count: -1 } }
        ]),

        // Top actions
        this.aggregate([
            { $match: query },
            { $group: { _id: '$action', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 10 }
        ]),

        // Recent critical activities
        this.find({ ...query, status: ACTIVITY_STATUSES.CRITICAL })
            .sort({ timestamp: -1 })
            .limit(10)
            .select('timestamp action actor.name status')
            .lean()
    ]);

    return {
        totalActivities,
        byCategory: byCategory.reduce((acc, item) => {
            acc[item._id] = item.count;
            return acc;
        }, {}),
        byStatus: byStatus.reduce((acc, item) => {
            acc[item._id] = item.count;
            return acc;
        }, {}),
        topActions: topActions.map(item => ({
            action: item._id,
            count: item.count
        })),
        criticalActivities
    };
};

const ActivityLog = mongoose.model('ActivityLog', activityLogSchema);

module.exports = ActivityLog;
