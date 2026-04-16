const activityLogService = require('./activityLog.service');
const { ACTIVITY_ACTIONS } = require('../utils/activityLog.constants');

/**
 * Activity Log Emitter
 * Provides convenient methods to emit activity logs from different parts of the application
 */
class ActivityLogEmitter {
    /**
     * Emit duty activity
     * @param {string} action - Activity action
     * @param {Object} duty - Duty object
     * @param {Object} actor - Actor information
     * @param {Object} details - Additional details
     * @param {Object} req - Express request object
     */
    async emitDutyActivity(action, duty, actor, details = {}, req = null) {
        try {
            // Validate inputs
            if (!duty) {
                console.error('emitDutyActivity: duty is null or undefined');
                return null;
            }
            if (!actor) {
                console.error('emitDutyActivity: actor is null or undefined');
                return null;
            }
            if (!action) {
                console.error('emitDutyActivity: action is null or undefined');
                return null;
            }
            
            // Ensure duty ID is properly extracted and converted to string
            const dutyId = duty._id?.toString() || duty.id?.toString() || null;
            
            const targetData = {
                type: 'duty',
                id: dutyId,
                name: dutyId ? `Duty #${dutyId.slice(-6)}` : 'Duty'
            };
            
            const activityDetails = {
                dutyId: dutyId,
                staffRole: duty.staffRole,
                date: duty.date,
                startTime: duty.startTime,
                endTime: duty.endTime,
                urgency: duty.urgency,
                ...details
            };
            
            const options = {
                location: duty.hospital?.hospitalLegalName || duty.hospital?.name || details.location
            };
            
            return await activityLogService.logActivity(
                actor,
                action,
                targetData,
                activityDetails,
                req,
                options
            );
        } catch (error) {
            console.error('Error emitting duty activity:', error);
            console.error('Duty:', duty);
            console.error('Actor:', actor);
            console.error('Action:', action);
            return null;
        }
    }

    /**
     * Emit user activity
     * @param {string} action - Activity action
     * @param {Object} user - User object
     * @param {Object} actor - Actor information (can be same as user or admin)
     * @param {Object} details - Additional details
     * @param {Object} req - Express request object
     */
    async emitUserActivity(action, user, actor, details = {}, req = null) {
        try {
            const targetData = {
                type: 'user',
                id: user._id || user.id,
                name: user.name || user.email
            };
            
            const activityDetails = {
                userId: user._id || user.id,
                userRole: user.role,
                email: user.email,
                ...details
            };
            
            return await activityLogService.logActivity(
                actor,
                action,
                targetData,
                activityDetails,
                req
            );
        } catch (error) {
            console.error('Error emitting user activity:', error);
            return null;
        }
    }

    /**
     * Emit document activity
     * @param {string} action - Activity action
     * @param {Object} document - Document object
     * @param {Object} actor - Actor information
     * @param {Object} details - Additional details
     * @param {Object} req - Express request object
     */
    async emitDocumentActivity(action, document, actor, details = {}, req = null) {
        try {
            const targetData = {
                type: 'document',
                id: document._id || document.id || document.documentId,
                name: document.documentType || document.fileName || 'Document'
            };
            
            const activityDetails = {
                documentId: document._id || document.id || document.documentId,
                documentType: document.documentType,
                fileName: document.fileName,
                verificationStatus: document.verificationStatus,
                ...details
            };
            
            return await activityLogService.logActivity(
                actor,
                action,
                targetData,
                activityDetails,
                req
            );
        } catch (error) {
            console.error('Error emitting document activity:', error);
            return null;
        }
    }

    /**
     * Emit review activity
     * @param {string} action - Activity action
     * @param {Object} review - Review object
     * @param {Object} actor - Actor information
     * @param {Object} details - Additional details
     * @param {Object} req - Express request object
     */
    async emitReviewActivity(action, review, actor, details = {}, req = null) {
        try {
            const targetData = {
                type: 'review',
                id: review._id || review.id,
                name: `Review - ${review.rating} stars`
            };
            
            const activityDetails = {
                reviewId: review._id || review.id,
                rating: review.rating,
                dutyId: review.duty?._id || review.duty,
                ...details
            };
            
            return await activityLogService.logActivity(
                actor,
                action,
                targetData,
                activityDetails,
                req
            );
        } catch (error) {
            console.error('Error emitting review activity:', error);
            return null;
        }
    }

    /**
     * Emit security activity
     * @param {string} action - Activity action
     * @param {Object} actor - Actor information
     * @param {Object} details - Additional details
     * @param {Object} req - Express request object
     */
    async emitSecurityActivity(action, actor, details = {}, req = null) {
        try {
            const options = {
                status: 'CRITICAL'
            };
            
            return await activityLogService.logActivity(
                actor,
                action,
                {},
                details,
                req,
                options
            );
        } catch (error) {
            console.error('Error emitting security activity:', error);
            return null;
        }
    }

    /**
     * Emit admin activity
     * @param {string} action - Activity action
     * @param {Object} target - Target object
     * @param {Object} admin - Admin user information
     * @param {Object} details - Additional details
     * @param {Object} req - Express request object
     */
    async emitAdminActivity(action, target, admin, details = {}, req = null) {
        try {
            const targetData = target ? {
                type: target.type,
                id: target.id,
                name: target.name
            } : {};
            
            return await activityLogService.logActivity(
                admin,
                action,
                targetData,
                details,
                req
            );
        } catch (error) {
            console.error('Error emitting admin activity:', error);
            return null;
        }
    }

    /**
     * Emit system activity (cron jobs, automated tasks)
     * @param {string} action - Activity action
     * @param {Object} details - Additional details
     * @param {Object} options - Additional options
     */
    async emitSystemActivity(action, details = {}, options = {}) {
        try {
            return await activityLogService.logSystemActivity(action, details, options);
        } catch (error) {
            console.error('Error emitting system activity:', error);
            return null;
        }
    }

    // Convenience methods for common activities

    /**
     * Log user login
     */
    async logUserLogin(user, req, success = true) {
        const action = success ? ACTIVITY_ACTIONS.USER_LOGIN : ACTIVITY_ACTIONS.USER_LOGIN_FAILED;
        const actor = {
            userId: user._id || user.id,
            name: user.name,
            role: user.role,
            email: user.email
        };
        
        return this.emitUserActivity(action, user, actor, { success }, req);
    }

    /**
     * Log user logout
     */
    async logUserLogout(user, req) {
        const actor = {
            userId: user._id || user.id,
            name: user.name,
            role: user.role,
            email: user.email
        };
        
        return this.emitUserActivity(ACTIVITY_ACTIONS.USER_LOGOUT, user, actor, {}, req);
    }

    /**
     * Log duty creation
     */
    async logDutyCreated(duty, hospital, req, isEmergency = false) {
        const action = isEmergency ? ACTIVITY_ACTIONS.EMERGENCY_DUTY_CREATED : ACTIVITY_ACTIONS.DUTY_CREATED;
        const actor = {
            userId: hospital.user?._id || hospital.user,
            name: hospital.hospitalLegalName || hospital.name,
            role: 'hospital',
            email: hospital.user?.email
        };
        
        return this.emitDutyActivity(action, duty, actor, { isEmergency }, req);
    }

    /**
     * Log duty acceptance
     */
    async logDutyAccepted(duty, staff, req) {
        const actor = {
            userId: staff.user?._id || staff.user,
            name: staff.fullName || staff.name,
            role: 'staff',
            email: staff.user?.email
        };
        
        return this.emitDutyActivity(ACTIVITY_ACTIONS.DUTY_ACCEPTED, duty, actor, {}, req);
    }

    /**
     * Log duty status change
     */
    async logDutyStatusChange(duty, staff, newStatus, req) {
        const actionMap = {
            'enroute': ACTIVITY_ACTIONS.DUTY_STARTED,
            'in-progress': ACTIVITY_ACTIONS.DUTY_IN_PROGRESS,
            'completed': ACTIVITY_ACTIONS.DUTY_COMPLETED
        };
        
        const action = actionMap[newStatus] || ACTIVITY_ACTIONS.DUTY_EDITED;
        const actor = {
            userId: staff.user?._id || staff.user,
            name: staff.fullName || staff.name,
            role: 'staff',
            email: staff.user?.email
        };
        
        return this.emitDutyActivity(action, duty, actor, { newStatus }, req);
    }

    /**
     * Log document verification
     */
    async logDocumentVerification(document, admin, verified, req) {
        const action = verified ? ACTIVITY_ACTIONS.DOCUMENT_VERIFIED_BY_ADMIN : ACTIVITY_ACTIONS.DOCUMENT_REJECTED_BY_ADMIN;
        const actor = {
            userId: admin._id || admin.id,
            name: admin.name,
            role: 'admin',
            email: admin.email
        };
        
        return this.emitDocumentActivity(action, document, actor, { verified }, req);
    }
}

module.exports = new ActivityLogEmitter();
