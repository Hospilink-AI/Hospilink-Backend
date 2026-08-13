const { GoogleGenerativeAI } = require('@google/generative-ai');
const { z } = require('zod');
const { ALLOWED_ROLES } = require('../utils/constants');
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
    // .catch([]) here handles an explicit `"education": null` from the model —
    // .default([]) alone only substitutes for `undefined`, not `null`.
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
    // `total` from the model is intentionally ignored after validation — see
    // recomputeTotal() below. Only `breakdown` is trusted; the total is always
    // derived server-side so it can never disagree with its own breakdown.
    score: z.object({ breakdown: ScoreBreakdownSchema }).catch({ breakdown: ZERO_BREAKDOWN }),
    suggestions: z.array(z.string().catch('')).catch([])
});

// Only these ever get written to the real MedicalStaff profile fields, and
// only once, at first creation — see profile.service.js.
const AUTHORITATIVE_FIELDS = ['jobRole', 'experience', 'education', 'skills', 'profileSummary'];



function cleanExtracted(parsed) {
    const breakdown = parsed.score.breakdown;
    const total = SCORE_CATEGORIES.reduce((sum, key) => sum + (breakdown[key] || 0), 0);

    return {
        ...parsed,
        education: parsed.education.filter(e => e.universityName || e.speciality),
        skills: parsed.skills.filter(Boolean),
        achievements: parsed.achievements.filter(Boolean),
        certifications: parsed.certifications.filter(Boolean),
        suggestions: parsed.suggestions.filter(Boolean),
        score: { total, breakdown }
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
  "education": [{ "universityName": string, "speciality": string, "startYear": number or null, "endYear": number or null }] — ONLY post-secondary professional/medical qualifications (e.g. MBBS, MD, MS, BHMS, BAMS, BDS, DHMS, GNM, BSc Nursing, ANM, BPT, B.Pharm, D.Pharm, and equivalent diplomas). NEVER include school-level qualifications (SSC, HSC, "10th," "12th," or any secondary-school entry) — these appear on nearly every Indian resume alongside the real qualification and must be skipped entirely, not just deprioritized.,
  "skills": [string],
  "profileSummary": string or null (ONLY if the resume itself contains an explicit Summary, Objective, or Professional Profile section — closely paraphrase what THAT SECTION states. If the resume has no such section, this MUST be null. Never compose or synthesize a summary yourself from other parts of the resume, no matter how easy it would be to write one — this field reports what the document says, not what you think it should say.),
  "jobTitleText": string or null (this person's overall professional identity, judged from the WHOLE resume together — skills, projects, achievements, and experience — not simply copied from the title of their single most recent job or internship entry. Example: someone whose most recent internship was titled "Marketing Intern" but whose skills/projects are overwhelmingly backend engineering should NOT get "Marketing Intern" here. If the resume explicitly states a job title, career objective, or "seeking X role" line anywhere, use that exact wording instead of inferring one.),
  "location": string or null (city/area the resume states as their location — Indian resumes often give a village/taluka/district format, e.g. "At Dongargan, Tal-Shirur, Dist-Pune," rather than "City, State." Extract it as-is, however it's formatted.),
  "resumeEmail": string or null (email address as printed on the resume, if any),
  "resumePhone": string or null (phone number as printed on the resume, if any — if multiple numbers are given, use the first one),
  "achievements": [string] (measurable accomplishments with a concrete outcome or number — not restated job duties. Only include one if the resume text itself states it explicitly. Empty array if none.),
  "certifications": [string] (credentials, registrations, or licenses — ONLY if their exact name or number is explicitly printed in the resume text. This includes registration numbers stated inline right next to a degree name, e.g. "BHMS {RegNo.90073}" or "BAMS / REG. NO. I-117349-A" — scan the ENTIRE document for these, not just a section explicitly labeled "Certifications" or "Licenses." Do NOT include a certification just because it would be typical or expected for this person's field — if the resume does not mention any certification or registration number anywhere, this MUST be an empty array, not a guess.),
  "score": {
    "breakdown": {
      "education": number 0-20,
      "experience": number 0-20,
      "skills": number 0-20,
      "achievements": number 0-20,
      "certifications": number 0-20
    }
  },
  "suggestions": [string] (exactly 3-5 items, ordered from lowest-scoring category to highest. Each is ONE sentence, under 20 words, and does one of two things: (a) names a specific concrete thing to add — e.g. a real metric missing from a real project already named in the resume, or a certification type genuinely relevant to THIS person's actual field; or (b) points at a specific existing line/section by name and says what's weak about it. Never generic career advice that could apply to any resume — "add more detail," "gain more experience," "network more" are all forbidden.)
}

Indian resume conventions — read before extracting:
- Nearly every resume includes a "Personal Information"/"Personal Details" block with father's name, mother's name, date of birth, marital status, nationality, caste, and/or religion. IGNORE all of this entirely — never extract any of it into any field, including profileSummary. It has no home in this schema and must not appear anywhere in the output.
- Education tables/lists almost always give only a single passing/completion year, never a start-end range (e.g. "BHMS...IN 2025," "DHMS Mumbai, 1987"). When only one year is stated, put it in endYear and leave startYear null — never back-calculate a start year from typical program length; that would be a guess, not an extraction.
- A qualification whose stated year is the current year or later, or explicitly marked "Appear"/"Appearing"/"Pursuing," means the candidate has NOT yet completed it. Still include it in education (it's their real claimed qualification), but do not let it push jobRole toward the fully-qualified specialization as if they'd already finished — reflect their actual current role/title instead.
- Work-experience entries frequently list only a hospital name and sometimes a role, with NO dates or duration — this is normal, not a parsing failure. Sum only what's actually stated; if nothing anywhere gives a duration, experience must be null (see above).
- jobRole needs real textual support, not a default: if the candidate's ONLY qualification is still incomplete ("Appear"/"Appearing"/"Pursuing," per the rule above) AND no work-experience entry anywhere states a job title in words, jobRole MUST be null. Do not fill it with the most common-sounding role (e.g. RMO) just because the candidate works at a hospital — a hospital name alone is not evidence of a specific role. Only infer a role (rather than copy stated words) when there's a completed qualification or an actually-titled work entry to reason from, as in the hints above.

Score each category 0-20 using this rubric:
- education: are institution, degree, and dates clearly and completely stated?
- experience: is work history specific (roles, duration, responsibilities), not vague?
- skills: are listed skills specific and relevant to a hospital/clinical role, not generic filler?
- achievements: are there measurable outcomes, not just restated duties? Zero or near-zero if none found.
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
