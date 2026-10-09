// "More openings" in the app come from the agent's search of other job sites.
// Each opening says which site it came from and links to the original post.
const { sourceName, withSource } = require('../../agent/utils/jobSource');

describe('opening source', () => {
    it.each([
        ['https://www.naukri.com/job-listings-staff-nurse-pune-123', 'Naukri'],
        ['https://in.indeed.com/viewjob?jk=abc', 'Indeed'],
        ['https://www.linkedin.com/jobs/view/123', 'LinkedIn'],
        ['https://careers.example-hospital.in/jobs/rmo', 'careers.example-hospital.in'],
        ['not a url', null],
        [null, null]
    ])('%s -> %s', (url, name) => {
        expect(sourceName(url)).toBe(name);
    });

    it('adds source and sourceUrl and keeps every other field', () => {
        const job = { _id: 'j1', role: 'Staff Nurse', source_url: 'https://www.naukri.com/x', apply_link: 'https://apply.example/x' };
        expect(withSource(job)).toEqual({ ...job, source: 'Naukri', sourceUrl: 'https://www.naukri.com/x' });
    });

    it('falls back to the apply link', () => {
        expect(withSource({ apply_link: 'https://www.shine.com/jobs/1' })).toMatchObject({ source: 'Shine', sourceUrl: 'https://www.shine.com/jobs/1' });
    });
});
