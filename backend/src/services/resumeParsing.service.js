const { GoogleGenerativeAI } = require('@google/generative-ai');
const { z } = require('zod');
const { ALLOWED_ROLES, SPECIALTY_FAMILIES } = require('../utils/constants');
const logger = require('../utils/logger');


const EXPERIENCE_BUCKETS = [
    '0-1 year', '1-3 years', '3-5 years', '5-10 years',
    '10-15 years', '15-20 years', '20+ years'
];

// Fallback list, same pattern as agent/modules/extractor.js — try the fast/cheap
// model first, fall back to the heavier one only if it fails.
// const MODELS = [
//     process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
//     'gemini-2.5-flash'
// ];

const MODELS = [
    process.env.GEMINI_MODEL || process.env.GEMINI_MODEL_FALLBACK,
];

let genAI = null;
function getClient() {
    if (!genAI) {
        genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    }
    return genAI;
}


const EducationEntrySchema = z.object({
    universityName: z.string().catch(''),
    speciality: z.string().catch(''),
    // z.coerce.number() accepts "2018" as well as 2018 — Gemini doesn't always
    // honor "number" strictly despite the prompt instruction.
    startYear: z.coerce.number().int().nullable().catch(null),
    endYear: z.coerce.number().int().nullable().catch(null)
});


const ExperienceEntrySchema = z.object({
    employer: z.string().nullable().catch(null),
    role: z.string().nullable().catch(null),
    startDate: z.string().nullable().catch(null),
    endDate: z.string().nullable().catch(null),
    isCurrent: z.boolean().catch(false)
}).catch({ employer: null, role: null, startDate: null, endDate: null, isCurrent: false });

const SCORE_CATEGORIES = ['education', 'experience', 'skills', 'achievements', 'certifications'];
const ZERO_BREAKDOWN = { education: 0, experience: 0, skills: 0, achievements: 0, certifications: 0 };

const ScoreBreakdownSchema = z.object({
    education: z.coerce.number().min(0).max(20).catch(0),
    experience: z.coerce.number().min(0).max(20).catch(0),
    skills: z.coerce.number().min(0).max(20).catch(0),
    achievements: z.coerce.number().min(0).max(20).catch(0),
    certifications: z.coerce.number().min(0).max(20).catch(0)
}).catch(ZERO_BREAKDOWN);

const ExtractedResumeSchema = z.object({
    // Authoritative
    fullName: z.string().nullable().catch(null),
    jobRole: z.enum(ALLOWED_ROLES).nullable().catch(null),
    experience: z.enum(EXPERIENCE_BUCKETS).nullable().catch(null),
    education: z.array(EducationEntrySchema).catch([]),
    skills: z.array(z.string().catch('')).catch([]),
    profileSummary: z.string().nullable().catch(null),
    // Advisory
    jobTitleText: z.string().nullable().catch(null),
    location: z.string().nullable().catch(null),
    resumeEmail: z.string().nullable().catch(null),
    resumePhone: z.string().nullable().catch(null),
    achievements: z.array(z.string().catch('')).catch([]),
    certifications: z.array(z.string().catch('')).catch([]),
    score: z.object({ breakdown: ScoreBreakdownSchema }).catch({ breakdown: ZERO_BREAKDOWN }),
    suggestions: z.array(z.string().catch('')).catch([]),
    resumeScoreSummary: z.string().nullable().catch(null),
    dateOfBirth: z.string().nullable().catch(null),
    gender: z.string().nullable().catch(null),
    city: z.string().nullable().catch(null),
    district: z.string().nullable().catch(null),
    experienceEntries: z.array(ExperienceEntrySchema).catch([]),
    expectedSalary: z.string().nullable().catch(null),
    registrationNumber: z.string().nullable().catch(null)
});

// Only these ever get written to the real MedicalStaff profile fields, and
// only once, at first creation — see profile.service.js.
const AUTHORITATIVE_FIELDS = ['jobRole', 'experience', 'education', 'skills', 'profileSummary'];




function parseDateToMonthIndex(value) {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim();

    const ymMatch = trimmed.match(/^(\d{4})-(\d{1,2})$/);
    if (ymMatch) {
        const year = parseInt(ymMatch[1], 10);
        const month = parseInt(ymMatch[2], 10);
        if (month >= 1 && month <= 12) return year * 12 + (month - 1);
    }

    const yearOnlyMatch = trimmed.match(/^(\d{4})$/);
    if (yearOnlyMatch) {
        return parseInt(yearOnlyMatch[1], 10) * 12 + 5;
    }

    return null;
}



function computeTotalExperienceYears(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return null;

    const now = new Date();
    const currentMonthIndex = now.getUTCFullYear() * 12 + now.getUTCMonth();

    let totalMonths = 0;
    let hasValidEntry = false;

    for (const entry of entries) {
        const startMonth = parseDateToMonthIndex(entry.startDate);
        if (startMonth === null) continue;

        const endMonth = entry.isCurrent ? currentMonthIndex : parseDateToMonthIndex(entry.endDate);
        if (endMonth === null) continue;

        const duration = endMonth - startMonth;
        if (duration > 0) {
            totalMonths += duration;
            hasValidEntry = true;
        }
    }

    if (!hasValidEntry) return null;
    return Math.round((totalMonths / 12) * 10) / 10;
}

function deriveCurrentEmployer(entries) {
    if (!Array.isArray(entries)) return null;
    const current = entries.find(e => e.isCurrent && e.employer);
    return current ? current.employer : null;
}

function getSpecialtyFamily(jobRole) {
    if (!jobRole) return null;
    return SPECIALTY_FAMILIES[jobRole] || null;
}



function computeAgeFromDOB(dateOfBirth) {
    if (!dateOfBirth || typeof dateOfBirth !== 'string') return null;
    const trimmed = dateOfBirth.trim();

    let birthDate;
    const fullMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (fullMatch) {
        birthDate = new Date(Date.UTC(+fullMatch[1], +fullMatch[2] - 1, +fullMatch[3]));
    } else {
        const yearOnlyMatch = trimmed.match(/^(\d{4})$/);
        if (yearOnlyMatch) {
            // Only a birth year is known — Jan 1 is an approximation, fine
            // for a display-only "age in years" figure.
            birthDate = new Date(Date.UTC(+yearOnlyMatch[1], 0, 1));
        } else {
            return null;
        }
    }

    if (isNaN(birthDate.getTime())) return null;

    const today = new Date();
    let age = today.getUTCFullYear() - birthDate.getUTCFullYear();
    const monthDiff = today.getUTCMonth() - birthDate.getUTCMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getUTCDate() < birthDate.getUTCDate())) {
        age--;
    }

    return age >= 0 && age < 120 ? age : null;
}

function cleanExtracted(parsed) {
    const breakdown = parsed.score.breakdown;
    const total = SCORE_CATEGORIES.reduce((sum, key) => sum + (breakdown[key] || 0), 0);

    const experienceEntries = parsed.experienceEntries.filter(e => e.employer || e.role);

    return {
        ...parsed,
        education: parsed.education.filter(e => e.universityName || e.speciality),
        skills: parsed.skills.filter(Boolean),
        achievements: parsed.achievements.filter(Boolean),
        certifications: parsed.certifications.filter(Boolean),
        suggestions: parsed.suggestions.filter(Boolean),
        score: { total, breakdown },
        experienceEntries,
        age: computeAgeFromDOB(parsed.dateOfBirth),
        totalExperienceYears: computeTotalExperienceYears(experienceEntries),
        currentEmployer: deriveCurrentEmployer(experienceEntries),
        specialtyFamily: getSpecialtyFamily(parsed.jobRole)
    };
}




const EMPTY_RESULT = {
    fullName: null,
    jobRole: null,
    experience: null,
    education: [],
    skills: [],
    profileSummary: null,
    jobTitleText: null,
    location: null,
    resumeEmail: null,
    resumePhone: null,
    achievements: [],
    certifications: [],
    score: { total: 0, breakdown: ZERO_BREAKDOWN },
    suggestions: [],
    resumeScoreSummary: null,
    age: null,
    gender: null,
    city: null,
    district: null,
    specialtyFamily: null,
    totalExperienceYears: null,
    experienceEntries: [],
    currentEmployer: null,
    expectedSalary: null,
    registrationNumber: null,
    filledFields: [],
    parsedSuccessfully: false
};




const JOB_ROLE_HINTS = `- "RMO" (stated explicitly) -> rmo
- "DMO" (stated explicitly) -> dmo
- "Medical Practitioner" or "General Practice" (no further specialization stated) -> general_physician
- "Assistant Surgeon" / "Surgery Resident" (especially alongside an MS General Surgery degree, even if still in progress) -> general_surgeon
- "Staff Nurse" / "GNM" -> staff_nurse
- "ICU Nurse" / "Critical Care Nurse" -> icu_nurse
- "MLT" / "Lab Technician" -> lab_technician
This list is illustrative, not exhaustive — reason from context using the same logic for phrasings not listed here. Only ever output one of the exact enum values given above, or null.`;



function buildPrompt(resumeText) {
    return `You are extracting structured data from a medical professional's resume for a hospital staffing platform, and assessing the resume's quality. Many resumes you see will be from Indian candidates (a large share BHMS/BAMS/RMO-DMO track) and will follow conventions a generic resume parser wouldn't expect — see the "Indian resume conventions" section below before extracting anything.

Return STRICT JSON only — no prose, no markdown code fences, matching exactly this shape:
{
  "fullName": string or null,
  "jobRole": one of ${JSON.stringify(ALLOWED_ROLES)}, or null if none is a confident match. Use these real-world phrasing hints:
${JOB_ROLE_HINTS}
  "experience": one of ${JSON.stringify(EXPERIENCE_BUCKETS)}, or null if total experience can't be confidently bucketed. Many resumes state job titles with NO dates or durations anywhere for any role — when that's true, this MUST be null; do not estimate from the number of roles listed or their titles alone.,
  "education": [{ "universityName": string, "speciality": string, "startYear": number or null, "endYear": number or null }] — EVERY qualification the resume lists, in the order they appear. This includes school-level entries (SSC, HSC, "10th," "12th" — use the board name, e.g. "Maharashtra State Board," as "universityName" and "SSC"/"HSC"/"10th"/"12th" as "speciality") as well as every post-secondary professional/medical qualification (e.g. MBBS, MD, MS, BHMS, BAMS, BDS, DHMS, GNM, BSc Nursing, ANM, BPT, B.Pharm, D.Pharm, and equivalent diplomas). Include EVERY entry as its own separate array item — a candidate with SSC, HSC, an MBBS, and a later MD/MS/fellowship has FOUR entries here, not just the highest or most recent one. Never collapse, merge, or drop down to a single "best" qualification when the resume states more than one.,
  "skills": [string] (clinical/professional COMPETENCIES and PROCEDURES the candidate can perform — e.g. "Ventilator management", "IV cannulation", "Patient diagnosis", "ECG interpretation", "OPD management", "Suturing" — drawn from an explicit Skills section, or clearly stated capabilities elsewhere. Do NOT put exam names, board certifications, licenses, or registration numbers here — an item like "BLS/ACLS", "USMLE STEP 1", or "ECFMG certified" belongs ONLY in "certifications" below, never duplicated into skills, even if it appears in a section titled "Accreditations" or similar. If the resume has no distinct skills section and no clearly stated competencies anywhere, this MUST be an empty array — never repurpose certification/accreditation content as skills just to have something to show.),
  "profileSummary": string or null (ONLY if the resume itself contains an explicit Summary, Objective, or Professional Profile section — closely paraphrase what THAT SECTION states. If the resume has no such section, this MUST be null. Never compose or synthesize a summary yourself from other parts of the resume, no matter how easy it would be to write one — this field reports what the document says, not what you think it should say. If the section is itself filler/placeholder text (e.g. "Lorem ipsum dolor sit amet..." or other obviously non-real template text), still extract it verbatim — do not silently substitute or improve it — but do not let it inform any other field either.),
  "jobTitleText": string or null (this person's overall professional identity, judged from the WHOLE resume together — skills, projects, achievements, and experience — not simply copied from the title of their single most recent job or internship entry. Example: someone whose most recent internship was titled "Marketing Intern" but whose skills/projects are overwhelmingly backend engineering should NOT get "Marketing Intern" here. If the resume explicitly states a job title, career objective, or "seeking X role" line anywhere, use that exact wording instead of inferring one.),
  "location": string or null (city/area the resume states as their location — Indian resumes often give a village/taluka/district format, e.g. "At Dongargan, Tal-Shirur, Dist-Pune," rather than "City, State." Extract it as-is, however it's formatted.),
  "resumeEmail": string or null (email address as printed on the resume, if any),
  "resumePhone": string or null (phone number as printed on the resume, if any — if multiple numbers are given, use the first one),
  "achievements": [string] (concrete, specific accomplishments — not restated job duties. A number/metric is the strongest form of this (e.g. "reduced patient readmission by 15%"), but it is NOT required — a genuine qualitative accomplishment counts too, as long as it names a specific, real event or recognition: a conference/poster presentation, a publication, an award, a named fellowship or program selection, leading a named initiative. A vague restated duty does NOT count (e.g. "responsible for patient care" is a duty, not an achievement, even if phrased as one). Only include one if the resume text itself states it explicitly. Empty array if none.),
  "certifications": [string] (credentials, registrations, or licenses — ONLY if their exact name or number is explicitly printed in the resume text. This includes registration numbers stated inline right next to a degree name, e.g. "BHMS {RegNo.90073}" or "BAMS / REG. NO. I-117349-A", and exam/board credentials like "USMLE STEP 1", "ECFMG certified", "BLS/ACLS" wherever they appear (an "Accreditations" section counts) — scan the ENTIRE document for these, not just a section explicitly labeled "Certifications" or "Licenses." These items belong here ONLY — never also list them under "skills" above. Do NOT include a certification just because it would be typical or expected for this person's field — if the resume does not mention any certification or registration number anywhere, this MUST be an empty array, not a guess.),
  "dateOfBirth": string or null (in YYYY-MM-DD format if a full date is explicitly stated, or just YYYY if only a birth year is stated. This is ONLY ever used internally to compute an age in years — the value you return here is discarded immediately after that calculation and never stored or shown to anyone. Extract it if present; do not guess it.),
  "gender": string or null (exactly as stated, e.g. "Male", "Female" — only if the resume explicitly states it; never infer it from a name or title),
  "city": string or null (just the city/town/village settlement name, e.g. "Pune" or "Dongargan" — not the district or state),
  "district": string or null (the district name, e.g. "Pune" from "Dist-Pune" or "Dist. Jalna" — Indian resumes often state this explicitly; extract it separately from "city" even when they happen to be the same word),
  "experienceEntries": [{ "employer": string or null, "role": string or null, "startDate": string in YYYY-MM format (or YYYY if only a year is given) or null, "endDate": string in the same format or null, "isCurrent": boolean }] (one entry per distinct work-experience listing, in the order they appear. Set "isCurrent" to true only if that entry is explicitly the candidate's present/ongoing role — e.g. dates ending in "Present"/"Current"/"Till date", or explicitly described as their current position — and leave "endDate" null in that case rather than guessing today's date. If a listing gives no dates at all, still include it with startDate and endDate both null — do not drop it, and do not estimate dates from context or job order. Empty array if the resume has no work-experience section at all.),
  "expectedSalary": string or null (ONLY if the resume explicitly states an expected salary/CTC figure, e.g. "Expected CTC: 6 LPA" — exactly as printed. This is rare on a resume; null is the normal, expected case.),
  "registrationNumber": string or null (the council/medical-board registration number itself, e.g. "90073" from "BHMS {RegNo.90073}", or "I-117349-A" from "BAMS / REG. NO. I-117349-A" — just the number/code, not the surrounding degree name. If more than one appears, use the first. Extract this in addition to, not instead of, whatever you already put in "certifications" above — the same text can legitimately appear in both places.),
  "score": {
    "breakdown": {
      "education": number 0-20,
      "experience": number 0-20,
      "skills": number 0-20,
      "achievements": number 0-20,
      "certifications": number 0-20
    }
  },
  "suggestions": [string] (exactly 3-5 items, ordered from lowest-scoring category to highest. Each is ONE sentence, under 20 words, and does one of two things: (a) names a specific concrete thing to add — e.g. a real metric missing from a real project already named in the resume, or a certification type genuinely relevant to THIS person's actual field; or (b) points at a specific existing line/section by name and says what's weak about it. Never generic career advice that could apply to any resume — "add more detail," "gain more experience," "network more" are all forbidden.),
  "resumeScoreSummary": string (EXACTLY 3-4 short sentences, plain language, explaining the score breakdown above. Name the 1-2 strongest categories and specifically why — reference what's actually present in THIS resume (e.g. "Certifications score well because real board and license credentials with dates are listed"). Then name the 1-2 weakest categories and specifically why, referencing what's actually missing (e.g. "Skills scores low because the resume has no dedicated skills section" or "Achievements scores low because only routine duties are listed, with no specific outcomes or recognitions stated"). Every sentence must be tied to what this specific resume does or doesn't contain — never generic filler that could apply to any resume.)
}

Indian resume conventions — read before extracting:
- Nearly every resume includes a "Personal Information"/"Personal Details" block with father's name, mother's name, date of birth, marital status, nationality, caste, and/or religion. IGNORE all of it — never extract any of it into any field, including profileSummary. Date of birth and gender are the only two exceptions from that block, extracted specifically into their own "dateOfBirth" and "gender" fields above (per their own descriptions) — nothing else from that section has any home in this schema.
- Education tables/lists almost always give only a single passing/completion year, never a start-end range (e.g. "BHMS...IN 2025," "DHMS Mumbai, 1987"). When only one year is stated, put it in endYear and leave startYear null — never back-calculate a start year from typical program length; that would be a guess, not an extraction.
- A qualification whose stated year is the current year or later, or explicitly marked "Appear"/"Appearing"/"Pursuing," means the candidate has NOT yet completed it. Still include it in education (it's their real claimed qualification), but do not let it push jobRole toward the fully-qualified specialization as if they'd already finished — reflect their actual current role/title instead.
- Work-experience entries frequently list only a hospital name and sometimes a role, with NO dates or duration — this is normal, not a parsing failure. Sum only what's actually stated; if nothing anywhere gives a duration, experience must be null (see above).
- jobRole needs real textual support, not a default: if the candidate's ONLY qualification is still incomplete ("Appear"/"Appearing"/"Pursuing," per the rule above) AND no work-experience entry anywhere states a job title in words, jobRole MUST be null. Do not fill it with the most common-sounding role (e.g. RMO) just because the candidate works at a hospital — a hospital name alone is not evidence of a specific role. Only infer a role (rather than copy stated words) when there's a completed qualification or an actually-titled work entry to reason from, as in the hints above.

Score each category 0-20 using this rubric:
- education: are institution, degree, and dates clearly and completely stated?
- experience: is work history specific (roles, duration, responsibilities), not vague?
- skills: are listed skills specific and relevant to a hospital/clinical role, not generic filler?
- achievements: are there genuine, specific accomplishments — numeric metrics, conference/poster presentations, publications, awards, named fellowships, leadership of a named initiative — not vague restated duties? A numeric metric is not required for a good score here; a real, specific qualitative accomplishment counts too. Zero only if none found at all.
- certifications: are relevant credentials/registrations present? Zero if none found.

Rules:
- Only pick a "jobRole" value from the exact list given above — never invent a new one.
- If nothing in the resume clearly supports a field, use null (or an empty array, or 0 for a score category) rather than guessing.
- Do not assume this resume belongs to a medical professional just because the platform is a hospital staffing platform — extract only what the resume text actually contains, even if it describes a completely unrelated field. Never add a skill, achievement, certification, or summary typical of healthcare roles unless it is explicitly present in the text.
- Nothing in this response should ever be composed or inferred-into-existence by you — every field reports what the resume text actually contains. A genuine absence is itself useful information (that's what a low score and a targeted suggestion communicate) — never paper over an absence by generating plausible-sounding content.

Resume text:
"""
${resumeText.slice(0, 12000)}
"""`;
}




function computeFilledFields(parsed) {
    return AUTHORITATIVE_FIELDS.filter(key => {
        const value = parsed[key];
        if (value === null || value === undefined) return false;
        if (Array.isArray(value)) return value.length > 0;
        return true;
    });
}



exports.parseResumeText = async (resumeText) => {
    if (!resumeText || !resumeText.trim()) {
        return { ...EMPTY_RESULT };
    }

    if (!process.env.GEMINI_API_KEY) {
        logger.warn('resumeParsing.service: GEMINI_API_KEY not configured — skipping AI extraction');
        return { ...EMPTY_RESULT };
    }

    const client = getClient();
    const prompt = buildPrompt(resumeText);

    for (const modelName of MODELS) {
        try {
            const model = client.getGenerativeModel({
                model: modelName,
                generationConfig: {
                    responseMimeType: 'application/json',
                    // Low, not zero — scoring/structuring wants consistency
                    // across repeated runs on the same resume, not creative
                    // variance.
                    temperature: 0.2
                }
            });

            const result = await model.generateContent(prompt);
            const raw = JSON.parse(result.response.text());
            const parsed = cleanExtracted(ExtractedResumeSchema.parse(raw));

            return {
                fullName: parsed.fullName,
                jobRole: parsed.jobRole,
                experience: parsed.experience,
                education: parsed.education,
                skills: parsed.skills,
                profileSummary: parsed.profileSummary,
                jobTitleText: parsed.jobTitleText,
                location: parsed.location,
                resumeEmail: parsed.resumeEmail,
                resumePhone: parsed.resumePhone,
                achievements: parsed.achievements,
                certifications: parsed.certifications,
                score: parsed.score,
                suggestions: parsed.suggestions,
                resumeScoreSummary: parsed.resumeScoreSummary,
                age: parsed.age,
                gender: parsed.gender,
                city: parsed.city,
                district: parsed.district,
                specialtyFamily: parsed.specialtyFamily,
                totalExperienceYears: parsed.totalExperienceYears,
                experienceEntries: parsed.experienceEntries,
                currentEmployer: parsed.currentEmployer,
                expectedSalary: parsed.expectedSalary,
                registrationNumber: parsed.registrationNumber,
                filledFields: computeFilledFields(parsed),
                parsedSuccessfully: true
            };
        } catch (err) {
            logger.warn(`resumeParsing.service: model "${modelName}" failed: ${err.message}`);
            // try the next model in the fallback list
        }
    }

    logger.error('resumeParsing.service: all models failed — returning empty extraction');
    return { ...EMPTY_RESULT };
};
