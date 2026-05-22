// Core Express.js and middleware dependencies
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const { body, query, validationResult } = require("express-validator");
const mongoose = require("mongoose");
const automatedAgent = require('./modules/automated_agent');
const scheduler = require('./modules/scheduler');

// Internal application modules
const config = require("./utils/config");
const logger = require("./utils/logger");

// Set IST timezone
process.env.TZ = "Asia/Kolkata";

const {
  authenticateMedicalStaff,
  optionalAuth,
} = require("./middleware/auth.middleware");

const cacheService = require("./services/cache.service");

// Geocoding service for distance calculations
const geocodingService = require("./services/geocoding.service");

const {
  getPaginationParams,
  getPaginationMeta,
  DEFAULT_PAGE_LIMIT,
} = require("./utils/pagination");

// Cache utilities for job and stats caching
const {
  cacheStats,
  getCachedStats,
  invalidateStatsCache,
  cacheJobs,
  getCachedJobs,
  invalidateJobsCache,
  getCacheStats,
} = require("./utils/cache");

// Database storage operations
const storage = require("./modules/storage");
const googleSheetsService = require("./modules/google_sheets"); // GoogleSheetsService instance
const saveJobsToUserExcel = (username, jobs) => googleSheetsService.saveJobsToUserExcel(username, jobs);
const connectDb = storage.connect;
const disconnectDb = storage.disconnect;
const getStats = storage.getStats;
const getDetailedStats = storage.getDetailedStats;
const getJobs = storage.getJobs;
const getJobById = storage.getJobById;
const searchJobs = storage.searchJobs;
const storeJobs = storage.storeJobs;
const getConnectionStatus = storage.getConnectionStatus;
const markJobsInactive = storage.markJobsInactive;
const clearAllJobs = storage.clearAllJobs;
const Job = storage.Job;
const isConnected = storage.isConnected;
const inMemoryJobs = storage.inMemoryJobs;

// Queue management for concurrent search processing
const {
  initializeQueue,
  enqueueSearch,
  getQueueStats,
  closeQueue,
  isQueueEnabled,
} = require("./modules/queue");

// Job search and processing modules
const { startScheduler, runLifecycleTasks } = require("./modules/scheduler");
const { search } = require("./modules/search"); // Web search
const searchGoogleJobs = require("./modules/search_google_jobs"); // Google Jobs API
const { filterByJobSignal } = require("./modules/filter"); // URL filtering
const { fetchBatch } = require("./modules/fetcher"); // Web page fetching
const { extract } = require("./modules/extractor"); // Job data extraction
const { validateJobs } = require("./modules/validator"); // Job validation
const { deduplicate } = require("./modules/deduplicator"); // Deduplication
const { rankJobs } = require("./modules/ranker"); // Job ranking

// Initialize Express application
const app = express();

// Server-Sent Events (SSE) connection management
const activeConnections = new Map();
let connectionIdCounter = 0;
const MAX_SSE_CONNECTIONS = config.sse?.maxConnections || 500;

// Helmet.js for security headers
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
);

// Response compression
app.use(
  compression({
    level: 6,
    threshold: 1024,
    filter: (req, res) => {
      if (req.headers["accept"] === "text/event-stream") {
        return false;
      }
      return compression.filter(req, res);
    },
  }),
);

// CORS configuration for cross-origin requests
app.use(
  cors({
    origin: config.server?.corsOrigins || "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-ID"],
    credentials: true,
    maxAge: 86400,
  }),
);

// Body parsing middleware with size limits
app.use(express.json({ limit: config.server?.bodyLimit || "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Trust proxy - set to 1 to only trust the first proxy (prevents IP spoofing)
app.set("trust proxy", 1);

app.use((req, res, next) => {
  // Generate unique request ID or use provided one
  req.requestId =
    req.headers["x-request-id"] ||
    `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  req.startTime = Date.now();

  // Log slow requests or errors
  res.on("finish", () => {
    const duration = Date.now() - req.startTime;
    if (duration > 1000 || res.statusCode >= 400) {
      logger.info("Request completed", {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration: `${duration}ms`,
      });
    }
  });

  next();
});

// api rate limit 100 request per 15 min
const generalLimiter = rateLimit({
  windowMs: config.rateLimit?.windowMs || 15 * 60 * 1000, // 15 min
  max: config.rateLimit?.max || 100,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false }, // Disable trust proxy validation
  message: {
    status: "error",
    code: "RATE_LIMIT_EXCEEDED",
    message: "Too many requests. Please try again later.",
    retryAfter: Math.ceil((config.rateLimit?.windowMs || 900000) / 1000),
  },
});

// Search-specific rate limit (10 searches per minute)
const searchLimiter = rateLimit({
  windowMs: config.rateLimit?.searchWindowMs || 60 * 1000,
  max: config.rateLimit?.searchMax || 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false }, // Disable trust proxy validation
  message: {
    status: "error",
    code: "SEARCH_RATE_LIMIT_EXCEEDED",
    message: "Too many search requests. Please wait before searching again.",
    retryAfter: 60,
  },
});

app.use("/v1/", generalLimiter);

app.use(
  express.static("public", {
    maxAge: config.isProd ? "1d" : 0,
    etag: true,
  }),
);

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      status: "error",
      code: "VALIDATION_ERROR",
      errors: errors.array().map((e) => ({
        field: e.path,
        message: e.msg,
      })),
    });
  }
  next();
};

const sanitizeString = (value) => {
  if (typeof value !== "string") return value;
  return value.trim().slice(0, 200);
};


// get health check
app.get("/v1/health", async (req, res) => {
  const dbStatus = getConnectionStatus();
  const cacheStatus = getCacheStats();
  const queueStatus = await getQueueStats();

  const isHealthy = dbStatus.isConnected;

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? "healthy" : "degraded",
    timestamp: new Date().toISOString(),
    version: "2.0.0",
    uptime: Math.floor(process.uptime()),
    services: {
      database: {
        status: dbStatus.isConnected ? "connected" : "disconnected",
        type: "mongodb",
      },
      cache: {
        status: "healthy",
        type: "in-memory",
      },
      queue: {
        status: "direct",
        active: queueStatus.active || 0,
      },
    },
    connections: {
      sse: activeConnections.size,
      maxSse: MAX_SSE_CONNECTIONS,
    },
  });
});


// get stats
app.get("/v1/stats", optionalAuth, async (req, res) => {
  try {
    let stats = await getCachedStats();

    if (!stats) {
      stats = await getStats();
      await cacheStats(stats);
    }

    res.json({
      status: "success",
      data: stats,
      cached: !!stats,
    });
  } catch (error) {
    logger.error("Stats fetch failed", {
      error: error.message,
      requestId: req.requestId,
    });
    res.status(500).json({
      status: "error",
      code: "STATS_ERROR",
      message: "Failed to fetch statistics",
    });
  }
});


// get detailed stats
app.get("/v1/stats/detailed", async (req, res) => {
  try {
    const stats = await getDetailedStats();
    res.json({
      status: "success",
      data: stats,
    });
  } catch (error) {
    logger.error("Detailed stats fetch failed", { error: error.message });
    res.status(500).json({
      status: "error",
      code: "STATS_ERROR",
      message: "Failed to fetch detailed statistics",
    });
  }
});


// get cache stats
app.get("/v1/cache/stats", optionalAuth, async (req, res) => {
  try {
    const cacheStats = await cacheService.getCacheStats();
    res.json({
      status: "success",
      data: cacheStats,
    });
  } catch (error) {
    logger.error("Cache stats fetch failed", { error: error.message });
    res.status(500).json({
      status: "error",
      code: "CACHE_STATS_ERROR",
      message: "Failed to fetch cache statistics",
    });
  }
});


// Get jobs based on staff role
app.get(
  "/v1/jobs",
  authenticateMedicalStaff,
  [
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: 500 }).toInt(),
    query("search").optional().isString().trim().escape(),
    query("location").optional().isString().trim().escape(),
    query("lat").optional().isFloat({ min: -90, max: 90 }).toFloat(),
    query("lng").optional().isFloat({ min: -180, max: 180 }).toFloat(),
  ],
  validate,
  async (req, res) => {
    try {
      const { page, limit, offset } = getPaginationParams(
        req.query.page,
        req.query.limit,
      );
      const searchText = req.query.search;
      const location = req.query.location;
      const userLat = req.query.lat;
      const userLng = req.query.lng;

      // Get staff member's role from their profile
      const staffRole = req.medicalStaff.jobRole;
      
      // Find the role display name from config
      const roleDisplay = config.jobAgent.roles[staffRole] || staffRole;

      // Build criteria - only show jobs matching staff's role
      const criteria = {
        is_active: true,
        $or: [
          { role: { $regex: roleDisplay, $options: "i" } },
          { role: { $regex: staffRole, $options: "i" } }
        ]
      };

      console.log('DEBUG - Staff Role:', staffRole);
      console.log('DEBUG - Role Display:', roleDisplay);
      console.log('DEBUG - Query Criteria:', JSON.stringify(criteria, null, 2));

      // Add location filter if provided
      if (location && location.trim() !== '') {
          criteria.location = { $regex: location, $options: "i" };
      }

      // Get total count for pagination metadata
      const totalCount = await Job.countDocuments(criteria).catch(
        () =>
          inMemoryJobs.filter((job) => {
            return job.is_active === true && 
                   job.role?.toLowerCase().includes(roleDisplay.toLowerCase());
          }).length,
      );

      // Add cache bypass to cache key if provided
      const cacheBypass = req.query.cache_bypass;
      const cacheKey = JSON.stringify({
          criteria,
          limit,
          offset,
          search: searchText,
          page,
          userLat,
          userLng,
          staffRole,
          ...(cacheBypass && { cache_bypass: cacheBypass }),
      });

      let jobs = cacheBypass ? null : await getCachedJobs(cacheKey);

      if (!jobs || cacheBypass || jobs.length === 0) {
        try {
          if (searchText) {
            jobs = await Promise.race([
              searchJobs(searchText, limit),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Query timeout")), 5000),
              ),
            ]);
          } else {
            jobs = await Promise.race([
              getJobs(criteria, limit, offset),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Query timeout")), 5000),
              ),
            ]);
          }

          // Calculate distance if user coordinates provided
          if (userLat && userLng && jobs.length > 0) {
            for (const job of jobs) {
              if (job.coordinates && job.coordinates.latitude && job.coordinates.longitude) {
                const distanceResult = await geocodingService.calculateDistanceAndETA(
                  userLat,
                  userLng,
                  job.coordinates.latitude,
                  job.coordinates.longitude
                );
                job.distance = distanceResult.distance;
                job.duration = distanceResult.duration;
                job.distanceText = distanceResult.distanceText;
                job.durationText = distanceResult.durationText;
              }
            }
          }

          if (jobs.length > 0) {
            await cacheJobs(cacheKey, jobs);
          }
        } catch (error) {
          if (error.message === "Query timeout") {
            jobs = [];
          } else {
            throw error;
          }
        }
      }

      const pagination = getPaginationMeta(totalCount, page, limit);

      // Add cache control headers when force_refresh is used
      if (req.query.force_refresh === 'true') {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
      }

      res.json({
          status: "success",
          data: {
              staffRole: staffRole,
              staffRoleDisplay: roleDisplay,
              pagination: {
                  currentPage: pagination.currentPage,
                  totalPages: pagination.totalPages,
                  totalItems: pagination.totalItems,
                  itemsPerPage: pagination.itemsPerPage,
                  hasNextPage: pagination.hasNextPage,
                  hasPrevPage: pagination.hasPrevPage,
                  nextPage: pagination.nextPage,
                  prevPage: pagination.prevPage,
              },
              jobs,
          },
      });
    } catch (error) {
      logger.error("Staff jobs fetch failed", {
        error: error.message,
        requestId: req.requestId,
        staffRole: req.medicalStaff?.jobRole
      });
      res.status(500).json({
        status: "error",
        code: "JOBS_ERROR",
        message: "Failed to fetch jobs",
      });
    }
  },
);


// get single job by ID
app.get("/v1/jobs/:id", authenticateMedicalStaff, async (req, res) => {
  try {
    const job = await getJobById(req.params.id);

    if (!job) {
      return res.status(404).json({
        status: "error",
        code: "NOT_FOUND",
        message: "Job not found",
      });
    }

    res.json({
      status: "success",
      data: job,
    });
  } catch (error) {
    logger.error("Job fetch failed", {
      error: error.message,
      id: req.params.id,
    });
    res.status(500).json({
      status: "error",
      code: "JOB_ERROR",
      message: "Failed to fetch job",
    });
  }
});

// Clear all jobs
app.delete("/v1/jobs/clear", authenticateMedicalStaff, async (req, res) => {
  try {
    const result = await clearAllJobs();
    await Promise.all([invalidateStatsCache(), invalidateJobsCache()]).catch(
      () => {},
    );
    logger.info("Database cleared via API");

    res.json({
      status: "success",
      message: "Database cleared successfully",
      data: result,
    });
  } catch (error) {
    logger.error("Database clear failed", { error: error.message });
    res.status(500).json({
      status: "error",
      code: "DB_CLEAR_ERROR",
      message: "Failed to clear database",
    });
  }
});

// app.get(
//   "/v1/search/stream",
//   authenticateMedicalStaff,
//   searchLimiter,
//   [
//     query("role").notEmpty().trim().escape().withMessage("Role is required"),
//     query("location")
//       .notEmpty()
//       .trim()
//       .escape()
//       .withMessage("Location is required"),
//   ],
//   validate,
//   async (req, res) => {
//     if (activeConnections.size >= MAX_SSE_CONNECTIONS) {
//       return res.status(503).json({
//         status: "error",
//         code: "CONNECTION_LIMIT",
//         message: "Server is at capacity. Please try again later.",
//       });
//     }

//     const role =
//       sanitizeString(req.query.role) || req.medicalStaff?.jobRole || "nurse";
//     const location =
//       sanitizeString(req.query.location) ||
//       `${req.medicalStaff?.city}, ${req.medicalStaff?.area}` ||
//       "mumbai";

//     // Get user coordinates from query or medical staff
//     let userCoordinates = null;

//     // Try to get coordinates from query parameters first
//     if (req.query.lat && req.query.lng) {
//       userCoordinates = {
//         latitude: parseFloat(req.query.lat),
//         longitude: parseFloat(req.query.lng),
//       };
//     } else if (req.medicalStaff && req.medicalStaff.coordinates) {
//       userCoordinates = {
//         latitude: req.medicalStaff.coordinates.latitude,
//         longitude: req.medicalStaff.coordinates.longitude,
//       };
//     }

//     // generate unique id for tracking
//     const connectionId = ++connectionIdCounter;

//     // Extract username for storage
//     const username =
//       req.medicalStaff?.fullName ||
//       req.medicalStaff?.email ||
//       req.user?.name ||
//       req.user?.email ||
//       "anonymous";

//     res.setHeader("Content-Type", "text/event-stream");
//     res.setHeader("Cache-Control", "no-cache");
//     res.setHeader("Connection", "keep-alive");
//     res.setHeader("X-Accel-Buffering", "no");
//     res.flushHeaders();

//     const MAX_JOBS_SESSION = config.maxJobs || 30; // Default to 30 if not set
//     let jobsFoundCount = 0; // Track total jobs found in this session
//     const sentJobUrls = new Set(); // Track sent source_urls to prevent SSE duplicates
//     logger.info(`Starting search with MAX_JOBS_SESSION: ${MAX_JOBS_SESSION}`);

//     // track active connection
//     activeConnections.set(connectionId, {
//       res,
//       startTime: Date.now(),
//       role,
//       location,
//     });

//     // logger.info('SSE connection opened', {
//     //     connectionId,
//     //     role,
//     //     location,
//     //     total: activeConnections.size,
//     //     userId: req.user?._id || 'anonymous',
//     //     staffName: req.medicalStaff?.fullName || 'Test User',
//     //     staffRole: req.medicalStaff?.jobRole || role
//     // });

//     logger.info("SSE connection opened", {
//       connectionId,
//       role,
//       location,
//       total: activeConnections.size,
//       ...(req.user && { userId: req.user._id }),
//       ...(req.medicalStaff && {
//         staffName: req.medicalStaff.fullName,
//         staffRole: req.medicalStaff.jobRole,
//       }),
//     });

//     // const sendEvent = (type, data) => {
//     //     try {
//     //         const jsonData = JSON.stringify(data);
//     //         res.write(`event: ${type}\n`);
//     //         res.write(`data: ${JSON.stringify(data)}\n\n`);
//     //         res.flush();
//     //     } catch (e) {
//     //         logger.warn('Failed to send SSE event', { connectionId, error: e.message });
//     //         cleanup();
//     //     }
//     // };

//     const sendEvent = (type, data) => {
//       try {
//         const jsonData = JSON.stringify(data);
//         const eventString = `event: ${type}\ndata: ${jsonData}\n\n`;

//         res.write(eventString);
//         res.flush();

//         // Debug logging for job events
//         if (type === "job") {
//           logger.debug("Job sent via SSE", {
//             connectionId,
//             jobId: data.job?._id,
//             dataSize: jsonData.length,
//           });
//         } else if (type === "complete" || type === "error") {
//           logger.info(`${type.toUpperCase()} event sent via SSE`, {
//             connectionId,
//             dataSize: jsonData.length,
//             message: data.message,
//           });
//         }
//       } catch (e) {
//         logger.warn("Failed to send SSE event", {
//           connectionId,
//           error: e.message,
//           type,
//         });
//         cleanup();
//       }
//     };

//     const keepAlive = setInterval(() => {
//       try {
//         res.write(": keep-alive\n\n");
//       } catch (e) {
//         clearInterval(keepAlive);
//       }
//     }, config.sse?.keepAliveInterval || 15000);

//     const cleanup = () => {
//       if (!res.destroyed) {
//         try {
//           res.end();
//         } catch (e) {
//           // Connection already closed
//         }
//       }
//       clearInterval(keepAlive);
//       activeConnections.delete(connectionId);
//       logger.info("SSE connection closed", {
//         connectionId,
//         total: activeConnections.size,
//       });
//     };

//     req.on("close", cleanup);
//     req.on("error", cleanup);

//     try {
//       sendEvent("status", { message: "Starting search...", phase: "init" });

//       // Step 1: Check cache first
//       sendEvent("status", {
//         message: "Checking cached results...",
//         phase: "cache_check",
//       });

//       const cacheResult = await cacheService.checkCache(role, location);

//       if (cacheResult && cacheResult.jobs.length > 0) {
//         let { jobs, source, freshness } = cacheResult;

//         // Apply job limit to cached results
//         if (jobs.length > MAX_JOBS_SESSION) {
//           logger.info(
//             `Limiting cached jobs from ${jobs.length} to ${MAX_JOBS_SESSION}`,
//           );
//           jobs = jobs.slice(0, MAX_JOBS_SESSION);
//         }

//         sendEvent("status", {
//           message: `Found ${jobs.length} cached jobs (${freshness})`,
//           phase: "cache_hit",
//           source,
//           freshness,
//           jobCount: jobs.length,
//         });

//         // TRIGGER EXCEL SAVE FOR CACHED JOBS
//         if (username && jobs.length > 0) {
//           logger.info(
//             `Saving ${jobs.length} cached jobs to Excel/Sheets for user: ${username}`,
//           );
//           // Run in background to not block SSE
//           saveJobsToUserExcel(username, jobs).catch((err) =>
//             logger.error(
//               `Failed to save cached jobs to Excel for user ${username}`,
//               { error: err.message },
//             ),
//           );
//         }

//         // Send cached jobs immediately
//         logger.info(`Starting to send ${jobs.length} jobs via SSE`);
//         let sentCount = 0;
//         let skippedCount = 0;

//         for (const job of jobs) {
//           try {
//             let jobData = { job };

//             // Calculate distance if we have user coordinates and job location
//             if (userCoordinates && job.location) {
//               let jobCoords = job.coordinates;
//               if (!jobCoords) {
//                 jobCoords = await geocodingService.geocodeAddress(job.location);
//                 if (jobCoords) {
//                   await Job.findByIdAndUpdate(job._id, { coordinates: jobCoords });
//                 }
//               }

//               if (jobCoords) {
//                 const distance = geocodingService.calculateDistanceHaversine(
//                   userCoordinates.latitude,
//                   userCoordinates.longitude,
//                   jobCoords.latitude,
//                   jobCoords.longitude,
//                 );
//                 jobData.job.distance = Math.round((distance.distance || distance) * 10) / 10;
//               }
//             }

//             sendEvent("job", jobData);
//             sentCount++;
//             jobsFoundCount++;
//             if (job.source_url) sentJobUrls.add(job.source_url);
//           } catch (e) {
//             logger.warn("Failed to send job event", {
//               error: e.message,
//               jobId: job._id,
//             });
//           }
//         }

//         logger.info(
//           `SSE job sending completed: ${sentCount} sent, ${skippedCount} skipped`,
//         );

//         // If results are fresh, we can stop here
//         if (freshness === "fresh") {
//           sendEvent("complete", {
//             message: `Search completed using cached results`,
//             jobCount: jobs.length,
//             source: "cache",
//             cached: true,
//           });

//           setTimeout(() => {
//             cleanup();
//           }, 100); // Small delay to ensure final event is sent
//           return;
//         }

//         // If results are stale, continue with fresh search but inform user
//         sendEvent("status", {
//           message: "Cached results are stale, searching for fresh jobs...",
//           phase: "fresh_search_start",
//           initialJobCount: sentCount,
//           hasInitialResults: true,
//         });
//       } else {
//         sendEvent("status", {
//           message: "No cached results found, performing fresh search...",
//           phase: "cache_miss",
//         });
//       }

//       // Step 2: Perform fresh search (either no cache or stale cache)
//       const [searchResults, googleJobs] = await Promise.all([
//         search(role, location),
//         config.enableGoogleJobs
//           ? searchGoogleJobs(role, location)
//           : Promise.resolve([]),
//       ]);

//       sendEvent("status", {
//         message: `Found ${searchResults.urls.length} URLs + ${googleJobs.length} aggregated jobs`,
//         phase: "search_complete",
//         urlCount: searchResults.urls.length,
//         googleJobsCount: googleJobs.length,
//       });

//       if (searchResults.urls.length === 0 && googleJobs.length === 0) {
//         sendEvent("complete", { message: "No results found", jobCount: 0 });
//         cleanup();
//         return;
//       }

//       let allJobs = [];

//       // jobsFoundCount and MAX_JOBS_SESSION are now defined at the top scope

//       if (googleJobs.length > 0) {
//         sendEvent("status", {
//           message: "Processing aggregated jobs...",
//           phase: "google_jobs",
//         });

//         // slice google jobs to fit remaining quota
//         const remainingQuota = MAX_JOBS_SESSION - jobsFoundCount;
//         const jobsToProcess = googleJobs.slice(0, remainingQuota);

//         if (jobsToProcess.length < googleJobs.length) {
//           logger.info(
//             `Limiting Google jobs from ${googleJobs.length} to ${jobsToProcess.length} due to maxJobs limit (${MAX_JOBS_SESSION})`,
//           );
//         }

//         const validatedGoogle = validateJobs(jobsToProcess, role, location);

//         if (validatedGoogle.valid.length > 0) {
//           // STORE IMMEDIATELY
//           logger.info(
//             `Storing ${validatedGoogle.valid.length} Google jobs immediately`,
//           );
//           const rankedGoogle = rankJobs(validatedGoogle.valid, role, location);

//           // Username already extracted at handler start

//           const { unique: dedupedGoogle } = deduplicate(rankedGoogle);
//           await storeJobs(dedupedGoogle, `${role} in ${location}`, { username });
//           saveJobsToUserExcel(username, dedupedGoogle).catch((err) =>
//             logger.error(`Failed to save Google jobs to Sheets for ${username}`, { error: err.message })
//           );

//           for (const job of dedupedGoogle) {
//             if (job.source_url && sentJobUrls.has(job.source_url)) continue;
//             if (userCoordinates && job.location) {
//               let jobCoords = job.coordinates;
//               if (!jobCoords) {
//                 jobCoords = await geocodingService.geocodeAddress(job.location);
//                 if (jobCoords) {
//                   await Job.findByIdAndUpdate(job._id, { coordinates: jobCoords });
//                 }
//               }

//               if (jobCoords) {
//                 const distance = geocodingService.calculateDistanceHaversine(
//                   userCoordinates.latitude,
//                   userCoordinates.longitude,
//                   jobCoords.latitude,
//                   jobCoords.longitude,
//                 );
//                 job.distance = Math.round((distance.distance || distance) * 10) / 10;
//               }
//             }

//             allJobs.push(job);
//             sendEvent("job", { job });
//             jobsFoundCount++;
//             if (job.source_url) sentJobUrls.add(job.source_url);
//           }
//         }
//       }

//       if (searchResults.urls.length > 0) {
//         sendEvent("status", {
//           message: "Filtering by job signals...",
//           phase: "filter",
//         });
//         const filterResult = filterByJobSignal(searchResults.urls);

//         sendEvent("status", {
//           message: `${filterResult.highSignal.length} high-signal, ${filterResult.needsFetch.length} need fetch`,
//           phase: "filter_complete",
//         });

//         if (filterResult.highSignal.length > 0) {
//           // Check if quota remaining
//           if (jobsFoundCount >= MAX_JOBS_SESSION) {
//             logger.info(
//               `Max jobs limit (${MAX_JOBS_SESSION}) reached. Skipping snippet extraction.`,
//             );
//           } else {
//             sendEvent("status", {
//               message: "Extracting from snippets...",
//               phase: "snippet_extract",
//             });
//             const snippetJobs = await extract({
//               snippets: filterResult.highSignal,
//               role,
//               location,
//             });

//             // Validate & Store Snippet Jobs IMMEDIATELY
//             const validatedSnippets = validateJobs(snippetJobs, role, location);
//             if (validatedSnippets.valid.length > 0) {
//               // Slice to fit remaining quota
//               const remainingQuota = MAX_JOBS_SESSION - jobsFoundCount;
//               const snippetsToProcess = validatedSnippets.valid.slice(
//                 0,
//                 remainingQuota,
//               );

//               if (snippetsToProcess.length < validatedSnippets.valid.length) {
//                 logger.info(
//                   `Limiting Snippet jobs from ${validatedSnippets.valid.length} to ${snippetsToProcess.length} due to maxJobs limit`,
//                 );
//               }

//               if (snippetsToProcess.length > 0) {
//                 logger.info(
//                   `Storing ${snippetsToProcess.length} snippet jobs immediately`,
//                 );
//                 const rankedSnippets = rankJobs(
//                   snippetsToProcess,
//                   role,
//                   location,
//                 );
//                 const { unique: dedupedSnippets } = deduplicate(rankedSnippets);
//                 await storeJobs(dedupedSnippets, `${role} in ${location}`, {
//                   username,
//                 });
//                 saveJobsToUserExcel(username, dedupedSnippets).catch((err) =>
//                   logger.error(`Failed to save snippet jobs to Sheets for ${username}`, { error: err.message })
//                 );

//                 for (const job of dedupedSnippets) {
//                   if (job.source_url && sentJobUrls.has(job.source_url)) continue;
//                   if (userCoordinates && job.location) {
//                     let jobCoords = job.coordinates;
//                     if (!jobCoords) {
//                       jobCoords = await geocodingService.geocodeAddress(job.location);
//                       if (jobCoords) {
//                         await Job.findByIdAndUpdate(job._id, { coordinates: jobCoords });
//                       }
//                     }
//                     if (jobCoords) {
//                       const distance = geocodingService.calculateDistanceHaversine(
//                         userCoordinates.latitude,
//                         userCoordinates.longitude,
//                         jobCoords.latitude,
//                         jobCoords.longitude,
//                       );
//                       job.distance = Math.round((distance.distance || distance) * 10) / 10;
//                     }
//                   }

//                   allJobs.push(job);
//                   sendEvent("job", { job });
//                   jobsFoundCount++;
//                   if (job.source_url) sentJobUrls.add(job.source_url);
//                 }
//               }
//             }
//           }
//         }

//         if (filterResult.needsFetch.length > 0) {
//           sendEvent("status", {
//             message: `Found ${filterResult.needsFetch.length} potential job pages. Processing in batches...`,
//             phase: "fetch",
//           });

//           // Callback for incremental storage
//           const onBatchComplete = async (batchJobs) => {
//             // Check quota
//             if (jobsFoundCount >= MAX_JOBS_SESSION) {
//               logger.info(
//                 `Max jobs limit (${MAX_JOBS_SESSION}) reached. Ignoring fetched batch.`,
//               );
//               return false; // Stop processing
//             }

//             const validatedBatch = validateJobs(batchJobs, role, location);
//             if (validatedBatch.valid.length > 0) {
//               // Slice to fit remaining quota
//               const remainingQuota = MAX_JOBS_SESSION - jobsFoundCount;
//               const jobsToProcess = validatedBatch.valid.slice(
//                 0,
//                 remainingQuota,
//               );

//               if (jobsToProcess.length < validatedBatch.valid.length) {
//                 logger.info(
//                   `Limiting Fetched jobs from ${validatedBatch.valid.length} to ${jobsToProcess.length} due to maxJobs limit`,
//                 );
//               }

//               if (jobsToProcess.length > 0) {
//                 logger.info(`Incremental store: ${jobsToProcess.length} jobs`);
//                 const rankedBatch = rankJobs(jobsToProcess, role, location);
//                 const { unique: dedupedBatch } = deduplicate(rankedBatch);
//                 await storeJobs(dedupedBatch, `${role} in ${location}`, {
//                   username,
//                 });
//                 saveJobsToUserExcel(username, dedupedBatch).catch((err) =>
//                   logger.error(`Failed to save fetched jobs to Sheets for ${username}`, { error: err.message })
//                 );

//                 for (const job of dedupedBatch) {
//                   if (job.source_url && sentJobUrls.has(job.source_url)) continue;
//                   if (userCoordinates && job.location) {
//                     let jobCoords = job.coordinates;
//                     if (!jobCoords) {
//                       jobCoords = await geocodingService.geocodeAddress(job.location);
//                       if (jobCoords) {
//                         await Job.findByIdAndUpdate(job._id, { coordinates: jobCoords });
//                       }
//                     }
//                     if (jobCoords) {
//                       const distance = geocodingService.calculateDistanceHaversine(
//                         userCoordinates.latitude,
//                         userCoordinates.longitude,
//                         jobCoords.latitude,
//                         jobCoords.longitude,
//                       );
//                       job.distance = Math.round((distance.distance || distance) * 10) / 10;
//                     }
//                   }

//                   allJobs.push(job);
//                   sendEvent("job", { job });
//                   jobsFoundCount++;
//                   if (job.source_url) sentJobUrls.add(job.source_url);
//                 }
//               }
//             }

//             if (jobsFoundCount >= MAX_JOBS_SESSION) {
//               return false;
//             }
//             return true;
//           };

//           // Chunked Fetching Loop
//           const FETCH_BATCH_SIZE = 5;
//           for (
//             let i = 0;
//             i < filterResult.needsFetch.length;
//             i += FETCH_BATCH_SIZE
//           ) {
//             // Check limit before starting next fetch batch
//             if (jobsFoundCount >= MAX_JOBS_SESSION) {
//               logger.info(
//                 `Max jobs limit (${MAX_JOBS_SESSION}) reached. Stopping fetch loop.`,
//               );
//               break;
//             }

//             const chunk = filterResult.needsFetch.slice(
//               i,
//               i + FETCH_BATCH_SIZE,
//             );
//             sendEvent("status", {
//               message: `Fetching batch ${
//                 Math.floor(i / FETCH_BATCH_SIZE) + 1
//               } (${chunk.length} URLs)...`,
//               phase: "fetch",
//             });

//             try {
//               const fetchedDocs = await fetchBatch(chunk, 5);
//               if (fetchedDocs.length > 0) {
//                 sendEvent("status", {
//                   message: `Extracting details from batch ${
//                     Math.floor(i / FETCH_BATCH_SIZE) + 1
//                   }...`,
//                   phase: "extract",
//                 });

//                 await extract({
//                   documents: fetchedDocs,
//                   role,
//                   location,
//                   onBatchComplete,
//                 });
//               }
//             } catch (err) {
//               logger.error("Error processing fetch batch", {
//                 error: err.message,
//               });
//             }
//           }
//         }
//       }

//       // Final completion event (no big save at the end needed for persistence, but we can do a final log)
//       logger.info(
//         `Search sequence complete. Total jobs processed: ${allJobs.length}`,
//       );

//       // Calculate totals based on what was actually sent
//       // activeConnections.get(connectionId).jobsSentCount would be ideal, but we can infer
//       const cachedSentCount =
//         (cacheResult?.jobs?.length || 0) > MAX_JOBS_SESSION
//           ? MAX_JOBS_SESSION
//           : cacheResult?.jobs?.length || 0;
//       const totalJobs = allJobs.length + cachedSentCount;

//       const sources = [];
//       if (cachedSentCount > 0) sources.push(`${cachedSentCount} cached`);
//       if (allJobs.length > 0) sources.push(`${allJobs.length} fresh`);

//       logger.info("Sending complete event via SSE", {
//         connectionId,
//         totalJobs,
//         sources: sources.join(" + "),
//       });

//       sendEvent("complete", {
//         message: `Search completed: ${sources.join(" + ")}`,
//         jobCount: totalJobs,
//         freshJobs: allJobs.length,
//         cachedJobs: cachedSentCount,
//         sources: sources,
//       });

//       // Force flush after complete event
//       try {
//         res.flush();
//       } catch (e) {
//         logger.warn("Failed to flush after complete event", {
//           error: e.message,
//         });
//       }

//       // Clean up connections if needed
//       setTimeout(() => {
//         cleanup();
//       }, 1000);
//     } catch (error) {
//       logger.error("Search stream failed", {
//         error: error.message,
//         connectionId,
//       });
//       sendEvent("error", { message: "Search failed: " + error.message });
//       cleanup();
//     }
//   },
// );





// Get agent status
app.get("/v1/agent/status", authenticateMedicalStaff, async (req, res) => {
  try {
    const agentStatus = automatedAgent.getStatus();
    const schedulerStatus = scheduler.getSchedulerStatus();

    res.json({
      status: "success",
      data: {
        automatedAgent: agentStatus,
        scheduler: schedulerStatus,
        lastDataCleanup: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error("Agent status fetch failed", {
      error: error.message,
      requestId: req.requestId,
    });
    res.status(500).json({
      status: "error",
      code: "AGENT_STATUS_ERROR",
      message: "Failed to fetch agent status",
    });
  }
});



// get queue status
app.get("/v1/queue/status", async (req, res) => {
  const stats = await getQueueStats();
  res.json({
    status: "success",
    data: stats,
  });
});


// get active connections
app.get("/v1/connections", (req, res) => {
  res.json({
    status: "success",
    data: {
      active: activeConnections.size,
      max: MAX_SSE_CONNECTIONS,
      connections: Array.from(activeConnections.entries()).map(
        ([id, conn]) => ({
          id,
          role: conn.role,
          location: conn.location,
          duration: Math.floor((Date.now() - conn.startTime) / 1000),
        }),
      ),
    },
  });
});


app.use((req, res) => {
  res.status(404).json({
    status: "error",
    code: "NOT_FOUND",
    message: `Route ${req.method} ${req.path} not found`,
  });
});


app.use((err, req, res, next) => {
  logger.error("Unhandled error", {
    error: err.message,
    stack: config.isProd ? undefined : err.stack,
    requestId: req.requestId,
  });

  res.status(err.status || 500).json({
    status: "error",
    code: err.code || "INTERNAL_ERROR",
    message: config.isProd ? "An unexpected error occurred" : err.message,
  });
});

let server = null;

async function startServer(role, location, cronSchedule) {
  logger.info("Initializing server...");

  await connectDb();

  const { findJobs } = await import("./index.js");
  await initializeQueue(findJobs);

  if (role && location) {
    startScheduler(role, location, cronSchedule);
  } else {
    runLifecycleTasks();
  }

  const PORT = config.server?.port || 3000;
  const HOST = config.server?.host || "::";

  server = app.listen(PORT, HOST, () => {
    logger.info(`Server running on http://${HOST}:${PORT}`, {
      env: config.env,
      nodeVersion: process.version,
      version: "2.1.0-incremental-persistence",
    });
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  setupGracefulShutdown();

  return server;
}


// Add initialization state tracking
let isAgentInitialized = false;

async function initAgent() {
  // Prevent multiple initializations
  if (isAgentInitialized) {
    return true;
  }

  try {
    logger.info("Initializing Agent Services within Backend...");

    // Initialize core services
    await connectDb(); // mongoose.connect handles multiple calls gracefully

    // Initialize the job search queue
    const { findJobs } = require("./index.js");
    await initializeQueue(findJobs);

    // Run maintenance/lifecycle tasks
    runLifecycleTasks();

    isAgentInitialized = true;
    logger.info("✅ Agent Services initialized successfully");
    return true;
  } catch (error) {
    logger.error("❌ Failed to initialize Agent Services:", {
      message: error.message,
      stack: error.stack,
    });
    throw error;
  }
}


function setupGracefulShutdown() {
  const shutdown = async (signal) => {
    logger.info(`${signal} received, starting graceful shutdown...`);

    for (const [id, conn] of activeConnections) {
      try {
        conn.res.write(
          'event: shutdown\ndata: {"message": "Server shutting down"}\n\n',
        );
        conn.res.end();
      } catch (e) {}
    }
    activeConnections.clear();

    if (server) {
      server.close(async () => {
        logger.info("HTTP server closed");

        await closeQueue();
        await disconnectDb();

        logger.info("Graceful shutdown complete");
        process.exit(0);
      });

      setTimeout(() => {
        logger.error("Forced shutdown after timeout");
        process.exit(1);
      }, 30000);
    } else {
      // Standalone services shutdown if server wasn't started
      await closeQueue();
      await disconnectDb();
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception", {
      error: err.message,
      stack: err.stack,
    });
    shutdown("UNCAUGHT_EXCEPTION");
  });

  process.on("unhandledRejection", (reason, promise) => {
    logger.error("Unhandled rejection", { reason: reason?.message || reason });
  });
}

module.exports = { app, startServer, initAgent, activeConnections };
