FROM node:20-slim AS builder

# Install build tools needed to compile native modules (canvas, sharp) if prebuilt binaries are unavailable
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    pkg-config \
    libcairo2-dev \
    libjpeg-dev \
    libpango1.0-dev \
    libgif-dev \
    libpixman-1-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

# ---- Final image ----
FROM node:20-slim

# Runtime libs for canvas/sharp + chromium for puppeteer + curl for health checks
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    curl \
    ca-certificates \
    chromium \
    libcairo2 \
    libjpeg62-turbo \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libgif7 \
    libpixman-1-0 \
    && rm -rf /var/lib/apt/lists/*

# Use system Chromium instead of bundled puppeteer Chromium (~250MB saved)
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs -M -s /usr/sbin/nologin nodejs

# Copy built node_modules from builder stage
COPY --from=builder /app/node_modules ./node_modules

# Copy source code
COPY --chown=nodejs:nodejs . .

USER nodejs

ENV NODE_ENV=production

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
