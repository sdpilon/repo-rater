FROM ghcr.io/pnpm/pnpm:11 AS base
RUN pnpm runtime set node 22 -g \
    && pnpm config set store-dir /pnpm-store --global
COPY . /app
WORKDIR /app

FROM base AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm-store pnpm install --frozen-lockfile
RUN pnpm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/.output /app/.output
COPY --from=build /app/drizzle /app/drizzle
ENV PORT=8372
EXPOSE 8372
CMD [ "node", ".output/server/index.mjs" ]
