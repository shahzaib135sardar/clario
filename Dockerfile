# syntax=docker/dockerfile:1
# Multi-stage build: the final image holds only the built web app and the bundled server.

FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Browser-safe values only (the Supabase URL and anon key are public by design).
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_TURNSTILE_SITE_KEY
ARG VITE_FEATURE_AI_CHAT=false
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_TURNSTILE_SITE_KEY=$VITE_TURNSTILE_SITE_KEY \
    VITE_FEATURE_AI_CHAT=$VITE_FEATURE_AI_CHAT
RUN npx vite build && npm run build:server

FROM node:26-alpine AS runtime
ENV NODE_ENV=production PORT=8080 STATIC_DIR=/app/dist TRUST_PROXY=true
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server
# Secrets are never baked in: they arrive as runtime environment variables.
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "dist-server/index.js"]
