FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
RUN npm ci --omit=dev

COPY apps/api apps/api
COPY packages/core packages/core
COPY config config

RUN mkdir -p /app/playwright-data && chown -R pwuser:pwuser /app
USER pwuser

EXPOSE 8787
CMD ["xvfb-run", "-a", "npm", "run", "start"]
