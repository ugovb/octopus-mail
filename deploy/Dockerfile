# Octopus Mail — serwer domowy w kontenerze (Synology/QNAP/Unraid, Raspberry Pi z Dockerem, VPS w sieci VPN).
#   docker compose -f deploy/docker-compose.yml up -d --build
#   docker compose -f deploy/docker-compose.yml exec octopus octo server pair
# Kontekst budowania: katalog główny repozytorium.

FROM node:24-bookworm-slim AS build
WORKDIR /src
# the desktop build tools are dev dependencies; the Electron binary itself is not needed here
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npx electron-vite build && node scripts/build-cli.mjs

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production OCTO_HOME=/data OCTO_SECRETS=server
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /src/out/cli ./out/cli
COPY --from=build /src/out/renderer ./out/renderer
RUN printf '#!/bin/sh\nexec node /app/out/cli/octo.js "$@"\n' > /usr/local/bin/octo && chmod 755 /usr/local/bin/octo \
  && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/api/info').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "/app/out/cli/octo.js", "serve", "--port", "8787"]
