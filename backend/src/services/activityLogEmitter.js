const activityLogService = require('./activityLog.service');
const { ACTIVITY_ACTIONS } = require('../utils/activityLog.constants');
const MedicalStaff = require('../models/MedicalStaff');
const Hospital = require('../models/Hospital');

// Build a human-readable location string from a profile document
function buildLocationString(profile) {
    if (!profile) return null;
    const parts = [];
    if (profile.currentAddress) parts.push(profile.currentAddress.trim());
    if (profile.city)           parts.push(profile.city.trim());
    if (profile.state)          parts.push(profile.state.trim());
    let location = parts.join(', ');
    if (profile.pincode)        location += ` - ${profile.pincode.trim()}`;
    return location || null;
}

// Resolve location string for a given userId + role (non-blocking — returns null on any failure)
async function resolveUserLocation(userId, role) {
    try {
        if (!userId) return null;

        // Normalize to string then back to ObjectId to handle both string and ObjectId inputs
        const mongoose = require('mongoose');
        const userObjectId = mongoose.Types.ObjectId.isValid(userId)
            ? new mongoose.Types.ObjectId(userId.toString())
            : null;

        if (!userObjectId) return null;

        if (role === 'staff') {
            const staff = await MedicalStaff.findOne({ user: userObjectId })
                .select('currentAddress city state pincode')
                .lean();
            return buildLocationString(staff);
        }
        if (role === 'hospital') {
            const hospital = await Hospital.findOne({ user: userObjectId })
                .select('currentAddress city state pincode')
                .lean();
            return buildLocationString(hospital);
        }
        return null;
    } catch (err) {
        // Log silently so we can debug without breaking the log flow
        console.error(`[resolveUserLocation] failed userId=${userId} role=${role}:`, err.message);
        return null;
    }
}


class ActivityLogEmitter {
    // Emit duty activity
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
                location: details.location || null
            };

            // For staff actors, use their profile address
            if (actor.role === 'staff' && actor.userId) {
                const staffLocation = await resolveUserLocation(actor.userId, 'staff');
                if (staffLocation) options.location = staffLocation;
            }

            // For hospital actors, use their profile address
            if (actor.role === 'hospital' && actor.userId) {
                const hospitalLocation = await resolveUserLocation(actor.userId, 'hospital');
                if (hospitalLocation) options.location = hospitalLocation;
            }
            
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


    // Emit user activity
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

            // Resolve location from staff/hospital profile
            const location = await resolveUserLocation(
                actor.userId || user._id || user.id,
                actor.role || user.role
            );
            
            return await activityLogService.logActivity(
                actor,
                action,
                targetData,
                activityDetails,
                req,
                { location }
            );
        } catch (error) {
            console.error('Error emitting user activity:', error);
            return null;
        }
    }


    // Emit document activity
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

            const location = await resolveUserLocation(actor.userId, actor.role);
            
            return await activityLogService.logActivity(
                actor,
                action,
                targetData,
                activityDetails,
                req,
                { location }
            );
        } catch (error) {
            console.error('Error emitting document activity:', error);
            return null;
        }
    }


    // Emit review activity
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


    // Emit security activity
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


    // Emit admin activity
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


    // Emit system activity (cron jobs, automated tasks)
    async emitSystemActivity(action, details = {}, options = {}) {
        try {
            return await activityLogService.logSystemActivity(action, details, options);
        } catch (error) {
            console.error('Error emitting system activity:', error);
            return null;
        }
    }

    // Convenience methods for common activities

    // Log user login
    async logUserLogin(user, req, success = true) {
        const action = success ? ACTIVITY_ACTIONS.USER_LOGIN : ACTIVITY_ACTIONS.USER_LOGIN_FAILED;
        // signin returns { id } not { _id }, normalise here
        const userId = user._id || user.id;
        const actor = {
            userId,
            name: user.name,
            role: user.role,
            email: user.email
        };
        // Pass a normalised user object so emitUserActivity can resolve location
        return this.emitUserActivity(action, { ...user, _id: userId }, actor, { success }, req);
    }

    
    // Log user logout
    async logUserLogout(user, req) {
        const userId = user._id || user.id;
        const actor = {
            userId,
            name: user.name || user.email || 'Unknown',
            role: user.role,
            email: user.email
        };
        return this.emitUserActivity(ACTIVITY_ACTIONS.USER_LOGOUT, { ...user, _id: userId }, actor, {}, req);
    }

    
    // Log duty creation
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

    
    // Log duty acceptance
    async logDutyAccepted(duty, staff, req) {
        const actor = {
            userId: staff.user?._id || staff.user,
            name: staff.fullName || staff.name,
            role: 'staff',
            email: staff.user?.email
        };
        
        return this.emitDutyActivity(ACTIVITY_ACTIONS.DUTY_ACCEPTED, duty, actor, {}, req);
    }

    
    // Log duty status change
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

    
    // Log document verification
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
