# ── Builder Stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy agent package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy agent source code
COPY . .

# ── Final Stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine

# Install dumb-init and curl for health checks
RUN apk add --no-cache dumb-init curl

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001 -G nodejs

# Copy built app from builder stage
COPY --from=builder --chown=nodejs:nodejs /app /app

USER nodejs

ENV NODE_ENV=production

EXPOSE 3002

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "start.js"]