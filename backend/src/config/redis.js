const Redis = require('ioredis');
const logger = require('../utils/logger');

class RedisConfig {
    constructor() {
        this.redis = null;
        this.isConnected = false;
        this.connectionPromise = null; // Track existing connection attempts
    }

    // Initializes the connection Uses a promise guard to prevent multiple simultaneous connection attempts.
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
            const tlsOptions = {
                rejectUnauthorized: true,   // Always verify the server certificate
                minVersion: 'TLSv1.2',
                maxVersion: 'TLSv1.3',
            };

            // Optional: load a custom CA bundle (e.g. for self-signed certs in dev).
            // Set REDIS_TLS_CA_PATH=/path/to/ca.crt in .env to use it.
            // In production (AWS ElastiCache) leave this unset — the system trust
            // store already includes Amazon Root CA.
            if (process.env.REDIS_TLS_CA_PATH) {
                const fs = require('fs');
                tlsOptions.ca = fs.readFileSync(process.env.REDIS_TLS_CA_PATH);
                logger.info(`Redis TLS: using custom CA from ${process.env.REDIS_TLS_CA_PATH}`);
            }

            config.tls = tlsOptions;
            logger.info('Redis TLS enabled (certificate verification ON)');
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
            }, 5000);  // Reduced from 10s to 5s

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

// Don't auto-connect on module load - let server.js control initialization
// instance.connect().catch(() => {}); // REMOVED - causes slow startup

/**
 * Create dedicated Redis clients for Socket.IO adapter
 * Socket.IO requires separate pub/sub clients to avoid command conflicts
 */
let pubClient = null;
let subClient = null;

async function getPubSubClients() {
    if (pubClient && subClient) {
        // Verify both clients are still connected
        if (pubClient.status === 'ready' && subClient.status === 'ready') {
            return { pubClient, subClient };
        } else {
            // Clients exist but not ready, reconnect
            logger.warn('Pub/sub clients exist but not ready, recreating...');
            await disconnectPubSubClients();
        }
    }

    try {
        const config = instance._getParsedConfig();
        
        // Remove keyPrefix for Socket.IO adapter (it manages its own keys)
        const adapterConfig = { ...config };
        delete adapterConfig.keyPrefix;

        // Create publisher client
        pubClient = new Redis(adapterConfig);
        
        // Create subscriber client (must be separate instance)
        subClient = pubClient.duplicate();

        // Setup event listeners for pub client
        pubClient.on('error', (err) => {
            logger.error('Redis Pub Client error:', err.message);
        });

        // Setup event listeners for sub client
        subClient.on('error', (err) => {
            logger.error('Redis Sub Client error:', err.message);
        });

        // Wait for both clients to be ready
        await Promise.all([
            new Promise((resolve, reject) => {
                if (pubClient.status === 'ready') {
                    return resolve();
                }
                const timeout = setTimeout(() => {
                    reject(new Error('Pub client timeout'));
                }, 5000);  // Reduced from 10s to 5s
                pubClient.once('ready', () => {
                    clearTimeout(timeout);
                    resolve();
                });
                pubClient.once('error', (err) => {
                    clearTimeout(timeout);
                    reject(err);
                });
            }),
            new Promise((resolve, reject) => {
                if (subClient.status === 'ready') {
                    return resolve();
                }
                const timeout = setTimeout(() => {
                    reject(new Error('Sub client timeout'));
                }, 5000);  // Reduced from 10s to 5s
                subClient.once('ready', () => {
                    clearTimeout(timeout);
                    resolve();
                });
                subClient.once('error', (err) => {
                    clearTimeout(timeout);
                    reject(err);
                });
            })
        ]);

        logger.info('Redis pub/sub clients ready for Socket.IO adapter');
        return { pubClient, subClient };
    } catch (error) {
        logger.error('Failed to create Redis pub/sub clients:', error.message);
        
        // Cleanup on failure
        if (pubClient) {
            try {
                pubClient.disconnect();
            } catch (e) {
                logger.error('Error disconnecting pub client:', e.message);
            }
            pubClient = null;
        }
        if (subClient) {
            try {
                subClient.disconnect();
            } catch (e) {
                logger.error('Error disconnecting sub client:', e.message);
            }
            subClient = null;
        }
        
        throw error;
    }
}

async function disconnectPubSubClients() {
    const promises = [];
    
    if (pubClient) {
        promises.push(
            pubClient.quit().catch(() => pubClient.disconnect())
        );
        pubClient = null;
    }
    
    if (subClient) {
        promises.push(
            subClient.quit().catch(() => subClient.disconnect())
        );
        subClient = null;
    }
    
    if (promises.length > 0) {
        await Promise.all(promises);
    }
}

module.exports = instance;
module.exports.getPubSubClients = getPubSubClients;
module.exports.disconnectPubSubClients = disconnectPubSubClients;