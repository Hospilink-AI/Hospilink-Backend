FROM node:24-alpine AS builder

# Install build tools needed to compile native modules (canvas, sharp)
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    giflib-dev \
    pixman-dev

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ---- Final image ----
FROM node:24-alpine

# Runtime libs for canvas/sharp + chromium for puppeteer + curl for health checks
RUN apk add --no-cache \
    dumb-init \
    curl \
    chromium \
    cairo \
    jpeg \
    pango \
    giflib \
    pixman

# Use system Chromium instead of bundled puppeteer Chromium (~250MB saved)
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001 -G nodejs

# Copy built node_modules from builder stage
COPY --from=builder /app/node_modules ./node_modules

# Copy source code
COPY --chown=nodejs:nodejs . .

USER nodejs

ENV NODE_ENV=production

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]