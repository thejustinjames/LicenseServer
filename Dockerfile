FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci

COPY . .

RUN npm run db:generate
RUN npm run build

FROM node:20-alpine AS runner

WORKDIR /app

# Install openssl for Prisma and curl for health checks
RUN apk add --no-cache openssl curl

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 appuser

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/public ./public

# Fix ownership for appuser
RUN chown -R appuser:nodejs /app

USER appuser

EXPOSE 3000

CMD ["sh", "-c", "npx prisma db push --skip-generate && npm start"]
