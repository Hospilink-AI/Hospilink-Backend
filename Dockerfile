FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./

# Install production deps only — no devDependencies in final image
RUN npm ci --omit=dev

COPY . .

# ── Final image ──────────────────────────────────────────────────────────────
FROM node:20-alpine

# dumb-init: PID 1 process that forwards signals correctly to Node
# Without this, SIGTERM from ECS never reaches your graceful shutdown handlers
RUN apk add --no-cache dumb-init

WORKDIR /app

# Create non-root user before copying files
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001 -G nodejs

# Copy built app from builder stage with correct ownership
COPY --from=builder --chown=nodejs:nodejs /app /app

USER nodejs

ENV NODE_ENV=production

# SERVICE controls which process this container runs:
#   docker build --build-arg SERVICE=api   → node server.js      (port 3000)
#   docker build --build-arg SERVICE=agent → node agent/start.js (port 3002)
ARG SERVICE=api
ENV SERVICE=${SERVICE}

EXPOSE 3000
EXPOSE 3002

# dumb-init as entrypoint ensures Node receives SIGTERM/SIGINT from ECS
ENTRYPOINT ["dumb-init", "--"]

# exec form: shell evaluates the if/else, then exec replaces itself with node
# so Node becomes the direct child of dumb-init (correct signal chain)
CMD ["sh", "-c", "if [ \"$SERVICE\" = \"agent\" ]; then exec node agent/start.js; else exec node server.js; fi"]
