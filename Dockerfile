# ── API + worker image ──────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspaces --include-workspace-root

FROM node:22-alpine AS api
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN mkdir -p /app/.data && chown -R app:app /app/.data
USER app
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1
CMD ["npx", "tsx", "apps/api/src/server.ts"]

# ── Web (static build behind nginx) ─────────────────────
FROM deps AS web-build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w @vo/web

FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
