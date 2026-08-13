const express = require('express');
const router = express.Router();
const jobVacancyController = require('../controllers/jobVacancy.controller');
const { validateObjectId, validatePagination } = require('../middleware/validation.middleware');

// Public vacancy browsing
router.get(
    '/vacancies/public',
    validatePagination,
    jobVacancyController.listVacanciesPublic
);

router.get(
    '/vacancies/public/:id',
    validateObjectId('id'),
    jobVacancyController.getVacancyPublic
);

module.exports = router;
