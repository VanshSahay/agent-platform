FROM oven/bun:1.3
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY migrations ./migrations
COPY skills ./skills
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
