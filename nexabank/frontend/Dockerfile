# ─── NexaBank Frontend ───
FROM node:22-alpine AS base

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source code
COPY . .

# Expose port
EXPOSE 3002

# Run Next.js dev server on port 3002
# Dev by default (hot reload). NEXT_MODE=production builds ahead of time instead:
# in dev Next compiles each route on first navigation, which cost 17-24s per page
# and looked like the app had hung.
CMD ["sh", "-c", "if [ \"$NEXT_MODE\" = production ]; then npx next build && npx next start -p 3002; else npx next dev --turbopack -p 3002; fi"]

