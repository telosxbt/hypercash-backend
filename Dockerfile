FROM oven/bun:1.3

WORKDIR /app

# Install deps first for layer caching
COPY package.json ./
COPY bun.lock* ./
RUN bun install

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
