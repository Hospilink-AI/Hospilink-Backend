const Redis = require('ioredis');
const logger = require('../utils/logger');

class RedisConfig {
    constructor() {
        this.redis = null;
        this.isConnected = false;
        this.connectionPromise = null; // Track existing connection attempts
    }

    /**
     * Initializes the connection. 
     * Uses a promise guard to prevent multiple simultaneous connection attempts.
     */
    async connect() {
        // If already connected or connecting, return the existing promise/client
        if (this.isConnected && this.redis) return this.redis;
        if (this.connectionPromise) return this.connectionPromise;

        this.connectionPromise = (async () => {
            try {
                const config = this._getParsedConfig();
                
                // Initialize client
                this.redis = new Redis(config);

                this._setupEventListeners(config.host, config.port);

                // Wait for the 'ready' event with a timeout
                await this._waitForReady();

                return this.redis;
            } catch (error) {
                this.connectionPromise = null; // Allow retry on failure
                logger.error('Failed to connect to Redis:', error.message);
                throw error;
            }
        })();

        return this.connectionPromise;
    }

    _getParsedConfig() {
        const enableTLS = process.env.REDIS_TLS === 'true';
        const config = {
            host: process.env.REDIS_HOST || 'localhost',
            port: parseInt(process.env.REDIS_PORT, 10) || 6379,
            password: process.env.REDIS_PASSWORD || '',
            username: process.env.REDIS_USERNAME || 'default',
            db: parseInt(process.env.REDIS_DB, 10) || 0,
            keyPrefix: 'hospilink:',
            maxRetriesPerRequest: 1, // fail fast in serverless — getClientAsync handles reconnect
            enableReadyCheck: true,
            retryStrategy: (times) => Math.min(times * 50, 2000),
            reconnectOnError: (err) => err.message.includes('READONLY'),
        };

        if (enableTLS) {
            config.tls = { rejectUnauthorized: false };
            logger.info('Redis TLS enabled');
        }
        return config;
    }

    _setupEventListeners(host, port) {
        // this.redis.on('connect', () => logger.info(`Redis connecting to ${host}:${port}`));
        this.redis.on('ready', () => {
            logger.info('Redis connected and ready');
            this.isConnected = true;
        });
        this.redis.on('error', (err) => {
            logger.error('Redis error:', err.message);
            // Don't set isConnected=false here; 'close' or 'end' will handle it
        });
        this.redis.on('close', () => {
            logger.warn('Redis connection closed');
            this.isConnected = false;
        });
        this.redis.on('reconnecting', () => logger.info('Redis reconnecting...'));
    }

    _waitForReady() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.redis.removeAllListeners('ready');
                this.redis.removeAllListeners('error');
                reject(new Error('Redis connection timeout'));
            }, 10000);

            this.redis.once('ready', () => {
                clearTimeout(timeout);
                resolve();
            });

            this.redis.once('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
    }

    async disconnect() {
        if (this.redis) {
            // quit() waits for commands to finish; disconnect() forces it
            try {
                await this.redis.quit();
            } catch (e) {
                this.redis.disconnect();
            }
            this.redis = null;
            this.isConnected = false;
            this.connectionPromise = null;
            logger.info('Redis disconnected');
        }
    }

    async getClientAsync() {
        if (this.isConnected && this.redis) return this.redis;
        return this.connect(); // connect() is idempotent — reuses in-flight promise
    }

    getClient() {
        // Kept for backward compat but prefer getClientAsync() in serverless environments
        if (!this.redis) throw new Error('Redis client not initialized. Call connect() first.');
        return this.redis;
    }

    isRedisConnected() {
        return this.isConnected;
    }
}

// Singleton instance — reused across warm invocations in serverless
const instance = new RedisConfig();

// Auto-connect on module load so serverless warm starts reuse the connection
instance.connect().catch(() => {}); // errors handled by event listeners

module.exports = instance;