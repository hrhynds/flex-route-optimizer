# Node 22.5+ is required for the built-in SQLite. Alpine keeps the image small,
# and since the app has no dependencies there is nothing to install.
FROM node:22-alpine

WORKDIR /app

# Source only. The database and photos live on a mounted volume, never in the image.
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY test ./test

# Run as somebody other than root, and let that somebody write to the volume.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    HOST=0.0.0.0 \
    TRUST_PROXY=1

VOLUME ["/data"]
EXPOSE 8080

# Node runs as PID 1. That is fine here: server.js registers its own SIGTERM
# and SIGINT handlers, so a platform stopping the container still gets a clean
# shutdown. Pass --init to docker run if you want an init process as well.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
