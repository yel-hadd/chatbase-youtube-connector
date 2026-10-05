# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ARG SUPERCRONIC_VERSION=v0.2.33
# SHA1 sums published in the supercronic release notes for this version.
ARG SUPERCRONIC_SHA1_AMD64=71b0d58cc53f6bd72cf2f293e09e294b79c666d8
ARG SUPERCRONIC_SHA1_ARM64=e0f0c06ebc5627e43b25475711e694450489ab00
RUN apk add --no-cache tini curl \
 && case "$(uname -m)" in \
      x86_64) arch=amd64; sum="$SUPERCRONIC_SHA1_AMD64" ;; \
      aarch64) arch=arm64; sum="$SUPERCRONIC_SHA1_ARM64" ;; \
      *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /usr/local/bin/supercronic \
    "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${arch}" \
 && echo "${sum}  /usr/local/bin/supercronic" | sha1sum -c - \
 && chmod +x /usr/local/bin/supercronic \
 && apk del curl
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && mkdir -p /data && chown node:node /data
USER node
WORKDIR /data
ENV NODE_ENV=production
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
# Default: run on SCHEDULE (cron syntax). Pass "--once" to run a single sync and exit.
CMD []
