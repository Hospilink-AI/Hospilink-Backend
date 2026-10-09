// Admin: vacancies and applications (passes through to the vacancy services)
// Methods of AdminService; mixed into the class in ../admin.service.js, so `this` is the service.
const JobVacancyService = require('../jobVacancy.service');
const JobApplicationService = require('../jobApplication.service');

module.exports = {
    // POST /api/admin/vacancy — admin posts a vacancy on behalf of a named hospital.
    // Hospital existence + verification checks live in JobVacancyService itself so
    // they aren't duplicated between the hospital-flow and admin-flow entry points.
    async createVacancyForHospital(hospitalId, adminUserId, vacancyPayload) {
        return JobVacancyService.createForHospitalId(hospitalId, adminUserId, vacancyPayload);
    },

    // GET /api/admin/vacancies — every vacancy across every hospital, including
    // soft-deleted ones unless filters.activeOnly is set.
    async listAllVacancies(filters, pagination) {
        return JobVacancyService.listAll(filters, pagination);
    },

    // GET /api/admin/vacancy-applications — cross-hospital oversight list, no
    // ownership scoping. Gated on the application.view capability at the route.
    async listAllVacancyApplications(filters, pagination) {
        return JobApplicationService.listAllForAdmin(filters, pagination);
    },

    // GET /api/admin/vacancy-applications/:applicationId — full record,
    // including the no-show/dispute history that's never shown to hospitals.
    // Bypasses the hospital tier projector entirely (JobApplicationService.getById
    // only applies it when requester.role === 'hospital').
    async getVacancyApplicationDetail(applicationId, adminUser) {
        return JobApplicationService.getById(applicationId, adminUser);
    }
};
