FROM node:22-alpine

WORKDIR /app

# mcp-picnic (unofficial Picnic API, MIT) – pinned version
RUN npm init -y >/dev/null \
  && npm install --omit=dev --no-audit --no-fund mcp-picnic@1.16.3 \
  && npm cache clean --force

COPY gateway.mjs /app/gateway.mjs

ENV NODE_ENV=production
CMD ["node", "/app/gateway.mjs"]
