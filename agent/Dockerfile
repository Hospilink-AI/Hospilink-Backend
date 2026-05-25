FROM node:20-alpine

# Install dumb-init for proper signal handling and curl for health checks
RUN apk add --no-cache dumb-init curl

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

EXPOSE 3002

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "start.js"]
