# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# whisper.cpp, built from source: local speech recognition that needs no account. GGML_NATIVE=OFF keeps the
# binary portable across CPUs (it is built once and may run on a different machine than it was built on).
FROM debian:bookworm-slim AS whisper
ARG WHISPER_TAG=v1.9.5
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${WHISPER_TAG} https://github.com/ggml-org/whisper.cpp /src
WORKDIR /src
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DWHISPER_BUILD_TESTS=OFF \
 && cmake --build build -j"$(nproc)" --target whisper-cli

# One image runs both the API and the worker (different command). FFmpeg is for the worker.
FROM base AS runtime
ENV NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates libgomp1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=whisper /src/build/bin/whisper-cli /usr/local/bin/whisper-cli
# Speech models live on a volume (so they are downloaded once). The directory must belong to the app user.
RUN mkdir -p /models && chown node:node /models
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY drizzle ./drizzle
USER node
EXPOSE 4000 4001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
