const express = require('express');
const router = express.Router();
const jobVacancyController = require('../controllers/jobVacancy.controller');
const { protect, authorize, checkSuspension } = require('../middleware/auth.middleware');
const { requireHospitalVerification } = require('../middleware/accountsVerification.middleware');
const {
    validateJobVacancyCreation,
    validateJobVacancyEdit,
    validateObjectId,
    validatePagination
} = require('../middleware/validation.middleware');

router.use(protect);
router.use(checkSuspension);

// Hospital posts its own vacancy
router.post(
    '/vacancy',
    authorize('hospital'),
    requireHospitalVerification,
    validateJobVacancyCreation,
    jobVacancyController.createVacancy
);

// Hospital's own postings — must be declared before '/vacancies/:id' below
router.get(
    '/vacancies/posted',
    authorize('hospital'),
    requireHospitalVerification,
    validatePagination,
    jobVacancyController.listMyVacancies
);

router.get(
    '/vacancies',
    authorize('staff', 'hospital', 'admin'),
    validatePagination,
    jobVacancyController.listVacancies
);

// Single posting detail — shared by candidate/staff, owning hospital, and admin
router.get(
    '/vacancies/:id',
    authorize('staff', 'hospital', 'admin'),
    validateObjectId('id'),
    jobVacancyController.getVacancy
);

// Edit — ownership (hospital) or capability (admin) checked inside the service
router.patch(
    '/vacancies/:id',
    authorize('hospital', 'admin'),
    validateObjectId('id'),
    validateJobVacancyEdit,
    jobVacancyController.editVacancy
);

// Close — sets deletedAt, the only lifecycle control
router.patch(
    '/vacancies/:id/close',
    authorize('hospital', 'admin'),
    validateObjectId('id'),
    jobVacancyController.closeVacancy
);

module.exports = router;
