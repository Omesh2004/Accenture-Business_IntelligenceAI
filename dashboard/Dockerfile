# ─── Analytics Dashboard (Next.js) ───
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --legacy-peer-deps

# Copy source code
COPY . .

# Expose port
EXPOSE 3001

# Run Next.js dev server on port 3001
# Dev by default (hot reload). NEXT_MODE=production builds ahead of time instead:
# in dev Next compiles each route on first navigation, which cost 17-24s per page
# and looked like the app had hung.
CMD ["sh", "-c", "if [ \"$NEXT_MODE\" = production ]; then npx next build && npx next start -p 3001; else npx next dev --turbopack -p 3001; fi"]

