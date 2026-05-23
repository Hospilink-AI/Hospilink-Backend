#!/usr/bin/env node

/**
 * Agent Standalone Server
 * Starts the job search agent independently from the main application
 */

// Load .env — try repo root (local dev), fall back to cwd (Docker/ECS injects env vars directly)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

process.env.TZ = "Asia/Kolkata";

// Validate Node.js version
const majorVersion = parseInt(process.version.slice(1).split('.')[0]);
if (majorVersion < 20) {
    console.error(`❌ Node.js ${process.version} is not supported. Requires 20.x or higher.`);
    process.exit(1);
}

const config = require('./utils/config');
const logger = require('./utils/logger');

async function main() {
    try {
        config.validate();

        logger.info('Starting Agent Server...', {
            nodeVersion: process.version,
            port: config.server.port,
            env: config.env
        });

        const { startServer } = require('./api');
        await startServer();

        // Start automated agent scheduler if enabled
        if (config.jobAgent?.enabled) {
            const { startScheduler } = require('./modules/scheduler');
            
            startScheduler(
                null, 
                null, 
                config.jobAgent.scheduleInterval || "0 2 * * 1"
            );
            
            logger.info('Automated job agent scheduler started', {
                schedule: config.jobAgent.scheduleInterval,
                retentionDays: config.jobAgent.dataRetentionDays
            });
        }

logger.info('Agent Server started successfully!');
logger.info(`Health:  http://localhost:${config.server.port}/v1/health`);    

    } catch (error) {
        logger.error('Failed to start Agent Server:', {
            message: error.message,
            stack: error.stack
        });
        process.exit(1);
    }
}

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Rejection:', reason);
    process.exit(1);
});

main();
