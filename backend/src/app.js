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
const adminRoutes = require("./routes/admin.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const documentRoutes = require("./routes/document.routes");
const dutyRoutes = require("./routes/duty.routes");
const jobVacancyRoutes = require("./routes/jobVacancy.routes");
const jobApplicationRoutes = require("./routes/jobApplication.routes");
const jobVacancyPublicRoutes = require("./routes/jobVacancyPublic.routes");
const hospitalDashboardRoutes = require("./routes/hospitalDashboard.routes");
const notificationRoutes = require("./routes/notification.routes");
const profileRoutes = require("./routes/profile.routes");
const ticketRoutes = require("./routes/ticket.routes");
const logger = require("./utils/logger");
// Only run interval-based cron in persistent environments (local dev)
// On Vercel, cron jobs are handled via api/cron/* endpoints + vercel.json schedules

const { buildCorsOptions } = require('./config/cors.config');

const app = express();

// Security middleware
app.use(helmet());

const corsOptions = buildCorsOptions();

// Apply CORS middleware
app.use(cors(corsOptions));

// Handle OPTIONS preflight explicitly before any other middleware
app.options('*', cors(corsOptions));

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
app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal', '172.16.0.0/12', '192.168.0.0/16', '10.0.0.0/8']);

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
app.use("/api/profile", profileRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/tickets", ticketRoutes);
app.use("/api/admin/tickets", require("./routes/adminTicket.routes"));
app.use("/api/chatbot", require("./routes/chatbot.routes"));
app.use("/api/admin/knowledge-base", require("./routes/adminKnowledgeBase.routes"));
app.use("/api/admin", require("./routes/adminPattern.routes"));
app.use("/api/account", require("./routes/accountStanding.routes"));
app.use("/api/support/feedback", require("./routes/feedback.routes"));
app.use("/api/admin/feedback", require("./routes/adminFeedback.routes"));


// Document Management Routes
app.use("/api/documents", documentRoutes);
app.use("/api/webhook", require("./routes/webhook.route"));

// Admin routes
app.use("/api/admin", adminRoutes);

// Hospital dashboard routes
app.use("/api/hospital-dashboard", hospitalDashboardRoutes);

// Activity Log routes (admin only)
app.use("/api/admin/activity-logs", require("./routes/activityLog.routes"));

// Public job vacancy routes
app.use("/api", jobVacancyPublicRoutes);

// General API routes (should be last to avoid matching Agent routes)
app.use("/api", dutyRoutes);
// Mounted before jobVacancyRoutes — defensive ordering so a future
// '/vacancies/...' route added to either router can never accidentally
// shadow the other (see jobApplication.routes.js's routing comment).
app.use("/api", jobApplicationRoutes);
app.use("/api", jobVacancyRoutes);

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
  const message = process.env.NODE_ENV === 'production' && statusCode === 500
    ? 'Internal server error'
    : err.message;

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