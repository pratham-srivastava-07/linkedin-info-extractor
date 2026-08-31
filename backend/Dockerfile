# ProfileLens API.
#
# A stock Node base image, and that is the point. Extraction is direct HTTPS to
# LinkedIn's Voyager API with no browser in the request path, so there is no
# Playwright base image, no headless Chromium, and none of the system libraries
# either would drag in — nothing here needs `apk add` at all.
#
# Size, honestly: the built image is ~600MB, and almost all of it is Prisma.
# `@prisma/client` pulls the `prisma` CLI and `typescript` in as optional peer
# dependencies, which `npm prune --omit=dev` cannot remove because they are
# reachable from a production package. That is worth knowing before anyone reads
# the no-browser design as a promise of a tiny image; what it actually buys is a
# stock base image, no system dependencies to keep patched, and a cold start in
# under a second. The CLI riding along is not wasted — see "migrations" in
# README.md, which runs `prisma migrate deploy` straight out of this image.

FROM node:22-alpine AS base
WORKDIR /app

# ---- build: full dependency tree, generate the Prisma client, compile to dist/
FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate && npm run build
# Prune in place rather than resolving a second tree in a separate stage: the
# generated Prisma client lives in node_modules/.prisma, so a fresh
# `npm ci --omit=dev` elsewhere would have to have it copied back over the top —
# and a COPY cannot shrink the layer underneath it, so the discarded copy stays
# in the image. Pruning leaves exactly one node_modules to carry forward.
# `npm prune` does not touch dot-directories, so .prisma and .bin survive.
RUN npm prune --omit=dev

# ---- runner
FROM base AS runner
ENV NODE_ENV=production
# So a container started with no PORT set matches the documented default.
ENV PORT=4000

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Kept so `prisma migrate deploy` can be run against this image's schema.
COPY prisma ./prisma

# `node` exists in the base image; running unprivileged costs nothing here.
USER node
EXPOSE 4000

# Exec form, so node is PID 1 and receives SIGTERM directly — src/index.ts
# installs the handler that drains in-flight extractions and disconnects Prisma.
CMD ["node", "dist/index.js"]
