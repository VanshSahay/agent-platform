# Circle in one container: one always-on Bun process, SQLite on a mounted volume at /data (Fly.io: see fly.toml).
FROM oven/bun:1.4
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY web ./web
COPY skills ./skills
COPY tsconfig.json ./
ENV NODE_ENV=production
ENV DB_PATH=/data/circle.sqlite
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "run", "src/main.ts"]
