process.env.TZ = "Asia/Kolkata";
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const crypto = require("crypto");
const mongoose = require("mongoose");
require("dotenv").config();

const authRoutes = require("./routes/auth.routes");
const reviewRoutes = require("./routes/review.routes");
const logger = require("./utils/logger");
// Only run interval-based cron in persistent environments (local dev)
// On Vercel, cron jobs are handled via api/cron/* endpoints + vercel.json schedules

const app = express();

// Security middleware
app.use(helmet());

// CORS configuration - Open for all origins
const corsOptions = {
  origin: true,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Accept",
    "X-Requested-With",
    "Origin",
    "Access-Control-Request-Method",
    "Access-Control-Request-Headers",
    "Cache-Control",
  ],
  exposedHeaders: ["Content-Length", "X-Request-ID"],
  maxAge: 86400,
  optionsSuccessStatus: 200,
};

// Apply CORS middleware
app.use(cors(corsOptions));

// Body parsing middleware
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));

// Request ID middleware
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  next();
});

// Request logging
app.use(morgan("combined"));

// Add specific trust proxy setting
app.set("trust proxy", ["loopback", "linklocal", "uniquelocal"]);

// Request timeout middleware
app.use((req, res, next) => {
  req.setTimeout(30000, () => {
    res.status(408).json({
      success: false,
      message: "Request timeout",
    });
  });
  next();
});

// Health check endpoint
app.get("/health", (req, res) => {
  const healthCheck = {
    status: "OK",
    timestamp: new Date().toISOString(),
    service: "HospiLink API",
    version: "1.0.0",
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    requestId: req.requestId,
    dbStatus: mongoose.connection.readyState,
  };

  res.status(200).json(healthCheck);
});

// CORS test endpoint
app.get("/api/test-cors", (req, res) => {
  res.status(200).json({
    success: true,
    message: "CORS is working!",
    origin: req.headers.origin,
    timestamp: new Date().toISOString(),
  });
});

// Root route
app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Welcome to HospiLink API",
    service: "HospiLink API",
    version: "1.0.0",
    documentation: "/api-docs", // If you have docs
    health: "/health",
  });
});

// API Routes
app.use("/api/auth", authRoutes);
app.use("/api/profile", require("./routes/profile.routes"));
app.use("/api/dashboard", require("./routes/dashboard.routes"));
app.use("/api/notifications", require("./routes/notification.routes"));
app.use("/api/reviews", reviewRoutes);


// Document Management Routes
app.use("/api/documents", require("./routes/document.routes"));

// Agent - AI Job Finder routes (mounted BEFORE general /api route to avoid auth conflicts)
const agentApp = require("../agent/api").app;
app.use("/api/agent", agentApp);

// Admin routes
app.use("/api/admin", require("./routes/admin.routes"));

// General API routes (should be last to avoid matching Agent routes)
app.use("/api", require("./routes/duty.routes"));

// 404 handler - FIXED: Use a function instead of *
app.use((req, res, next) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
    requestId: req.requestId,
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error(`Error: ${err.message}`, {
    requestId: req.requestId,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
  });

  const statusCode = err.statusCode || 500;
  // TEMPORARY DEBUGGING: Always show error message
  const message = err.message;

  res.status(statusCode).json({
    success: false,
    message: message,
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
    requestId: req.requestId,
  });
});

// Graceful shutdown handler
const gracefulShutdown = () => {
  logger.info("Received shutdown signal, shutting down gracefully...");
  process.exit(0);
};

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

module.exports = app;
