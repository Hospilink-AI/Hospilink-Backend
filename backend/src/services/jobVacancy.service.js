const JobVacancy = require('../models/JobVacancy');
const Hospital = require('../models/Hospital');
const MedicalStaff = require('../models/MedicalStaff');
const JobApplication = require('../models/JobApplication');
const { hasCapability } = require('../config/adminPermissions.config');
const { NotFoundError, ForbiddenError, ConflictError } = require('../middleware/error.middleware');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const vacancyMatchingService = require('./vacancyMatching.service');
const cacheService = require('./cache.service');

const VACANCY_FIELDS = ['title', 'specialty', 'experience', 'education', 'skills', 'location', 'salary', 'description'];

function pickVacancyFields(payload) {
    const data = {};
    for (const field of VACANCY_FIELDS) {
        if (payload[field] !== undefined) data[field] = payload[field];
    }
    return data;
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// currentAddress, city, state - pincode — same format as activityLogEmitter.js's
// buildLocationString, so a vacancy's auto-filled location matches how this hospital's
// address already reads everywhere else in the app.
function buildHospitalLocation(hospital) {
    const parts = [hospital.currentAddress, hospital.city, hospital.state]
        .filter(Boolean)
        .map(s => s.trim());
    let location = parts.join(', ');
    if (hospital.pincode) {
        location = location ? `${location} - ${hospital.pincode.trim()}` : hospital.pincode.trim();
    }
    return location || undefined;
}

// After a `.populate('hospitalId', 'hospitalLegalName')` lookup, flatten the populated
// sub-document back down to a plain `hospitalId` + a sibling `hospitalName` string, so
// existing consumers that expect `hospitalId` to be a bare id aren't broken by adding this.
function flattenHospitalName(vacancy) {
    if (vacancy && vacancy.hospitalId && typeof vacancy.hospitalId === 'object') {
        const hospitalName = vacancy.hospitalId.hospitalLegalName;
        vacancy.hospitalId = vacancy.hospitalId._id;
        vacancy.hospitalName = hospitalName;
    }
    return vacancy;
}

class JobVacancyService {
    // Hospital posts its own vacancy — hospitalId resolved from the caller's own token,
    // never accepted from the request body.
    async createForHospitalUser(userId, payload) {
        const hospital = await Hospital.findOne({ user: userId }).select('hospitalLegalName currentAddress city state pincode').lean();
        if (!hospital) {
            throw new NotFoundError('Hospital profile not found. Please complete your profile first.');
        }
        return this._create(hospital, userId, payload);
    }

    // Admin posts on behalf of a named hospital — hospitalId comes from the request
    // body and is validated here (existence + verification), same checks
    // createDutyForHospital already performs for duties.
    async createForHospitalId(hospitalId, createdByUserId, payload) {
        const hospital = await Hospital.findById(hospitalId).select('hospitalLegalName currentAddress city state pincode verificationStatus').lean();
        if (!hospital) {
            throw new NotFoundError('Hospital not found');
        }

        if (hospital.verificationStatus !== 'verified') {
            const statusMessages = {
                pending: 'Cannot create vacancy: hospital verification is still pending.',
                rejected: 'Cannot create vacancy: hospital has been rejected and is not verified.'
            };
            throw new ForbiddenError(
                statusMessages[hospital.verificationStatus] || 'Cannot create vacancy: hospital is not verified.'
            );
        }

        return this._create(hospital, createdByUserId, payload);
    }

    async _create(hospital, createdByUserId, payload) {
        const data = pickVacancyFields(payload);
        if (!data.location) {
            const fallbackLocation = buildHospitalLocation(hospital);
            if (fallbackLocation) data.location = fallbackLocation;
        }

        const vacancy = await JobVacancy.create({
            ...data,
            hospitalId: hospital._id,
            createdBy: createdByUserId
        });

        const result = vacancy.toObject();
        result.hospitalName = hospital.hospitalLegalName;
        return result;
    }

    // Public/staff browse list — always excludes soft-deleted vacancies.
    async listPublic(filters, pagination) {
        const query = { deletedAt: null };
        if (filters.specialty) query.specialty = filters.specialty;
        if (filters.location) query.location = new RegExp(escapeRegex(filters.location), 'i');

        return this._paginatedFind(query, pagination);
    }



    // Staff-personalized browse list — same filtered result set as
    // listPublic, but sorted by a computed match score (jobRole/experience/
    // skills/education/location) instead of createdAt. Hospital/admin
    // callers never reach this method; listVacancies in the controller only
    // calls it for role === 'staff'.
    async listForStaff(userId, filters, pagination) {
        const medicalStaff = await MedicalStaff.findOne({ user: userId })
            .select('jobRole experience city state skills education resumeAnalysis.extractedData.totalExperienceYears resumeAnalysis.extractedData.skills resumeAnalysis.extractedData.education')
            .lean();

        // No profile yet — nothing to score against. GET /vacancies has no
        // profile-completeness gate today and this must not become one, so
        // fall back to the same unscored list a hospital/admin would see.
        if (!medicalStaff) {
            return this.listPublic(filters, pagination);
        }

        const query = { deletedAt: null };
        if (filters.specialty) query.specialty = filters.specialty;
        if (filters.location) query.location = new RegExp(escapeRegex(filters.location), 'i');

        const filterKey = `${filters.specialty || ''}:${filters.location || ''}`;
        let scored = await cacheService.getVacancyMatches(userId, filterKey);

        if (!scored) {
            const vacancies = await JobVacancy.find(query)
                .populate('hospitalId', 'hospitalLegalName')
                .lean();

            scored = vacancies.map(vacancy => {
                const { matchScore, matchBreakdown } = vacancyMatchingService.computeMatchScore(medicalStaff, vacancy);
                return { ...flattenHospitalName(vacancy), matchScore, matchBreakdown };
            });

            // Highest match first; vacancies that couldn't be scored at all
            // (matchScore null — e.g. no comparable data on either side)
            // sort to the end rather than being treated as a 0.
            scored.sort((a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1));

            await cacheService.setVacancyMatches(userId, filterKey, scored, 60);
        }

        const { page, limit, skip } = getPaginationParams(pagination.page, pagination.limit);
        const pageItems = scored.slice(skip, skip + limit);

        return {
            vacancies: pageItems,
            pagination: getPaginationMeta(scored.length, page, limit)
        };
    }



    // A hospital's own postings, including closed (soft-deleted) ones.
    async listMine(userId, pagination) {
        const hospital = await Hospital.findOne({ user: userId }).select('_id').lean();
        if (!hospital) {
            throw new NotFoundError('Hospital profile not found. Please complete your profile first.');
        }

        return this._paginatedFind({ hospitalId: hospital._id }, pagination);
    }



    // Admin oversight view — every vacancy, every hospital, including soft-deleted by default.
    async listAll(filters, pagination) {
        const query = {};
        if (filters.hospitalId) query.hospitalId = filters.hospitalId;
        if (filters.specialty) query.specialty = filters.specialty;
        if (filters.location) query.location = new RegExp(escapeRegex(filters.location), 'i');
        if (filters.activeOnly) query.deletedAt = null;

        return this._paginatedFind(query, pagination);
    }



    async _paginatedFind(query, pagination) {
        const { page, limit, skip } = getPaginationParams(pagination.page, pagination.limit);

        const [vacancies, totalItems] = await Promise.all([
            JobVacancy.find(query)
                .populate('hospitalId', 'hospitalLegalName')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            JobVacancy.countDocuments(query)
        ]);

        return { vacancies: vacancies.map(flattenHospitalName), pagination: getPaginationMeta(totalItems, page, limit) };
    }



    // Single posting detail — visible to anyone if live; visible to the owning hospital
    // or a capable admin even once soft-deleted.
    async getById(vacancyId, requester) {
        const vacancy = await JobVacancy.findById(vacancyId).populate('hospitalId', 'hospitalLegalName').lean();
        if (!vacancy) {
            throw new NotFoundError('Vacancy not found');
        }

        flattenHospitalName(vacancy);

        if (vacancy.deletedAt) {
            const canView = await this._canViewDeleted(vacancy, requester);
            if (!canView) {
                throw new NotFoundError('Vacancy not found');
            }
        }

        return vacancy;
    }



    async editVacancy(vacancyId, requester, payload) {
        const vacancy = await JobVacancy.findById(vacancyId);
        if (!vacancy) {
            throw new NotFoundError('Vacancy not found');
        }

        await this._assertCanManage(vacancy, requester);

        Object.assign(vacancy, pickVacancyFields(payload));
        await vacancy.save();
        await vacancy.populate('hospitalId', 'hospitalLegalName');

        return flattenHospitalName(vacancy.toObject());
    }



    async closeVacancy(vacancyId, requester) {
        const vacancy = await JobVacancy.findById(vacancyId);
        if (!vacancy) {
            throw new NotFoundError('Vacancy not found');
        }

        await this._assertCanManage(vacancy, requester);

        if (!vacancy.deletedAt) {
            // A vacancy with a confirmed interview cannot be closed — only
            // `confirmed` blocks; `interviewed`/`offered`/etc. do not, per
            // the interview-flow spec's literal wording. The recruiter must
            // cancel or record an outcome on that application first.
            const blocking = await JobApplication.findOne({ vacancy: vacancyId, status: 'confirmed' })
                .select('_id')
                .lean();
            if (blocking) {
                throw new ConflictError(
                    `This vacancy has a confirmed interview in progress (application ${blocking._id}). Cancel or record its outcome before closing the vacancy.`
                );
            }

            vacancy.deletedAt = new Date();
            await vacancy.save();
        }
        await vacancy.populate('hospitalId', 'hospitalLegalName');

        return flattenHospitalName(vacancy.toObject());
    }



    async _assertCanManage(vacancy, requester) {
        const allowed = await this._canManage(vacancy, requester);
        if (!allowed) {
            throw new ForbiddenError("You don't have permission to do that.");
        }
    }



    // Edit/close: owning hospital, or an admin sub-role with `vacancy.manage`
    // (super_admin bypasses via hasCapability itself).
    async _canManage(vacancy, requester) {
        if (requester.role === 'admin') {
            return hasCapability(requester.adminSubRole, 'vacancy.manage');
        }
        return this._isOwnerHospital(vacancy, requester);
    }


    
    // Viewing a soft-deleted detail page: owning hospital, or an admin with either
    // view or manage capability.
    async _canViewDeleted(vacancy, requester) {
        if (requester.role === 'admin') {
            return hasCapability(requester.adminSubRole, 'vacancy.manage') ||
                hasCapability(requester.adminSubRole, 'vacancy.view');
        }
        return this._isOwnerHospital(vacancy, requester);
    }

    async _isOwnerHospital(vacancy, requester) {
        if (requester.role !== 'hospital') return false;
        const hospital = await Hospital.findOne({ user: requester.id }).select('_id').lean();
        return !!hospital && hospital._id.toString() === vacancy.hospitalId.toString();
    }
}

module.exports = new JobVacancyService();
