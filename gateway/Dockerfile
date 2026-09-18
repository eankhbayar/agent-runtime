# Egress gateway image. Runs next to the sandboxes on the Docker host; it is the
# only container attached both to sandbox networks and to the internet.
FROM node:24.21.0-bookworm-slim

COPY server.ts /opt/gateway/server.ts
RUN mkdir -p /run/gateway/tokens && chown node:node /run/gateway/tokens && chmod 700 /run/gateway/tokens

USER node
EXPOSE 8080
CMD ["node", "/opt/gateway/server.ts"]
