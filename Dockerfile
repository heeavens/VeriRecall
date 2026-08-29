FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run check && npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    DATABASE_URL=/app/runtime/recallops.db \
    OPENAI_API_KEY= \
    OPENAI_MODEL=gpt-5.6

COPY --from=build /app /app

RUN mkdir -p /app/runtime && chown -R node:node /app

USER node

EXPOSE 4173

CMD ["sh", "-c", "npm run db:migrate && npm run db:seed && npm run preview -- --host 0.0.0.0 --port 4173"]
