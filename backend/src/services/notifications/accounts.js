// Notifications: registration, verification, documents and account suspension
// Methods of NotificationEmitter; mixed into the class in ../notificationEmitter.js, so `this` is the service.
const logger = require('../../utils/logger');
const notificationService = require('../notificationService');
const notificationDelivery = require('../notificationDelivery.service');
const User = require('../../models/User');

module.exports = {
    // A document was verified automatically (e.g. Aadhaar through IDfy)
    async emitDocumentAutoVerified(userId, documentType) {
        try {
            const label = documentType === 'aadhaar-card' ? 'Aadhaar' : documentType;
            const payload = {
                type: 'DOCUMENT_AUTO_VERIFIED',
                document: { type: documentType },
                message: `Your ${label} has been verified.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(userId, 'DOCUMENT_AUTO_VERIFIED', payload);
            await notificationDelivery.deliverToUser(userId, 'DOCUMENT_AUTO_VERIFIED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting document auto-verified notification:', error);
        }
    },

    /**
     * Emit new hospital registration notification to admin
     * @param {Object} hospital - Hospital object
     * @param {Object} user - User object
     */
    async emitNewHospitalRegistration(hospital, user) {
        try {
            // Validate required parameters
            if (!hospital || !user) {
                console.error('Missing required parameters for emitNewHospitalRegistration');
                return;
            }

            const hospitalName = hospital.hospitalLegalName || user.name || 'New Hospital';
            const location = hospital.location || hospital.currentAddress || 'Location not provided';

            const payload = {
                type: 'NEW_HOSPITAL_REGISTRATION',
                hospital: {
                    id: hospital._id.toString(),
                    name: hospitalName,
                    location: location,
                    email: user.email,
                    phone: user.phone || 'Not provided'
                },
                user: {
                    id: user._id.toString(),
                    name: user.name,
                    email: user.email
                },
                message: `New hospital registered: ${hospitalName} at ${location}. Review and approve the registration.`,
                timestamp: new Date().toISOString()
            };

            // Get all admin users
            const adminUsers = await User.find({ role: 'admin' }).select('_id');

            if (adminUsers.length === 0) {
                logger.debug('No admin users found to notify');
                return;
            }

            const adminUserIds = adminUsers.map(admin => admin._id.toString());

            // Persist notifications for all admins
            try {
                await notificationService.createBulkNotifications(adminUserIds, 'NEW_HOSPITAL_REGISTRATION', payload);
                
                // Deliver to all admins via smart routing (WebSocket or FCM)
                await notificationDelivery.deliverToUsers(adminUserIds, 'NEW_HOSPITAL_REGISTRATION', payload);

                logger.debug(`New hospital registration notification sent to ${adminUserIds.length} admins`);
            } catch (error) {
                console.error('Error sending hospital registration notifications:', error);
            }
        } catch (error) {
            console.error('Error emitting new hospital registration notification:', error);
        }
    },

    /**
     * Emit new staff registration notification to admin
     * @param {Object} staff - Medical staff object
     * @param {Object} user - User object
     */
    async emitNewStaffRegistration(staff, user) {
        try {
            // Validate required parameters
            if (!staff || !user) {
                console.error('Missing required parameters for emitNewStaffRegistration');
                return;
            }

            const staffName = staff.fullName || user.name || 'New Staff Member';
            const jobRole = staff.jobRole || 'Not specified';

            const payload = {
                type: 'NEW_STAFF_REGISTRATION',
                staff: {
                    id: staff._id.toString(),
                    name: staffName,
                    jobRole: jobRole,
                    email: user.email,
                    phone: user.phone || 'Not provided',
                    experience: staff.experience || 'Not provided'
                },
                user: {
                    id: user._id.toString(),
                    name: user.name,
                    email: user.email
                },
                message: `New ${jobRole} registered: ${staffName}. Review and verify the profile.`,
                timestamp: new Date().toISOString()
            };

            // Get all admin users
            const adminUsers = await User.find({ role: 'admin' }).select('_id');

            if (adminUsers.length === 0) {
                logger.debug('No admin users found to notify');
                return;
            }

            const adminUserIds = adminUsers.map(admin => admin._id.toString());

            // Persist notifications for all admins
            try {
                await notificationService.createBulkNotifications(adminUserIds, 'NEW_STAFF_REGISTRATION', payload);
                
                // Deliver to all admins via smart routing (WebSocket or FCM)
                await notificationDelivery.deliverToUsers(adminUserIds, 'NEW_STAFF_REGISTRATION', payload);

                logger.debug(`New staff registration notification sent to ${adminUserIds.length} admins`);
            } catch (error) {
                console.error('Error sending staff registration notifications:', error);
            }
        } catch (error) {
            console.error('Error emitting new staff registration notification:', error);
        }
    },

    /**
     * Emit hospital profile verified notification
     * @param {Object} hospital - Hospital object
     * @param {string} hospitalUserId - Hospital user ID
     */
    async emitHospitalVerified(hospital, hospitalUserId) {
        try {
            logger.debug(`[NOTIFICATION] Starting hospital verified notification process for hospital: ${hospitalUserId}`);
            
            // Get all admin users
            const admins = await User.find({ role: 'admin' }).select('_id');
            const adminIds = admins.map(a => a._id.toString());
            logger.debug(`[NOTIFICATION] Found ${adminIds.length} admins to notify`);

            const hospitalName = hospital.hospitalLegalName || hospital.user?.name || 'Hospital';

            // Payload for hospital user
            const hospitalPayload = {
                type: 'HOSPITAL_VERIFIED',
                hospital: {
                    id: hospital._id.toString(),
                    name: hospitalName
                },
                message: `Your hospital profile "${hospitalName}" has been verified. You can now post duties and access all features.`,
                timestamp: new Date().toISOString()
            };

            // Payload for admins
            const adminPayload = {
                type: 'HOSPITAL_VERIFIED_ADMIN',
                hospital: {
                    id: hospital._id.toString(),
                    name: hospitalName
                },
                message: `Hospital "${hospitalName}" has been verified by admin.`,
                timestamp: new Date().toISOString()
            };

            // Send notification to hospital user
            try {
                logger.debug(`[NOTIFICATION] Sending verification notification to hospital user: ${hospitalUserId}`);
                const { unreadCount } = await notificationService.createNotificationWithCount(
                    hospitalUserId, 
                    'HOSPITAL_VERIFIED', 
                    hospitalPayload
                );
                await notificationDelivery.deliverToUser(hospitalUserId, 'HOSPITAL_VERIFIED', hospitalPayload, unreadCount);
                logger.debug(`[NOTIFICATION] ✓ Successfully sent verification notification to hospital user: ${hospitalUserId}`);
            } catch (error) {
                console.error(`[NOTIFICATION] ✗ Error sending verification notification to hospital ${hospitalUserId}:`, error);
            }

            // Send notifications to all admins
            if (adminIds.length > 0) {
                try {
                    logger.debug(`[NOTIFICATION] Sending verification notification to ${adminIds.length} admins`);
                    await notificationService.createBulkNotifications(adminIds, 'HOSPITAL_VERIFIED_ADMIN', adminPayload);
                    await notificationDelivery.deliverToUsers(adminIds, 'HOSPITAL_VERIFIED_ADMIN', adminPayload);
                    logger.debug(`[NOTIFICATION] ✓ Successfully sent verification notification to ${adminIds.length} admins`);
                } catch (error) {
                    console.error('[NOTIFICATION] ✗ Error sending hospital verified notification to admins:', error);
                }
            } else {
                logger.debug(`[NOTIFICATION] ⚠ No admins found to notify`);
            }

            logger.debug(`[NOTIFICATION] ✓ Hospital verified notification process completed: hospital=${hospitalUserId}, admins=${adminIds.length}`);
        } catch (error) {
            console.error('[NOTIFICATION] ✗ Error emitting hospital verified notification:', error);
        }
    },

    /**
     * Emit hospital profile rejected notification
     * @param {Object} hospital - Hospital object
     * @param {string} hospitalUserId - Hospital user ID
     * @param {string} reason - Rejection reason
     */
    async emitHospitalRejected(hospital, hospitalUserId, reason) {
        try {
            logger.debug(`[NOTIFICATION] Starting hospital rejected notification process for hospital: ${hospitalUserId}, reason: ${reason}`);
            
            // Get all admin users
            const admins = await User.find({ role: 'admin' }).select('_id');
            const adminIds = admins.map(a => a._id.toString());
            logger.debug(`[NOTIFICATION] Found ${adminIds.length} admins to notify`);

            const hospitalName = hospital.hospitalLegalName || hospital.user?.name || 'Hospital';

            // Payload for hospital user
            const hospitalPayload = {
                type: 'HOSPITAL_REJECTED',
                hospital: {
                    id: hospital._id.toString(),
                    name: hospitalName
                },
                rejectionReason: reason,
                message: `Your hospital profile "${hospitalName}" was rejected. Reason: ${reason}. Please update your profile and resubmit.`,
                timestamp: new Date().toISOString()
            };

            // Payload for admins
            const adminPayload = {
                type: 'HOSPITAL_REJECTED_ADMIN',
                hospital: {
                    id: hospital._id.toString(),
                    name: hospitalName
                },
                rejectionReason: reason,
                message: `Hospital "${hospitalName}" has been rejected. Reason: ${reason}.`,
                timestamp: new Date().toISOString()
            };

            // Send notification to hospital user
            try {
                logger.debug(`[NOTIFICATION] Sending rejection notification to hospital user: ${hospitalUserId}`);
                const { unreadCount } = await notificationService.createNotificationWithCount(
                    hospitalUserId, 
                    'HOSPITAL_REJECTED', 
                    hospitalPayload
                );
                await notificationDelivery.deliverToUser(hospitalUserId, 'HOSPITAL_REJECTED', hospitalPayload, unreadCount);
                logger.debug(`[NOTIFICATION] ✓ Successfully sent rejection notification to hospital user: ${hospitalUserId}`);
            } catch (error) {
                console.error(`[NOTIFICATION] ✗ Error sending rejection notification to hospital ${hospitalUserId}:`, error);
            }

            // Send notifications to all admins
            if (adminIds.length > 0) {
                try {
                    logger.debug(`[NOTIFICATION] Sending rejection notification to ${adminIds.length} admins`);
                    await notificationService.createBulkNotifications(adminIds, 'HOSPITAL_REJECTED_ADMIN', adminPayload);
                    await notificationDelivery.deliverToUsers(adminIds, 'HOSPITAL_REJECTED_ADMIN', adminPayload);
                    logger.debug(`[NOTIFICATION] ✓ Successfully sent rejection notification to ${adminIds.length} admins`);
                } catch (error) {
                    console.error('[NOTIFICATION] ✗ Error sending hospital rejected notification to admins:', error);
                }
            } else {
                logger.debug(`[NOTIFICATION] ⚠ No admins found to notify`);
            }

            logger.debug(`[NOTIFICATION] ✓ Hospital rejected notification process completed: hospital=${hospitalUserId}, admins=${adminIds.length}`);
        } catch (error) {
            console.error('[NOTIFICATION] ✗ Error emitting hospital rejected notification:', error);
        }
    },

    /**
     * Emit staff profile verified notification
     * @param {Object} staff - Medical staff object
     * @param {string} staffUserId - Staff user ID
     */
    async emitStaffVerified(staff, staffUserId) {
        try {
            logger.debug(`[NOTIFICATION] Starting staff verified notification process for staff: ${staffUserId}`);
            
            // Get all admin users
            const admins = await User.find({ role: 'admin' }).select('_id');
            const adminIds = admins.map(a => a._id.toString());
            logger.debug(`[NOTIFICATION] Found ${adminIds.length} admins to notify`);

            const staffName = staff.fullName || staff.user?.name || 'Staff Member';

            // Payload for staff user
            const staffPayload = {
                type: 'STAFF_VERIFIED',
                staff: {
                    id: staff._id.toString(),
                    name: staffName,
                    role: staff.jobRole
                },
                message: "You're verified. Turn on availability to get duty offers.",
                timestamp: new Date().toISOString()
            };

            // Payload for admins
            const adminPayload = {
                type: 'STAFF_VERIFIED_ADMIN',
                staff: {
                    id: staff._id.toString(),
                    name: staffName,
                    role: staff.jobRole
                },
                message: `Staff "${staffName}" (${staff.jobRole}) has been verified by admin.`,
                timestamp: new Date().toISOString()
            };

            // Send notification to staff user
            try {
                logger.debug(`[NOTIFICATION] Sending verification notification to staff user: ${staffUserId}`);
                const { unreadCount } = await notificationService.createNotificationWithCount(
                    staffUserId, 
                    'STAFF_VERIFIED', 
                    staffPayload
                );
                await notificationDelivery.deliverToUser(staffUserId, 'STAFF_VERIFIED', staffPayload, unreadCount);
                logger.debug(`[NOTIFICATION] ✓ Successfully sent verification notification to staff user: ${staffUserId}`);
            } catch (error) {
                console.error(`[NOTIFICATION] ✗ Error sending verification notification to staff ${staffUserId}:`, error);
            }

            // Send notifications to all admins
            if (adminIds.length > 0) {
                try {
                    logger.debug(`[NOTIFICATION] Sending verification notification to ${adminIds.length} admins`);
                    await notificationService.createBulkNotifications(adminIds, 'STAFF_VERIFIED_ADMIN', adminPayload);
                    await notificationDelivery.deliverToUsers(adminIds, 'STAFF_VERIFIED_ADMIN', adminPayload);
                    logger.debug(`[NOTIFICATION] ✓ Successfully sent verification notification to ${adminIds.length} admins`);
                } catch (error) {
                    console.error('[NOTIFICATION] ✗ Error sending staff verified notification to admins:', error);
                }
            } else {
                logger.debug(`[NOTIFICATION] ⚠ No admins found to notify`);
            }

            logger.debug(`[NOTIFICATION] ✓ Staff verified notification process completed: staff=${staffUserId}, admins=${adminIds.length}`);
        } catch (error) {
            console.error('[NOTIFICATION] ✗ Error emitting staff verified notification:', error);
        }
    },

    /**
     * Emit staff profile rejected notification
     * @param {Object} staff - Medical staff object
     * @param {string} staffUserId - Staff user ID
     * @param {string} reason - Rejection reason
     */
    async emitStaffRejected(staff, staffUserId, reason) {
        try {
            logger.debug(`[NOTIFICATION] Starting staff rejected notification process for staff: ${staffUserId}, reason: ${reason}`);
            
            // Get all admin users
            const admins = await User.find({ role: 'admin' }).select('_id');
            const adminIds = admins.map(a => a._id.toString());
            logger.debug(`[NOTIFICATION] Found ${adminIds.length} admins to notify`);

            const staffName = staff.fullName || staff.user?.name || 'Staff Member';

            // Payload for staff user
            const staffPayload = {
                type: 'STAFF_REJECTED',
                staff: {
                    id: staff._id.toString(),
                    name: staffName,
                    role: staff.jobRole
                },
                rejectionReason: reason,
                message: `Your profile "${staffName}" was rejected. Reason: ${reason}. Please update your profile and resubmit.`,
                timestamp: new Date().toISOString()
            };

            // Payload for admins
            const adminPayload = {
                type: 'STAFF_REJECTED_ADMIN',
                staff: {
                    id: staff._id.toString(),
                    name: staffName,
                    role: staff.jobRole
                },
                rejectionReason: reason,
                message: `Staff "${staffName}" (${staff.jobRole}) has been rejected. Reason: ${reason}.`,
                timestamp: new Date().toISOString()
            };

            // Send notification to staff user
            try {
                logger.debug(`[NOTIFICATION] Sending rejection notification to staff user: ${staffUserId}`);
                const { unreadCount } = await notificationService.createNotificationWithCount(
                    staffUserId, 
                    'STAFF_REJECTED', 
                    staffPayload
                );
                await notificationDelivery.deliverToUser(staffUserId, 'STAFF_REJECTED', staffPayload, unreadCount);
                logger.debug(`[NOTIFICATION] ✓ Successfully sent rejection notification to staff user: ${staffUserId}`);
            } catch (error) {
                console.error(`[NOTIFICATION] ✗ Error sending rejection notification to staff ${staffUserId}:`, error);
            }

            // Send notifications to all admins
            if (adminIds.length > 0) {
                try {
                    logger.debug(`[NOTIFICATION] Sending rejection notification to ${adminIds.length} admins`);
                    await notificationService.createBulkNotifications(adminIds, 'STAFF_REJECTED_ADMIN', adminPayload);
                    await notificationDelivery.deliverToUsers(adminIds, 'STAFF_REJECTED_ADMIN', adminPayload);
                    logger.debug(`[NOTIFICATION] ✓ Successfully sent rejection notification to ${adminIds.length} admins`);
                } catch (error) {
                    console.error('[NOTIFICATION] ✗ Error sending staff rejected notification to admins:', error);
                }
            } else {
                logger.debug(`[NOTIFICATION] ⚠ No admins found to notify`);
            }

            logger.debug(`[NOTIFICATION] ✓ Staff rejected notification process completed: staff=${staffUserId}, admins=${adminIds.length}`);
        } catch (error) {
            console.error('[NOTIFICATION] ✗ Error emitting staff rejected notification:', error);
        }
    },

    // Document verification notifications
    async emitDocumentVerified(document, userRole) {
        try {
            if (!document || !document.userId) {
                console.error('Missing required parameters for emitDocumentVerified');
                return;
            }

            const documentType = document.documentType.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            
            const payload = {
                type: 'DOCUMENT_VERIFIED',
                document: {
                    id: document.documentId,
                    type: document.documentType,
                    typeName: documentType,
                    verifiedAt: document.verifiedAt
                },
                message: `Your ${documentType} has been verified by the HospiLink team`,
                timestamp: new Date().toISOString()
            };

            // Persist notification for user
            try {
                const { unreadCount } = await notificationService.createNotificationWithCount(
                    document.userId,
                    'DOCUMENT_VERIFIED',
                    payload
                );
                
                await notificationDelivery.deliverToUser(document.userId, 'DOCUMENT_VERIFIED', payload, unreadCount);
                
                logger.debug(`Document verified notification sent to ${userRole} ${document.userId}`);
            } catch (error) {
                console.error(`Error sending document verified notification to ${userRole} ${document.userId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting document verified notification:', error);
        }
    },

    // Resume-driven onboarding — tells a staff member which profile fields were
    // auto-filled from their uploaded resume, so they know to review it.
    async emitProfileAutoFilledFromResume(userId, filledFields = []) {
        try {
            if (!userId) {
                console.error('Missing required parameters for emitProfileAutoFilledFromResume');
                return;
            }

            const fieldList = filledFields.length ? filledFields.join(', ') : 'basic info';

            const payload = {
                type: 'PROFILE_AUTO_FILLED_FROM_RESUME',
                filledFields,
                message: `We filled in your profile from your resume (${fieldList}). Review it any time.`,
                timestamp: new Date().toISOString()
            };

            try {
                const { unreadCount } = await notificationService.createNotificationWithCount(
                    userId,
                    'PROFILE_AUTO_FILLED_FROM_RESUME',
                    payload
                );

                await notificationDelivery.deliverToUser(userId, 'PROFILE_AUTO_FILLED_FROM_RESUME', payload, unreadCount);

                logger.debug(`Profile auto-fill notification sent to staff ${userId}`);
            } catch (error) {
                console.error(`Error sending profile auto-fill notification to staff ${userId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting profile auto-fill notification:', error);
        }
    },

    // Resume analysis (score + suggestions) — fired every time a resume is
    // parsed, on both onboarding paths, whether this is the first resume ever
    // uploaded or a replacement for a previous one. Independent of
    // emitProfileAutoFilledFromResume, which only fires when a brand-new
    // profile was created.
    async emitResumeAnalyzed(userId, { total } = {}, suggestions = [], isReanalysis = false) {
        try {
            if (!userId) {
                console.error('Missing required parameters for emitResumeAnalyzed');
                return;
            }

            const message = isReanalysis
                ? `Your resume has been re-analyzed — new score: ${total}/100.`
                : `Your resume scored ${total}/100.`;

            const payload = {
                type: 'RESUME_ANALYZED',
                score: total,
                suggestions,
                isReanalysis,
                message,
                timestamp: new Date().toISOString()
            };

            try {
                const { unreadCount } = await notificationService.createNotificationWithCount(
                    userId,
                    'RESUME_ANALYZED',
                    payload
                );

                await notificationDelivery.deliverToUser(userId, 'RESUME_ANALYZED', payload, unreadCount);

                logger.debug(`Resume analyzed notification sent to staff ${userId}`);
            } catch (error) {
                console.error(`Error sending resume analyzed notification to staff ${userId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting resume analyzed notification:', error);
        }
    },

    // Document rejection notifications
    // New doctor still missing required documents (days 1, 3 and 7 after sign-up)
    async emitDocumentsReminder(userId) {
        const payload = {
            type: 'DOCUMENTS_REMINDER',
            message: 'Upload your documents to start taking duties.',
            timestamp: new Date().toISOString()
        };
        const { unreadCount } = await notificationService.createNotificationWithCount(userId, 'DOCUMENTS_REMINDER', payload);
        await notificationDelivery.deliverToUser(userId, 'DOCUMENTS_REMINDER', payload, unreadCount);
    },

    async emitDocumentRejected(document, userRole) {
        try {
            if (!document || !document.userId) {
                console.error('Missing required parameters for emitDocumentRejected');
                return;
            }

            const documentType = document.documentType.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            const rejectionReason = document.rejectionReason || 'No reason provided';
            
            const payload = {
                type: 'DOCUMENT_REJECTED',
                document: {
                    id: document.documentId,
                    type: document.documentType,
                    typeName: documentType,
                    rejectionReason: rejectionReason,
                    rejectedAt: document.verifiedAt
                },
                message: `Your ${documentType} was not accepted. Reason: ${rejectionReason}. Please re-upload a clear, valid document.`,
                timestamp: new Date().toISOString()
            };

            // Persist notification for user
            try {
                const { unreadCount } = await notificationService.createNotificationWithCount(
                    document.userId,
                    'DOCUMENT_REJECTED',
                    payload
                );
                
                await notificationDelivery.deliverToUser(document.userId, 'DOCUMENT_REJECTED', payload, unreadCount);
                
                logger.debug(`Document rejected notification sent to ${userRole} ${document.userId}`);
            } catch (error) {
                console.error(`Error sending document rejected notification to ${userRole} ${document.userId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting document rejected notification:', error);
        }
    },

    /**
     * Emit account suspended notification to the affected user
     * @param {Object} profile - Hospital or MedicalStaff object
     * @param {string} userId - User ID string
     * @param {string} role - 'hospital' | 'staff'
     * @param {string} reason - Suspension reason
     */
    async emitAccountSuspended(profile, userId, role, reason) {
        try {
            const payload = {
                type: 'ACCOUNT_SUSPENDED',
                reason,
                message: `Your account has been suspended. Reason: ${reason}. Please contact support for assistance.`,
                timestamp: new Date().toISOString()
            };

            const { unreadCount } = await notificationService.createNotificationWithCount(
                userId, 'ACCOUNT_SUSPENDED', payload
            );
            await notificationDelivery.deliverToUser(userId, 'ACCOUNT_SUSPENDED', payload, unreadCount);
            logger.debug(`[NOTIFICATION] Account suspended notification sent to ${role} user ${userId}`);
        } catch (error) {
            console.error('[NOTIFICATION] Error emitting account suspended notification:', error);
        }
    },

    /**
     * Emit account activated (unsuspended) notification to the affected user
     * @param {Object} profile - Hospital or MedicalStaff object
     * @param {string} userId - User ID string
     * @param {string} role - 'hospital' | 'staff'
     */
    async emitAccountActivated(profile, userId, role) {
        try {
            const payload = {
                type: 'ACCOUNT_ACTIVATED',
                message: 'Your account has been restored. You can now access all platform features.',
                timestamp: new Date().toISOString()
            };

            const { unreadCount } = await notificationService.createNotificationWithCount(
                userId, 'ACCOUNT_ACTIVATED', payload
            );
            await notificationDelivery.deliverToUser(userId, 'ACCOUNT_ACTIVATED', payload, unreadCount);
            logger.debug(`[NOTIFICATION] Account activated notification sent to ${role} user ${userId}`);
        } catch (error) {
            console.error('[NOTIFICATION] Error emitting account activated notification:', error);
        }
    }
};
