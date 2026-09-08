FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     python3 ca-certificates git make g++ \
  && npm install -g @apralabs/apra-fleet @anthropic-ai/claude-code \
  && apra-fleet install --skill none \
  && apt-get purge -y --auto-remove make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
  && chmod +x /usr/local/bin/docker-entrypoint.sh

COPY . .

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "mcp/main.mjs"]
