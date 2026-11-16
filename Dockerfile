# CU Alumni Connect: one container with the web front-end, the API,
# real-time chat (Socket.IO) and the SQLite database (stored in /data).
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app

# Install dependencies first so Docker can cache this layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

# /data holds the database and uploads. Locally, docker-compose mounts a
# volume there; on Render, attach a persistent disk with mount path /data.
RUN mkdir -p /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
