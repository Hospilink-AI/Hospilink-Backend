/**
 * Configuration Module - Production-grade configuration management
 * Loads and validates environment variables with sensible defaults
 *
 * CONVERTED TO COMMONJS for backend compatibility
 */
// Load .env — try repo root (local dev), fall back to cwd (Docker/ECS injects env vars directly)
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

// Ensure MongoDB URI is available in production
if (!process.env.MONGODB_URI && process.env.MONGODB_URL) {
    process.env.MONGODB_URI = process.env.MONGODB_URL;
}

const NODE_ENV = process.env.NODE_ENV || "development";
const isProd = NODE_ENV === "production";

function validateConfig() {
  const required = ["SEARCHAPI_KEY", "GEMINI_API_KEY", "MONGODB_URI"];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(
        ", ",
      )}\nPlease add them to .env file.`,
    );
  }

  if (process.env.GOOGLE_CLIENT_EMAIL && !process.env.GOOGLE_PRIVATE_KEY) {
    console.warn(
      "WARNING: GOOGLE_CLIENT_EMAIL set but GOOGLE_PRIVATE_KEY missing. Google Sheets integration may fail.",
    );
  }
}

const config = {
  // --- Environment Identity ---
  env: NODE_ENV,
  isProd,

  // --- API Credentials ---
  // These must be set in your .env file for the agent to function
  searchApiKey: process.env.SEARCHAPI_KEY, // From SearchAPI.io
  serperApiKey: process.env.SERPER_API_KEY || null, // From serper.dev (optional, enhances search)
  geminiApiKey: process.env.GEMINI_API_KEY, // From Google AI Studio
  mongodbUri: process.env.MONGODB_URI, // Local or Atlas connection string

  // --- Web Server Settings ---
  server: {
    port: parseInt(process.env.AGENT_PORT, 10) || 3002,
    host: process.env.HOST || "0.0.0.0",
    trustProxy: process.env.TRUST_PROXY === "true" || isProd, // Essential for accurate IP logging behind reverse proxies
    corsOrigins: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
      : null, // null = allow all in dev; set CORS_ORIGINS in prod
    bodyLimit: "1mb", // Maximum JSON payload size
    requestTimeout: 120000, // 2 minutes before request times out
  },

  // --- MongoDB Connection Pool & Resilience ---
  mongodb: {
    uri: process.env.MONGODB_URI,
    poolSize: parseInt(process.env.MONGO_POOL_SIZE, 10) || (isProd ? 50 : 10),
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    maxIdleTimeMS: 30000,
    retryWrites: true,
    retryReads: true,
  },

  // --- Background Task Queue ---
  // Used to manage concurrent job search requests
  queue: {
    enabled: process.env.QUEUE_ENABLED !== "false",
    concurrency:
      parseInt(process.env.QUEUE_CONCURRENCY, 10) || (isProd ? 10 : 5), // Concurrent workers
    maxPerMinute:
      parseInt(process.env.QUEUE_MAX_PER_MINUTE, 10) || (isProd ? 30 : 20), // Rate limit for worker
    maxPending: parseInt(process.env.QUEUE_MAX_PENDING, 10) || 100, // Max jobs allowed in queue
  },

  // --- API Security & Rate Limiting ---
  rateLimit: {
    windowMs:
      parseInt(process.env.AGENT_RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000, // 15 minutes
    max:
      parseInt(process.env.AGENT_RATE_LIMIT_MAX, 10) || (isProd ? 100 : 1000), // Max requests per window
    searchMax:
      parseInt(process.env.AGENT_SEARCH_RATE_LIMIT, 10) || (isProd ? 10 : 100), // Strict limit for AI search
    searchWindowMs:
      parseInt(process.env.AGENT_SEARCH_RATE_WINDOW_MS, 10) || 60 * 1000,
    skipFailedRequests: false,
    standardHeaders: true,
    legacyHeaders: false,
  },

  // --- Real-time Communication (Server-Sent Events) ---
  sse: {
    maxConnections:
      parseInt(process.env.AGENT_SSE_MAX_CONNECTIONS, 10) ||
      (isProd ? 500 : 100),
    keepAliveInterval: 15000,
    connectionTimeout: 300000,
  },

  // --- Caching Strategy (In-Memory) ---
  cache: {
    searchTTL: parseInt(process.env.CACHE_SEARCH_TTL, 10) || 300, // Seconds
    statsTTL: parseInt(process.env.CACHE_STATS_TTL, 10) || 60, // Seconds
    jobsTTL: parseInt(process.env.CACHE_JOBS_TTL, 10) || 120, // Seconds
  },

  // --- Logging & Observability ---
  logLevel: process.env.AGENT_LOG_LEVEL || (isProd ? "info" : "debug"),
  logFormat: process.env.LOG_FORMAT || (isProd ? "json" : "pretty"),

  // --- Job Collection & AI search parameter ---
  maxJobs:
    parseInt(process.env.AGENT_SESSION_LIMIT, 10) ||
    parseInt(process.env.AGENT_MAX_JOBS, 10) ||
    300, // Maximum unique jobs to collect per session
  maxTimeSeconds: parseInt(process.env.MAX_TIME_SECONDS, 10) || 1200, // Safety timeout for scraping workflow

  // --- Job Retention & Lifecycle Policy ---
  inactiveDays: 7,  // Jobs become inactive after 7 days
  staleDays: 30,    // Jobs marked as stale after 30 days  
  ttlDays: 7,       // Jobs deleted from DB after 7 days (TTL index)

  recencyDecayRate: 7, // Exponential decay for job ranking (higher = newer is better)
  retryAttempts: 1, // Max retries for failed network requests
  retryBackoffMs: 1000,
  searchApiCacheDays: 1, // How long proxy results are cached
  region: "IN", // Default region for localized search results

  // --- Web Crawler & Fetcher Settings ---
  crawlerDelayMs: parseInt(process.env.CRAWLER_DELAY_MS, 10) || 500, // Courtesy delay between page fetches
  crawlerTimeoutMs: 15000,
  maxRedirects: 3,

  // --- External Search Engine Parameters ---
  searchApi: {
    location: process.env.SEARCH_GL || "in", // Geolocation (country code)
    language: process.env.SEARCH_HL || "en", // UI Language code
    numResults: parseInt(process.env.SEARCH_NUM, 10) || 15, // Results per query
    timeout: parseInt(process.env.SEARCH_TIMEOUT, 10) || 8000,
  },
  maxUrlsPerSearch: 30, // Absolute limit on URLs to process per query
  enableGoogleJobs: process.env.AGENT_ENABLE_GOOGLE_JOBS !== "false",
  googleJobsLimit: 50,  // 300 was overkill — most have no contact info anyway
  googleJobsMaxPages: parseInt(process.env.GOOGLE_JOBS_MAX_PAGES, 10) || 10,

  // --- Global Rate Limiting Standard ---
  rateLimitWindowMs: 15 * 60 * 1000,
  rateLimitMax: 100,

  // --- AI Model (Gemini) Settings ---
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash-lite",
  geminiBatchSize: 5, // Concurrent prompts for job extraction

  // --- Domain Filtering Lists ---
  // Domains to skip during scraping (Aggregators usually block bots)
  aggregatorDomains: [
    "indeed.com",
    "indeed.co.in",
    "glassdoor.com",
    "glassdoor.co.in",
    "simplyhired.com",
    "simplyhired.co.in",
    "jobhai.com",
    "monster.com",
    "monster.co.in",
    "shine.com",
    "naukri.com",
    "timesjobs.com",
    "foundit.in",
    "linkedin.com",
  ],

  // Domains completely banned from search
  blockedDomains: [
    "quora.com",
    "pinterest.com",
    "facebook.com",
    "instagram.com",
    "youtube.com",
    "justdial.com",
    "sulekha.com",
    "threads.com",
    "scribd.com"
  ],

  // Keywords that indicate a page might contain job information
  allowedDomainPatterns: [
    "hospital",
    "clinic",
    "healthcare",
    "medical",
    "nursing",
    "careers",
    ".gov.in",
    ".nic.in",
    "linkedin.com/jobs",
    "recruiter",
    "staffing",
    ".org",
    ".edu",
  ],

  // High-value domains that are crawled with priority
  priorityDomains: [
    "hospital",
    "clinic",
    "healthcare",
    "medical",
    "careers",
    ".org",
    "linkedin.com",
  ],

  // Generic email prefixes to ignore during contact extraction
  genericEmails: [
    "info@",
    "contact@",
    "support@",
    "admin@",
    "help@",
    "enquiry@",
    "enquiries@",
    "general@",
    "office@",
  ],

  // --- Google Services (Sheets Integration) ---
  google: {
    clientEmail: process.env.GOOGLE_CLIENT_EMAIL,
    privateKey: (() => {
      const key = process.env.GOOGLE_PRIVATE_KEY;
      if (!key) return null;
      // Sanitizes private key to ensure correct PEM formatting
      return key.replace(/\\n/g, "\n");
    })(),
    sheetId: process.env.GOOGLE_SHEET_ID,
  },

  // --- Google Drive Integration ---
  googleDrive: {
    clientEmail: process.env.GOOGLE_CLIENT_EMAIL,
    privateKey: (() => {
      const key = process.env.GOOGLE_PRIVATE_KEY;
      if (!key) return null;
      return key.replace(/\\n/g, "\n");
    })(),
    folderId: process.env.GOOGLE_DRIVE_FOLDER_ID,
  },

  validate: validateConfig,

  // Automated Job Agent Configuration 
  jobAgent: {
      // Predefined locations for Pune region
      locations: [
          "Talegaon",
          "Pimpri-Chinchwad", 
          "Pune"
      ],
      
      // Predefined job roles
      roles: {
          rmo: "RMO (Resident Medical Officer)",
          staff_nurse: "Staff Nurse",
          pharmacist: "Pharmacist"
      },
      
      // Automated scheduling
      scheduleInterval: '0 15 * * 2', // Every Tuesday at 3:00 PM on IST
      dataRetentionDays: 7, // Remove data after 7 days
      enabled: true // Enable automated agent
  }
};

module.exports = config;
