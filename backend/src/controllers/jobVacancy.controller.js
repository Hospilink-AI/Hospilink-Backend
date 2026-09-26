const jobVacancyService = require('../services/jobVacancy.service');
const { asyncHandler } = require('../middleware/error.middleware');


// POST /api/vacancy — hospital posts its own vacancy. hospitalId is resolved from
// the token inside the service — never accepted from the request body.
exports.createVacancy = asyncHandler(async (req, res) => {
    const vacancy = await jobVacancyService.createForHospitalUser(req.user.id, req.body);

    res.status(201).json({
        success: true,
        vacancy,
        message: 'Vacancy posted successfully'
    });
});



// GET /api/vacancies — public/staff browse list. Any authenticated staff/hospital/admin
// account can browse — candidate or existing marketplace staff, no candidacy check.
// Staff callers get a personalized, match-score-sorted list (listForStaff);
// hospital/admin get exactly the same unscored, date-sorted list as always.
exports.listVacancies = asyncHandler(async (req, res) => {
    const { specialty, location, page = 1, limit = 10 } = req.query;
    const filters = { specialty, location };
    const paginationParams = { page: parseInt(page), limit: parseInt(limit) };

    const result = req.user.role === 'staff'
        ? await jobVacancyService.listForStaff(req.user.id, filters, paginationParams)
        : await jobVacancyService.listPublic(filters, paginationParams);

    res.status(200).json({
        success: true,
        count: result.vacancies.length,
        data: result.vacancies,
        pagination: result.pagination
    });
});



exports.listVacanciesPublic = asyncHandler(async (req, res) => {
    const { specialty, location, page = 1, limit = 10 } = req.query;

    const result = await jobVacancyService.listPublic(
        { specialty, location },
        { page: parseInt(page), limit: parseInt(limit) }
    );

    res.status(200).json({
        success: true,
        count: result.vacancies.length,
        data: result.vacancies,
        pagination: result.pagination
    });
});



exports.getVacancyPublic = asyncHandler(async (req, res) => {
    const vacancy = await jobVacancyService.getById(req.params.id, { role: null });

    res.status(200).json({
        success: true,
        vacancy
    });
});



// GET /api/vacancies/posted — a hospital's own postings, including closed ones.
exports.listMyVacancies = asyncHandler(async (req, res) => {
    const { page = 1, limit = 10 } = req.query;

    const result = await jobVacancyService.listMine(req.user.id, {
        page: parseInt(page),
        limit: parseInt(limit)
    });

    res.status(200).json({
        success: true,
        count: result.vacancies.length,
        data: result.vacancies,
        pagination: result.pagination
    });
});



// GET /api/vacancies/:id — single posting detail, shared by candidate/staff,
// the owning hospital, and admin.
exports.getVacancy = asyncHandler(async (req, res) => {
    const vacancy = await jobVacancyService.getById(req.params.id, req.user);

    res.status(200).json({
        success: true,
        vacancy
    });
});



// PATCH /api/vacancies/:id — edit fields. Shared route: ownership (hospital) or
// capability (admin) is checked inside the service, not here.
exports.editVacancy = asyncHandler(async (req, res) => {
    const vacancy = await jobVacancyService.editVacancy(req.params.id, req.user, req.body);

    res.status(200).json({
        success: true,
        vacancy,
        message: 'Vacancy updated successfully'
    });
});



// PATCH /api/vacancies/:id/close — sets deletedAt, the only lifecycle control.
exports.closeVacancy = asyncHandler(async (req, res) => {
    const vacancy = await jobVacancyService.closeVacancy(req.params.id, req.user);

    res.status(200).json({
        success: true,
        vacancy,
        message: 'Vacancy closed successfully'
    });
});
