// Notifications: job vacancies, applications and interviews
// Methods of NotificationEmitter; mixed into the class in ../notificationEmitter.js, so `this` is the service.
const notificationService = require('../notificationService');
const notificationDelivery = require('../notificationDelivery.service');
const Hospital = require('../../models/Hospital');
const JobVacancy = require('../../models/JobVacancy');

module.exports = {
    // A vacancy was closed while this candidate's application was still open
    async emitVacancyClosed(application, vacancy) {
        try {
            const payload = {
                type: 'VACANCY_CLOSED',
                application: { id: application._id.toString() },
                vacancy: { id: vacancy._id.toString(), title: vacancy.title },
                message: `The vacancy "${vacancy.title}" has been closed, so your application has ended. Keep an eye out for other vacancies.`,
                timestamp: new Date().toISOString()
            };
            const userId = application.user.toString();
            const { unreadCount } = await notificationService.createNotificationWithCount(userId, 'VACANCY_CLOSED', payload);
            await notificationDelivery.deliverToUser(userId, 'VACANCY_CLOSED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting vacancy closed notification:', error);
        }
    },

    // Internal helper — resolves a hospital's own login user id from a
    // hospitalId, used by every hospital-facing job-application emitter below
    // so callers only ever need to pass the application/vacancy object, not
    // a pre-resolved user id.
    async _resolveHospitalUserId(hospitalId) {
        const hospital = await Hospital.findById(hospitalId).select('user hospitalLegalName').lean();
        return hospital ? { userId: hospital.user, name: hospital.hospitalLegalName } : null;
    },

    async _vacancyTitle(vacancyId) {
        const vacancy = await JobVacancy.findById(vacancyId).select('title').lean();
        return vacancy?.title || 'the role';
    },

    async emitProfileRequiredForApplication(userId, vacancy) {
        try {
            const payload = {
                type: 'PROFILE_REQUIRED_FOR_APPLICATION',
                vacancy: { id: vacancy._id, title: vacancy.title },
                message: 'Complete your profile before applying for a vacancy. You can apply using just your resume.',
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(
                userId, 'PROFILE_REQUIRED_FOR_APPLICATION', payload
            );
            await notificationDelivery.deliverToUser(userId, 'PROFILE_REQUIRED_FOR_APPLICATION', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting profile-required-for-application notification:', error);
        }
    },

    async emitResumeRequiredForApplication(userId, vacancy) {
        try {
            const payload = {
                type: 'RESUME_REQUIRED_FOR_APPLICATION',
                vacancy: { id: vacancy._id, title: vacancy.title },
                message: 'Upload your resume to apply for vacancies.',
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(
                userId, 'RESUME_REQUIRED_FOR_APPLICATION', payload
            );
            await notificationDelivery.deliverToUser(userId, 'RESUME_REQUIRED_FOR_APPLICATION', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting resume-required-for-application notification:', error);
        }
    },

    async emitNewJobApplication(vacancy, application, applicantName) {
        try {
            const hospital = await this._resolveHospitalUserId(vacancy.hospitalId);
            if (!hospital) return;

            const payload = {
                type: 'NEW_JOB_APPLICATION',
                application: { id: application._id },
                vacancy: { id: vacancy._id, title: vacancy.title },
                applicantName,
                message: `${applicantName} applied for ${vacancy.title}.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(
                hospital.userId, 'NEW_JOB_APPLICATION', payload
            );
            await notificationDelivery.deliverToUser(hospital.userId, 'NEW_JOB_APPLICATION', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting new-job-application notification:', error);
        }
    },

    async emitApplicationShortlisted(application) {
        try {
            const title = await this._vacancyTitle(application.vacancy);
            const payload = {
                type: 'APPLICATION_SHORTLISTED',
                application: { id: application._id },
                message: `You've been shortlisted for ${title}.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(
                application.user, 'APPLICATION_SHORTLISTED', payload
            );
            await notificationDelivery.deliverToUser(application.user, 'APPLICATION_SHORTLISTED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting application-shortlisted notification:', error);
        }
    },

    async emitApplicationRejected(application, reason, reasonText) {
        try {
            const title = await this._vacancyTitle(application.vacancy);
            const payload = {
                type: 'APPLICATION_REJECTED',
                application: { id: application._id },
                reason,
                reasonText: reasonText || null,
                message: `Your application for ${title} was not selected to move forward.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(
                application.user, 'APPLICATION_REJECTED', payload
            );
            await notificationDelivery.deliverToUser(application.user, 'APPLICATION_REJECTED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting application-rejected notification:', error);
        }
    },

    async emitApplicationWithdrawn(application) {
        try {
            const hospital = await this._resolveHospitalUserId(application.hospitalId);
            if (!hospital) return;

            const title = await this._vacancyTitle(application.vacancy);
            const payload = {
                type: 'APPLICATION_WITHDRAWN',
                application: { id: application._id },
                message: `A candidate withdrew their application for ${title}.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(
                hospital.userId, 'APPLICATION_WITHDRAWN', payload
            );
            await notificationDelivery.deliverToUser(hospital.userId, 'APPLICATION_WITHDRAWN', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting application-withdrawn notification:', error);
        }
    },

    async emitSlotsOffered(application) {
        try {
            const title = await this._vacancyTitle(application.vacancy);
            const payload = {
                type: 'SLOTS_OFFERED',
                application: { id: application._id },
                expiresAt: application.interview.offer.expiresAt,
                message: `${title}: pick a time that works for your interview. Offer expires ${new Date(application.interview.offer.expiresAt).toLocaleDateString('en-IN')}.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(application.user, 'SLOTS_OFFERED', payload);
            await notificationDelivery.deliverToUser(application.user, 'SLOTS_OFFERED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting slots-offered notification:', error);
        }
    },

    async emitCandidatePickedSlots(application) {
        try {
            const hospital = await this._resolveHospitalUserId(application.hospitalId);
            if (!hospital) return;
            const title = await this._vacancyTitle(application.vacancy);
            const payload = {
                type: 'CANDIDATE_PICKED_SLOTS',
                application: { id: application._id },
                picks: application.interview.candidatePicks,
                message: `A candidate picked interview slots for ${title}. Confirm one to book the interview.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(hospital.userId, 'CANDIDATE_PICKED_SLOTS', payload);
            await notificationDelivery.deliverToUser(hospital.userId, 'CANDIDATE_PICKED_SLOTS', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting candidate-picked-slots notification:', error);
        }
    },

    async emitInterviewConfirmed(application) {
        try {
            const hospital = await this._resolveHospitalUserId(application.hospitalId);
            const title = await this._vacancyTitle(application.vacancy);
            const payload = {
                type: 'INTERVIEW_CONFIRMED',
                application: { id: application._id },
                slot: application.interview.confirmedSlot,
                interviewerName: application.interview.interviewerName,
                message: `Interview confirmed for ${title}. Open the app for the time, interviewer and join link.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount: staffUnread } = await notificationService.createNotificationWithCount(application.user, 'INTERVIEW_CONFIRMED', payload);
            await notificationDelivery.deliverToUser(application.user, 'INTERVIEW_CONFIRMED', payload, staffUnread);
            if (hospital) {
                const { unreadCount: hospitalUnread } = await notificationService.createNotificationWithCount(hospital.userId, 'INTERVIEW_CONFIRMED', payload);
                await notificationDelivery.deliverToUser(hospital.userId, 'INTERVIEW_CONFIRMED', payload, hospitalUnread);
            }
        } catch (error) {
            console.error('Error emitting interview-confirmed notification:', error);
        }
    },

    // cancelledByRole is who TOOK the action ('hospital' | 'staff') — notifies
    // the other side.
    async emitInterviewCancelled(application, cancelledByRole, reason, reasonText) {
        try {
            const title = await this._vacancyTitle(application.vacancy);
            const payload = {
                type: 'INTERVIEW_CANCELLED',
                application: { id: application._id },
                reason,
                reasonText: reasonText || null,
                message: `Your interview for ${title} was cancelled. Reason: ${reason}.`,
                timestamp: new Date().toISOString()
            };

            if (cancelledByRole === 'hospital') {
                const { unreadCount } = await notificationService.createNotificationWithCount(application.user, 'INTERVIEW_CANCELLED', payload);
                await notificationDelivery.deliverToUser(application.user, 'INTERVIEW_CANCELLED', payload, unreadCount);
            } else {
                const hospital = await this._resolveHospitalUserId(application.hospitalId);
                if (!hospital) return;
                const { unreadCount } = await notificationService.createNotificationWithCount(hospital.userId, 'INTERVIEW_CANCELLED', payload);
                await notificationDelivery.deliverToUser(hospital.userId, 'INTERVIEW_CANCELLED', payload, unreadCount);
            }
        } catch (error) {
            console.error('Error emitting interview-cancelled notification:', error);
        }
    },

    async emitInterviewRescheduled(application) {
        try {
            const title = await this._vacancyTitle(application.vacancy);
            const payload = {
                type: 'INTERVIEW_RESCHEDULED',
                application: { id: application._id },
                message: `Your interview for ${title} was rescheduled — new times are ready to pick in the app.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(application.user, 'INTERVIEW_RESCHEDULED', payload);
            await notificationDelivery.deliverToUser(application.user, 'INTERVIEW_RESCHEDULED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting interview-rescheduled notification:', error);
        }
    },

    async emitRescheduleRequested(application) {
        try {
            const hospital = await this._resolveHospitalUserId(application.hospitalId);
            if (!hospital) return;
            const title = await this._vacancyTitle(application.vacancy);
            const payload = {
                type: 'RESCHEDULE_REQUESTED',
                application: { id: application._id },
                reason: application.interview.rescheduleRequest?.reason,
                message: `A candidate requested a reschedule for their interview for ${title}.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(hospital.userId, 'RESCHEDULE_REQUESTED', payload);
            await notificationDelivery.deliverToUser(hospital.userId, 'RESCHEDULE_REQUESTED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting reschedule-requested notification:', error);
        }
    },

    async emitMeetingLinkChanged(application) {
        try {
            const payload = {
                type: 'MEETING_LINK_CHANGED',
                application: { id: application._id },
                message: 'The meeting link for your interview was updated. Open the app to see the new link.',
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(application.user, 'MEETING_LINK_CHANGED', payload);
            await notificationDelivery.deliverToUser(application.user, 'MEETING_LINK_CHANGED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting meeting-link-changed notification:', error);
        }
    },

    async emitJobOfferExtended(application) {
        try {
            const title = await this._vacancyTitle(application.vacancy);
            const payload = {
                type: 'JOB_OFFER_EXTENDED',
                application: { id: application._id },
                message: `You've been offered the role for ${title}. Open the app to respond.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(application.user, 'JOB_OFFER_EXTENDED', payload);
            await notificationDelivery.deliverToUser(application.user, 'JOB_OFFER_EXTENDED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting job-offer-extended notification:', error);
        }
    },

    async emitMarkedNoShow(application) {
        try {
            const payload = {
                type: 'MARKED_NO_SHOW',
                application: { id: application._id },
                message: 'You were marked as a no-show for your interview. You have 7 days to dispute this if you believe it is wrong.',
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(application.user, 'MARKED_NO_SHOW', payload);
            await notificationDelivery.deliverToUser(application.user, 'MARKED_NO_SHOW', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting marked-no-show notification:', error);
        }
    },

    async emitHospitalNoShowReported(application) {
        try {
            const hospital = await this._resolveHospitalUserId(application.hospitalId);
            if (!hospital) return;
            const title = await this._vacancyTitle(application.vacancy);
            const payload = {
                type: 'HOSPITAL_NO_SHOW_REPORTED',
                application: { id: application._id },
                message: `A candidate reported nobody joined their interview for ${title}.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(hospital.userId, 'HOSPITAL_NO_SHOW_REPORTED', payload);
            await notificationDelivery.deliverToUser(hospital.userId, 'HOSPITAL_NO_SHOW_REPORTED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting hospital-no-show-reported notification:', error);
        }
    },

    async emitApplicationHired(application) {
        try {
            const hospital = await this._resolveHospitalUserId(application.hospitalId);
            if (!hospital) return;
            const title = await this._vacancyTitle(application.vacancy);
            const payload = {
                type: 'APPLICATION_HIRED',
                application: { id: application._id },
                message: `A candidate accepted your offer for ${title}.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(hospital.userId, 'APPLICATION_HIRED', payload);
            await notificationDelivery.deliverToUser(hospital.userId, 'APPLICATION_HIRED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting application-hired notification:', error);
        }
    },

    async emitContactDetailsReleased(application) {
        try {
            const hospital = await this._resolveHospitalUserId(application.hospitalId);
            const hospitalName = hospital?.name || 'the hospital';
            const payload = {
                type: 'CONTACT_DETAILS_RELEASED',
                application: { id: application._id },
                hospitalName,
                message: `Your phone and email have been shared with ${hospitalName}.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(application.user, 'CONTACT_DETAILS_RELEASED', payload);
            await notificationDelivery.deliverToUser(application.user, 'CONTACT_DETAILS_RELEASED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting contact-details-released notification:', error);
        }
    },

    async emitInterviewReminder(application, windowLabel) {
        try {
            const hospital = await this._resolveHospitalUserId(application.hospitalId);
            const title = await this._vacancyTitle(application.vacancy);
            const type = windowLabel === '24h' ? 'INTERVIEW_REMINDER_24H' : 'INTERVIEW_REMINDER_1H';
            const payload = {
                type,
                application: { id: application._id },
                slot: application.interview.confirmedSlot,
                message: `Reminder: your interview for ${title} is ${windowLabel === '24h' ? 'tomorrow' : 'in about an hour'}.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount: staffUnread } = await notificationService.createNotificationWithCount(application.user, type, payload);
            await notificationDelivery.deliverToUser(application.user, type, payload, staffUnread);
            if (hospital) {
                const { unreadCount: hospitalUnread } = await notificationService.createNotificationWithCount(hospital.userId, type, payload);
                await notificationDelivery.deliverToUser(hospital.userId, type, payload, hospitalUnread);
            }
        } catch (error) {
            console.error('Error emitting interview-reminder notification:', error);
        }
    },

    async emitOfferUnansweredReminder(application, dayLabel) {
        try {
            const title = await this._vacancyTitle(application.vacancy);
            const nearingExpiry = dayLabel === 'day18';
            const payload = {
                type: 'OFFER_UNANSWERED_REMINDER',
                application: { id: application._id },
                message: nearingExpiry
                    ? `Your interview slot offer for ${title} lapses in 3 days — pick a time before it expires.`
                    : `You have interview slots waiting for ${title}. Pick a time that works for you.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(application.user, 'OFFER_UNANSWERED_REMINDER', payload);
            await notificationDelivery.deliverToUser(application.user, 'OFFER_UNANSWERED_REMINDER', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting offer-unanswered-reminder notification:', error);
        }
    },

    async emitConfirmationPendingReminder(application, dayLabel) {
        try {
            const hospital = await this._resolveHospitalUserId(application.hospitalId);
            if (!hospital) return;
            const earliestPick = (application.interview.candidatePicks || [])
                .slice().sort((a, b) => new Date(a.start) - new Date(b.start))[0];
            const payload = {
                type: 'CONFIRMATION_PENDING_REMINDER',
                application: { id: application._id },
                earliestPick,
                message: `A candidate is still waiting on interview confirmation${dayLabel === 'day18' ? ' — this lapses in 3 days' : ''}.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(hospital.userId, 'CONFIRMATION_PENDING_REMINDER', payload);
            await notificationDelivery.deliverToUser(hospital.userId, 'CONFIRMATION_PENDING_REMINDER', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting confirmation-pending-reminder notification:', error);
        }
    },

    async emitOfferExpired(application) {
        try {
            const hospital = await this._resolveHospitalUserId(application.hospitalId);
            const title = await this._vacancyTitle(application.vacancy);
            const staffPayload = {
                type: 'OFFER_EXPIRED',
                application: { id: application._id },
                message: `Your interview slot offer for ${title} lapsed. The role may still be open — check back or wait for a new offer.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount: staffUnread } = await notificationService.createNotificationWithCount(application.user, 'OFFER_EXPIRED', staffPayload);
            await notificationDelivery.deliverToUser(application.user, 'OFFER_EXPIRED', staffPayload, staffUnread);

            if (hospital) {
                const hospitalPayload = {
                    ...staffPayload,
                    message: `An interview slot offer for ${title} lapsed because the candidate never picked a time.`
                };
                const { unreadCount: hospitalUnread } = await notificationService.createNotificationWithCount(hospital.userId, 'OFFER_EXPIRED', hospitalPayload);
                await notificationDelivery.deliverToUser(hospital.userId, 'OFFER_EXPIRED', hospitalPayload, hospitalUnread);
            }
        } catch (error) {
            console.error('Error emitting offer-expired notification:', error);
        }
    },

    async emitSelectionExpired(application) {
        try {
            const hospital = await this._resolveHospitalUserId(application.hospitalId);
            const title = await this._vacancyTitle(application.vacancy);
            const staffPayload = {
                type: 'SELECTION_EXPIRED',
                application: { id: application._id },
                message: `The hospital did not confirm your interview for ${title} in time. No interview is scheduled, but the role may still be open.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount: staffUnread } = await notificationService.createNotificationWithCount(application.user, 'SELECTION_EXPIRED', staffPayload);
            await notificationDelivery.deliverToUser(application.user, 'SELECTION_EXPIRED', staffPayload, staffUnread);

            if (hospital) {
                const hospitalPayload = {
                    ...staffPayload,
                    message: `A picked interview slot for ${title} expired unconfirmed. This counts as a lapsed offer.`
                };
                const { unreadCount: hospitalUnread } = await notificationService.createNotificationWithCount(hospital.userId, 'SELECTION_EXPIRED', hospitalPayload);
                await notificationDelivery.deliverToUser(hospital.userId, 'SELECTION_EXPIRED', hospitalPayload, hospitalUnread);
            }
        } catch (error) {
            console.error('Error emitting selection-expired notification:', error);
        }
    },

    async emitHireCloseoutPrompt(hospitalUserId, vacancyTitle, openCount) {
        try {
            const payload = {
                type: 'HIRE_CLOSEOUT_PROMPT',
                vacancyTitle,
                openCount,
                message: `${vacancyTitle} has a hire recorded and ${openCount} other application(s) still open. Close them out when you're ready.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(hospitalUserId, 'HIRE_CLOSEOUT_PROMPT', payload);
            await notificationDelivery.deliverToUser(hospitalUserId, 'HIRE_CLOSEOUT_PROMPT', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting hire-closeout-prompt notification:', error);
        }
    }
};
