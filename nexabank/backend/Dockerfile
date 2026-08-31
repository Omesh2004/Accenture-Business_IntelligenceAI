# ─── NexaBank Backend ───
FROM node:22-alpine AS base

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci

# Copy prisma schema and generate client
COPY prisma ./prisma
RUN npx prisma generate

# Copy source code
COPY . .

# Expose port
EXPOSE 5000

# Run migration, seed, then start dev server
CMD sh -c "npx prisma db push --skip-generate && npx ts-node src/seedTenants.ts && npx nodemon --ext ts --exec 'npx ts-node src/server.ts'"
