const { SPECIALTY_FAMILIES } = require('../utils/constants');


// Representative numeric years for each experience bucket — only used as a
// fallback when a candidate has no resume-derived totalExperienceYears.
const EXPERIENCE_BUCKET_YEARS = {
    '0-1 year': 0.5,
    '1-3 years': 2,
    '3-5 years': 4,
    '5-10 years': 7.5,
    '10-15 years': 12.5,
    '15-20 years': 17.5,
    '20+ years': 22
};



// jobRole/specialty carries the most weight (a role mismatch matters more
// than anything else); location carries the least (a text-containment
// signal, not a real distance measure — see scoreLocation below).
const WEIGHTS = {
    jobRole: 0.40,
    experience: 0.25,
    skills: 0.15,
    education: 0.15,
    location: 0.05
};



// A handful of generic connector words — filtered out so they never count
// as a "match" between two otherwise unrelated strings. Deliberately NOT
// filtering by token length: short medical abbreviations (MS, MD, IV, OT,
// ENT, ICU) are exactly the tokens that matter most here.
const STOPWORDS = new Set(['of', 'in', 'and', 'the', 'a', 'an', 'for', 'with', 'to', 'or']);

function tokenize(text) {
    return new Set(
        String(text || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(token => token && !STOPWORDS.has(token))
    );
}



// Overlap ratio relative to the SMALLER token set, so a short label like
// "MS" matching fully inside a longer one ("MS General Surgery") still
// reads as a strong match rather than being diluted by the longer string's
// extra words.
function tokenOverlapRatio(textA, textB) {
    const tokensA = tokenize(textA);
    const tokensB = tokenize(textB);
    if (tokensA.size === 0 || tokensB.size === 0) return 0;

    let overlapCount = 0;
    for (const token of tokensA) {
        if (tokensB.has(token)) overlapCount++;
    }
    return overlapCount / Math.min(tokensA.size, tokensB.size);
}



// jobRole: exact enum match (candidate.jobRole vs vacancy.specialty, both
// drawn from the same ALLOWED_ROLES list) -> 100. Different role but same
// SPECIALTY_FAMILIES group (e.g. general_surgeon vs orthopedic_surgeon,
// both 'Surgeon') -> partial credit. Different family entirely -> 0.
// Returns null (dimension skipped) only if either side is missing.
function scoreJobRole(candidateJobRole, vacancySpecialty) {
    if (!candidateJobRole || !vacancySpecialty) return null;
    if (candidateJobRole === vacancySpecialty) return 100;

    const candidateFamily = SPECIALTY_FAMILIES[candidateJobRole];
    const vacancyFamily = SPECIALTY_FAMILIES[vacancySpecialty];
    if (candidateFamily && candidateFamily === vacancyFamily) return 40;

    return 0;
}



// Extracts a minimum-years requirement from JobVacancy.experience's free
// text ("3+ years" -> 3, "5+ years" -> 5, "2-4 years" -> 2, the lower
// bound). Returns null if nothing numeric is found — the field stays free
// text on the vacancy side, no schema change, so this has to tolerate
// "Experienced", "Fresher welcome", or an empty string.
function parseMinExperienceYears(vacancyExperienceText) {
    if (!vacancyExperienceText || typeof vacancyExperienceText !== 'string') return null;
    const match = vacancyExperienceText.match(/(\d+)/);
    if (!match) return null;
    return parseInt(match[1], 10);
}



// Prefers the authoritative profile field (medicalStaff.experience) when
// it's properly set — that's the candidate's own confirmed value, from the
// manual form or the resume-reviewed confirm step. Only falls back to the
// resume-derived totalExperienceYears when the profile field itself was
// never set at all.
function getCandidateExperienceYears(medicalStaff) {
    const bucket = medicalStaff?.experience;
    if (bucket && EXPERIENCE_BUCKET_YEARS[bucket] !== undefined) {
        return EXPERIENCE_BUCKET_YEARS[bucket];
    }

    const preciseYears = medicalStaff?.resumeAnalysis?.extractedData?.totalExperienceYears;
    return typeof preciseYears === 'number' ? preciseYears : null;
}



// De-duplicates case/whitespace-insensitively so a skill or qualification
// stated in both places doesn't get double-weight or appear twice.
function dedupeBy(items, keyFn) {
    const seen = new Set();
    const result = [];
    for (const item of items) {
        const key = keyFn(item);
        if (!key || !seen.has(key)) {
            if (key) seen.add(key);
            result.push(item);
        }
    }
    return result;
}



// Skills for matching purposes come from BOTH the authoritative profile
// field AND the advisory resumeAnalysis block, merged — the profile's
// skills[] is only ever set once at profile creation, while resumeAnalysis
// refreshes on every resume upload, so a candidate who uploaded a newer
// resume with more skills listed would otherwise have those skills
// invisible to matching until they manually edited their profile. This
// merge is read-time only — it never writes back to either field.
function getCandidateSkills(medicalStaff) {
    const profileSkills = Array.isArray(medicalStaff?.skills) ? medicalStaff.skills : [];
    const resumeSkills = Array.isArray(medicalStaff?.resumeAnalysis?.extractedData?.skills)
        ? medicalStaff.resumeAnalysis.extractedData.skills
        : [];

    return dedupeBy(
        [...profileSkills, ...resumeSkills],
        skill => String(skill || '').trim().toLowerCase()
    );
}



// Same merge, same reasoning, for education entries.
function getCandidateEducation(medicalStaff) {
    const profileEducation = Array.isArray(medicalStaff?.education) ? medicalStaff.education : [];
    const resumeEducation = Array.isArray(medicalStaff?.resumeAnalysis?.extractedData?.education)
        ? medicalStaff.resumeAnalysis.extractedData.education
        : [];

    return dedupeBy(
        [...profileEducation, ...resumeEducation],
        entry => String(entry?.speciality || '').trim().toLowerCase()
    );
}



// Meets or exceeds the parsed minimum -> 100. Short by up to 2 years ->
// smooth linear falloff to 20. Short by more than 2 years -> 0-20.
function scoreExperience(candidateYears, minYears) {
    if (candidateYears == null || minYears == null) return null;
    if (candidateYears >= minYears) return 100;

    const shortfall = minYears - candidateYears;
    if (shortfall >= 2) return Math.max(0, 20 - (shortfall - 2) * 5);
    return Math.max(20, 100 - (shortfall / 2) * 80);
}



// A vacancy skill counts as "matched" if any candidate skill shares at
// least half its (smaller-set-relative) tokens with it — loose enough to
// catch "IV cannulation" vs "IV Cannulation and venipuncture", strict
// enough that one shared filler word doesn't count as a match.
function scoreSkills(candidateSkills, vacancySkills) {
    if (!Array.isArray(vacancySkills) || vacancySkills.length === 0) return null;
    if (!Array.isArray(candidateSkills) || candidateSkills.length === 0) return 0;

    const matchedCount = vacancySkills.filter(requiredSkill =>
        candidateSkills.some(candidateSkill => tokenOverlapRatio(requiredSkill, candidateSkill) >= 0.5)
    ).length;

    return Math.round((matchedCount / vacancySkills.length) * 100);
}



// Takes the candidate's best-overlapping education entry against the
// vacancy's free-text requirement — graduated by overlap ratio rather than
// a flat yes/no, so "MS General Surgery" vs "MS/MCh Pediatric Surgery"
// (shares "ms"+"surgery") scores meaningfully higher than a qualification
// with no relation at all, without either being a full 100 or a hard 0.
function scoreEducation(candidateEducation, vacancyEducationText) {
    if (!vacancyEducationText || typeof vacancyEducationText !== 'string') return null;
    if (!Array.isArray(candidateEducation) || candidateEducation.length === 0) return 0;

    const bestRatio = candidateEducation.reduce((best, entry) => {
        const ratio = tokenOverlapRatio(entry?.speciality, vacancyEducationText);
        return ratio > best ? ratio : best;
    }, 0);

    return Math.round(bestRatio * 100);
}



// No coordinates on either side (deliberately — no geocoding added), so
// this is a coarse text-containment check against the vacancy's free-text
// address string: does it mention the candidate's city, or failing that,
// their state? Never a hard zero — free-text address matching has real
// false-negative risk (abbreviations, area names instead of city names),
// so "no match found" still leaves a small non-zero signal.
function scoreLocation(candidateCity, candidateState, vacancyLocationText) {
    if (!vacancyLocationText || typeof vacancyLocationText !== 'string') return null;

    const locationLower = vacancyLocationText.toLowerCase();
    if (candidateCity && locationLower.includes(candidateCity.toLowerCase())) return 100;
    if (candidateState && locationLower.includes(candidateState.toLowerCase())) return 50;
    return 10;
}



// Composite score: weighted average over only the dimensions that could
// actually be scored on both sides. A dimension neither side has data for
// (empty vacancy.skills[], no candidate education, etc.) is excluded from
// both the numerator and the denominator — never scored as 0, which would
// double-punish a thin vacancy posting or a thin candidate profile.
function computeMatchScore(medicalStaff, vacancy) {
    const matchBreakdown = {
        jobRole: scoreJobRole(medicalStaff.jobRole, vacancy.specialty),
        experience: scoreExperience(
            getCandidateExperienceYears(medicalStaff),
            parseMinExperienceYears(vacancy.experience)
        ),
        skills: scoreSkills(getCandidateSkills(medicalStaff), vacancy.skills),
        education: scoreEducation(getCandidateEducation(medicalStaff), vacancy.education),
        location: scoreLocation(medicalStaff.city, medicalStaff.state, vacancy.location)
    };

    let weightedSum = 0;
    let weightUsed = 0;

    for (const [dimension, score] of Object.entries(matchBreakdown)) {
        if (score !== null) {
            weightedSum += score * WEIGHTS[dimension];
            weightUsed += WEIGHTS[dimension];
        }
    }

    const matchScore = weightUsed > 0 ? Math.round(weightedSum / weightUsed) : null;

    return { matchScore, matchBreakdown };
}


module.exports = {
    computeMatchScore,
    // Exported individually for unit testing.
    scoreJobRole,
    parseMinExperienceYears,
    getCandidateExperienceYears,
    getCandidateSkills,
    getCandidateEducation,
    scoreExperience,
    scoreSkills,
    scoreEducation,
    scoreLocation
};
