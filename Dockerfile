FROM node:20-alpine as builder

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm prune --production

FROM node:20-alpine

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

COPY package*.json ./

COPY --from=builder /app/node_modules ./node_modules

COPY --chown=node:node . .

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

USER nodejs

EXPOSE 3000
EXPOSE 3002


# Use npx instead of global concurrently, with dumb-init
CMD ["dumb-init", "sh", "-c", "npx concurrently 'npm start' 'npm run agent:start'"]