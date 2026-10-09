/**
 * Where an opening from another job site comes from, for the app's
 * "More openings" list: the site's name and the link to the original post.
 */

// Display names for the sites the agent finds most often
const KNOWN_SITES = {
    'naukri.com': 'Naukri',
    'indeed.com': 'Indeed',
    'in.indeed.com': 'Indeed',
    'linkedin.com': 'LinkedIn',
    'shine.com': 'Shine',
    'monster.com': 'foundit',
    'foundit.in': 'foundit',
    'timesjobs.com': 'TimesJobs',
    'glassdoor.co.in': 'Glassdoor',
    'glassdoor.com': 'Glassdoor',
    'apna.co': 'apna',
    'workindia.in': 'WorkIndia',
    'practo.com': 'Practo',
    'google.com': 'Google Jobs'
};

function hostOf(url) {
    try {
        return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch (error) {
        return null;
    }
}

// "Naukri" for https://www.naukri.com/job-listings-..., the bare domain for
// sites not in the list, null without a usable link
function sourceName(url) {
    const host = hostOf(url);
    if (!host) return null;
    if (KNOWN_SITES[host]) return KNOWN_SITES[host];
    const match = Object.keys(KNOWN_SITES).find(domain => host.endsWith(`.${domain}`));
    return match ? KNOWN_SITES[match] : host;
}

// Adds source and sourceUrl to an opening; keeps every existing field
function withSource(job) {
    if (!job || typeof job !== 'object') return job;
    const sourceUrl = job.source_url || job.apply_link || null;
    return { ...job, source: sourceName(sourceUrl), sourceUrl };
}

module.exports = { sourceName, withSource };
