FROM node:20-alpine

# Install dumb-init, curl, and native build tools for canvas/sharp/gyp
RUN apk add --no-cache \
    dumb-init \
    curl \
    python3 \
    make \
    g++ \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    giflib-dev \
    pixman-dev


WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001 -G nodejs

# Install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source code
COPY --chown=nodejs:nodejs . .

USER nodejs

ENV NODE_ENV=production

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
