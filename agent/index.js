#!/usr/bin/env node

/**
 * CONVERTED TO COMMONJS for backend compatibility
 */

/**
 * Job Finder System - Main Orchestrator
 * 
 * ARCHITECTURE: SERP → Filter → Fetch → Extract → Dedupe → Rank → Store
 * No crawling, no JS rendering, no browser automation.
 * 
 * Usage: node src/index.js --role "staff nurse" --location "Pune"
 */
const { Command } = require('commander');
const config = require('./utils/config');
const { logger, costTracker, logCostSummary } = require('./utils/logger');
// Import at the top
const searchGoogleJobs = require('./modules/search_google_jobs');
const { search } = require('./modules/search');
const { filterByJobSignal } = require('./modules/filter');
const { fetchBatch } = require('./modules/fetcher');
const { extract } = require('./modules/extractor');
const { validateJobs } = require('./modules/validator');
const { deduplicate } = require('./modules/deduplicator');
const { rankJobs } = require('./modules/ranker');
const { enrichJobs } = require('./modules/enricher');
const { connect, disconnect, storeJobs } = require('./modules/storage');
const { startServer } = require('./api');

/**
 * Main job finder orchestration
 * 
 * Pipeline:
 * 1. DISCOVERY: SerpAPI search → candidate URLs with snippets
 * 2. FILTER: Evaluate snippets for job signals
 * 3. FETCH: Simple HTTP fetch (no crawling)
 * 4. EXTRACT: Batch LLM extraction (3-5 docs/call)
 * 5. VALIDATE: Check role/location match
 * 6. DEDUPE: Merge by contact/employer
 * 7. RANK: Score and sort
 * 8. STORE: Persist to MongoDB/memory
 * 
 * @param {string} role - Job role to search
 * @param {string} location - Location to search
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} Results summary
 */
async function findJobs(role, location, options = {}) {
    const startTime = Date.now();
    const errors = [];

    // Result tracking
    const summary = {
        total_urls_found: 0,
        urls_filtered: 0,
        high_signal: 0,
        urls_fetched: 0,
        jobs_extracted: 0,
        jobs_validated: 0,
        jobs_stored: 0,
        llm_calls: 0,
        time_taken_seconds: 0
    };

    try {
        // Step 1: Validate input
        if (!role || !location) {
            throw new Error('Both role and location are required');
        }

        logger.info('Starting job search', { role, location });

        // Step 2: Validate configuration
        config.validate();

        // ═══════════════════════════════════════════════════════════════
        // STEP 1: DISCOVERY - Search using SerpAPI (Hybrid: Standard + Google Jobs)
        // ═══════════════════════════════════════════════════════════════
        logger.info('Step 1/7: Searching for job listings (Hybrid)...');

        // Run both searches in parallel
        const [searchResults, googleJobs] = await Promise.all([
            search(role, location),
            config.enableGoogleJobs ? searchGoogleJobs(role, location) : Promise.resolve([])
        ]);

        summary.total_urls_found = searchResults.totalFound;

        if (googleJobs.length > 0) {
            logger.info(`Found ${googleJobs.length} additional jobs via Google Jobs engine`);
        }

        if (searchResults.urls.length === 0 && googleJobs.length === 0) {
            logger.warn('No URLs found from search');
            return {
                status: 'no_results',
                summary,
                jobs: [],
                errors: ['No job listings found for the given search criteria']
            };
        }

        // Initialize extracted jobs array
        let allExtractedJobs = [];

        // ═══════════════════════════════════════════════════════════════
        // STEP 1.5: EXTRACT FROM GOOGLE JOBS (Refinement)
        // ═══════════════════════════════════════════════════════════════
        if (googleJobs.length > 0) {
            logger.info(`Step 1.5/7: Refining ${googleJobs.length} Google Jobs via Gemini...`);
            const refinedGoogleJobs = await extract({
                googleJobs: googleJobs,
                role,
                location
            });
            allExtractedJobs.push(...refinedGoogleJobs);
            summary.llm_calls += Math.ceil(googleJobs.length / 5);
        }

        // ═══════════════════════════════════════════════════════════════
        // STEP 2: FILTER - Evaluate snippets for job signals (Standard Results Only)
        // ═══════════════════════════════════════════════════════════════
        logger.info('Step 2/7: Filtering by job signals (Standard Results)...');
        const filterResult = filterByJobSignal(searchResults.urls);
        summary.urls_filtered = filterResult.filtered.length;
        summary.high_signal = filterResult.highSignal.length;

        // Log skipped URLs
        filterResult.skipped.forEach(s => {
            logger.debug(`Skipped (no signal): ${s.url}`);
        });

        if (filterResult.filtered.length === 0 && allExtractedJobs.length === 0) {
            logger.warn('No URLs passed job signal filter and no Google Jobs found');
            return {
                status: 'no_signal',
                summary,
                jobs: [],
                errors: ['No job listings with hiring signals found']
            };
        }

        // ═══════════════════════════════════════════════════════════════
        // STEP 3: EXTRACT FROM HIGH-SIGNAL SNIPPETS (no fetch needed)
        // ═══════════════════════════════════════════════════════════════

        if (filterResult.highSignal.length > 0) {
            logger.info(`Step 3/7: Extracting from ${filterResult.highSignal.length} high-signal snippets...`);

            const snippetJobs = await extract({
                snippets: filterResult.highSignal,
                role,
                location
            });

            allExtractedJobs.push(...snippetJobs);
            summary.llm_calls += Math.ceil(filterResult.highSignal.length / 10);
        }

        // ═══════════════════════════════════════════════════════════════
        // STEP 4: FETCH - Simple HTTP fetch for remaining URLs
        // ═══════════════════════════════════════════════════════════════
        if (filterResult.needsFetch.length > 0) {
            logger.info(`Step 4/7: Fetching ${filterResult.needsFetch.length} URLs...`);

            const fetchedDocs = await fetchBatch(filterResult.needsFetch, 5);
            summary.urls_fetched = fetchedDocs.length;

            // Identify failed fetches for fallback strategy
            const failedItems = filterResult.needsFetch.filter(item =>
                !fetchedDocs.find(f => f.url === item.url)
            );

            if (failedItems.length > 0) {
                logger.info(`Failed to fetch ${failedItems.length} URLs. Falling back to snippet extraction.`);
            }

            // ═══════════════════════════════════════════════════════════════
            // STEP 5: BATCH EXTRACT - LLM extraction
            // ═══════════════════════════════════════════════════════════════

            // 5a. Extract from successfully fetched documents
            if (fetchedDocs.length > 0) {
                logger.info(`Step 5a/7: Batch extracting from ${fetchedDocs.length} documents...`);

                const docJobs = await extract({
                    documents: fetchedDocs,
                    role,
                    location
                });

                allExtractedJobs.push(...docJobs);
                summary.llm_calls += Math.ceil(fetchedDocs.length / 4);
            }

            // 5b. Fallback: Extract from snippets for failed fetches
            if (failedItems.length > 0) {
                logger.info(`Step 5b/7: Extracting from ${failedItems.length} failed-fetch snippets...`);

                const fallbackJobs = await extract({
                    snippets: failedItems,
                    role,
                    location
                });

                allExtractedJobs.push(...fallbackJobs);
                summary.llm_calls += Math.ceil(failedItems.length / 10);
            }

        } else {
            logger.info('Step 4-5/7: Skipped (all extracted from snippets)');
        }

        summary.jobs_extracted = allExtractedJobs.length;

        if (allExtractedJobs.length === 0) {
            logger.warn('No jobs extracted');
            return {
                status: 'no_jobs',
                summary,
                jobs: [],
                errors: ['No job information could be extracted from the results']
            };
        }

        // ═══════════════════════════════════════════════════════════════
        // STEP 6: VALIDATE - Check role/location match
        // ═══════════════════════════════════════════════════════════════
        logger.info('Step 6/7: Validating jobs...');
        const validationResult = validateJobs(allExtractedJobs, role, location);
        summary.jobs_validated = validationResult.valid.length;

        if (validationResult.invalid.length > 0) {
            logger.warn(`Dropped ${validationResult.invalid.length} invalid jobs`);
            validationResult.invalid.forEach(inv => {
                const hospital = inv.job.hospital_name || 'Unknown';
                logger.info(`Invalid Job (${hospital}): ${inv.reason}`);
            });
        }

        validationResult.invalid.forEach(item => {
            errors.push(`Validation: ${item.job.hospital_name || 'unknown'} - ${item.reason}`);
        });

        // ═══════════════════════════════════════════════════════════════
        // STEP 7: DEDUPLICATE - Merge by contact/employer
        // ═══════════════════════════════════════════════════════════════
        logger.info('Step 7/9: Deduplicating...');
        const dedupeResult = deduplicate(validationResult.valid, true);

        // ═══════════════════════════════════════════════════════════════
        // STEP 8: ENRICH - Reverse lookup for missing contacts
        // ═══════════════════════════════════════════════════════════════
        logger.info('Step 8/9: Enriching jobs with missing contacts...');
        const enrichedJobs = await enrichJobs(dedupeResult.unique);

        // ═══════════════════════════════════════════════════════════════
        // STEP 9: RANK - Score and sort by relevance
        // ═══════════════════════════════════════════════════════════════
        logger.info('Step 9/9: Ranking jobs...');
        const rankedJobs = rankJobs(enrichedJobs, role, location);

        // ═══════════════════════════════════════════════════════════════
        // STEP 10: STORE - Persist to database
        // ═══════════════════════════════════════════════════════════════
        if (!options.dryRun) {
            await connect();
            const storeResult = await storeJobs(rankedJobs, `${role} ${location}`);
            summary.jobs_stored = storeResult.inserted + storeResult.updated;
        } else {
            summary.jobs_stored = rankedJobs.length;
        }

        // Calculate time taken
        summary.time_taken_seconds = Math.round((Date.now() - startTime) / 1000);

        // Log cost summary
        logCostSummary();

        logger.info('Job search completed successfully', summary);

        return {
            status: 'success',
            summary,
            jobs: rankedJobs.map(job => ({
                hospital_name: job.hospital_name,
                role: job.role,
                location: job.location,
                emails: job.emails || [],
                phones: job.phones || [],
                whatsapp: job.whatsapp,
                hr_contact: job.hr_contact,
                salary: job.salary,
                job_description: job.job_description,
                apply_link: job.apply_link,
                posted_date: job.posted_date,
                source_url: job.source_url,
                confidence_score: job.confidence_score,
                outreach_status: job.outreach_status,
                ranking_score: job.rankingScore
            })),
            errors: errors.length > 0 ? errors.slice(0, 10) : [],
            cost: costTracker.getSummary()
        };

    } catch (error) {
        logger.error('Job search failed', { error: error.message });

        summary.time_taken_seconds = Math.round((Date.now() - startTime) / 1000);

        return {
            status: 'error',
            summary,
            jobs: [],
            errors: [...errors, error.message]
        };

    } finally {
        try {
            if (!options.keepAlive) {
                await disconnect();
            }
        } catch (e) { /* ignore */ }
    }
}

/**
 * CLI setup
 */
function setupCli() {
    const program = new Command();

    program
        .name('job-finder')
        .description('Automated job finder using SerpAPI + Gemini (no crawling)')
        .version('2.0.0');

    program
        .option('-r, --role <role>', 'Job role to search (e.g., "staff nurse")')
        .option('-l, --location <location>', 'Location to search (e.g., "Pune")')
        .option('-s, --server', 'Start API server and scheduler')
        .option('-c, --cron <expression>', 'Cron expression for scheduler', '0 9 * * *')
        .option('-d, --dry-run', 'Run without storing to database')
        .option('-v, --verbose', 'Enable verbose logging')
        .option('-o, --output <file>', 'Output results to JSON file');

    program.parse();

    return program.opts();
}

/**
 * Main entry point
 */
async function main() {
    const options = setupCli();

    // Enable debug logging if verbose
    if (options.verbose) {
        logger.level = 'debug';
    }

    // CLI Mode - if role and location provided, run once and exit
    if (options.role && options.location && !options.server) {
        console.log('\n🔍 Job Finder System v2.0 (Crawl-Free)\n');
        console.log(`Searching for: ${options.role} in ${options.location}\n`);

        const results = await findJobs(options.role, options.location, {
            dryRun: options.dryRun
        });

        // Output results
        if (options.output) {
            const fs = await import('fs');
            fs.writeFileSync(options.output, JSON.stringify(results, null, 2));
            console.log(`\nResults saved to: ${options.output}`);
        }

        // Print summary
        console.log('\n📊 Summary');
        console.log('─'.repeat(40));
        console.log(`Status: ${results.status}`);
        console.log(`URLs Found: ${results.summary.total_urls_found}`);
        console.log(`High-Signal (snippet): ${results.summary.high_signal}`);
        console.log(`Fetched: ${results.summary.urls_fetched}`);
        console.log(`Jobs Extracted: ${results.summary.jobs_extracted}`);
        console.log(`Jobs Stored: ${results.summary.jobs_stored}`);
        console.log(`LLM Calls: ${results.summary.llm_calls}`);
        console.log(`Time: ${results.summary.time_taken_seconds}s`);

        if (!process.env.KEEP_ALIVE) {
            process.exit(results.status === 'success' ? 0 : 1);
        }
        return;
    }

    // Server Mode - default when no role/location provided
    console.log('\n🚀 Starting Job Finder Server v2.0 (Crawl-Free)...\n');
    await startServer(options.role, options.location, options.cron);
}

// Only run main if this file is the entry point
const isMainModule = require.main === module;

if (isMainModule) {
    main().catch(error => {
        console.error('Fatal error:', error.message);
        process.exit(1);
    });
}

module.exports = { findJobs };