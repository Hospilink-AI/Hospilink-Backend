const { findJobs } = require('../index');
const config = require('../utils/config');
const logger = require('../utils/logger');
const { cleanOldJobs } = require('./storage');

class AutomatedAgent {
    constructor() {
        this.isRunning = false;
        this.lastRun = null;
        this.currentJobIndex = 0;
        this.currentLocationIndex = 0;
    }

    
    // Run automated searches for all predefined roles and locations
    async runAutomatedSearches() {
        if (this.isRunning) {
            logger.warn('Automated agent is already running, skipping...');
            return { status: 'already_running' };
        }

        this.isRunning = true;
        logger.info('Starting automated job searches...');

        const roles = Object.entries(config.jobAgent.roles);
        const locations = config.jobAgent.locations;
        const results = [];

        try {
            // Clean old data before starting new searches
            logger.info('Cleaning old job data...');
            const cleanedCount = await cleanOldJobs(config.jobAgent.dataRetentionDays);
            logger.info(`Cleaned ${cleanedCount} old jobs`);

            // Run searches for each role-location combination
            for (const [roleKey, roleValue] of roles) {
                for (const location of locations) {
                    try {
                        logger.info(`Searching for ${roleValue} in ${location}...`);
                        
                        const result = await findJobs(roleValue, location, { 
                            keepAlive: true,
                            maxJobs: 20 // Limit per search to avoid overwhelming
                        });

                        if (result.status === 'success' && result.jobs.length > 0) {
                            try {
                                const googleSheetsService = require('./google_sheets');
                                const username = `automated_${roleKey}_${location.replace(/[^a-zA-Z0-9]/g, '_')}`;
                                await googleSheetsService.saveJobsToUserExcel(username, result.jobs);
                                logger.info(`Exported ${result.jobs.length} jobs to Excel for ${roleValue} in ${location}`);
                            } catch (excelError) {
                                logger.warn('Failed to export jobs to Excel', { 
                                    error: excelError.message,
                                    role: roleValue,
                                    location 
                                });
                            }
                        }

                        results.push({
                            role: roleKey,
                            roleDisplay: roleValue,
                            location,
                            status: result.status,
                            jobsFound: result.summary?.jobs_stored || 0,
                            timestamp: new Date()
                        });

                        // Add delay between searches to avoid rate limiting
                        await new Promise(resolve => setTimeout(resolve, 2000));

                    } catch (error) {
                        logger.error(`Failed to search for ${roleValue} in ${location}`, { 
                            error: error.message 
                        });
                        results.push({
                            role: roleKey,
                            roleDisplay: roleValue,
                            location,
                            status: 'error',
                            error: error.message,
                            timestamp: new Date()
                        });
                    }
                }
            }

            this.lastRun = new Date();
            logger.info(`Automated searches completed. Processed ${results.length} role-location combinations`);

            return {
                status: 'completed',
                lastRun: this.lastRun,
                totalSearches: results.length,
                results
            };

        } catch (error) {
            logger.error('Automated agent failed', { error: error.message });
            return {
                status: 'error',
                error: error.message,
                lastRun: this.lastRun
            };
        } finally {
            this.isRunning = false;
        }
    }

    // Get current status of automated agent
    getStatus() {
        return {
            isRunning: this.isRunning,
            lastRun: this.lastRun,
            enabled: config.jobAgent.enabled,
            scheduleInterval: config.jobAgent.scheduleInterval,
            dataRetentionDays: config.jobAgent.dataRetentionDays
        };
    }
}

module.exports = new AutomatedAgent();