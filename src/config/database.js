const mongoose = require("mongoose");
const logger = require("../utils/logger");

// Global cache to prevent multiple connections in serverless environment
let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

const connectDB = async () => {
  if (cached.conn) {
    logger.info("MongoDB using cached connection");
    return cached.conn;
  }

  if (!cached.promise) {
    const opts = {
      dbName: "Hospilink",
      serverSelectionTimeoutMS: 10000,  // Reduced from 50s to 10s
      socketTimeoutMS: 45000,            // Reduced from 60s to 45s
      connectTimeoutMS: 10000,           // Reduced from 30s to 10s

      bufferCommands: false, // Disable mongoose buffering to fail fast if not connected
      family: 4, // Force IPv4 to avoid ENOTFOUND errors on some systems
    };

    logger.info("MongoDB initiating new connection...");
    cached.promise = mongoose
      .connect(process.env.MONGODB_URI, opts)
      .then((mongoose) => {
        logger.info(`MongoDB Connected: ${mongoose.connection.host}`);
        return mongoose;
      })
      .catch((err) => {
        logger.error(`MongoDB connection error: ${err.message}`);
        // Clear promise so we can retry on next request
        cached.promise = null;
        throw err;
      });
  }

  try {
    cached.conn = await cached.promise;
  } catch (e) {
    cached.promise = null;
    throw e;
  }

  return cached.conn;
};

module.exports = connectDB;

