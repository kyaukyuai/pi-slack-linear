FROM node:22-slim

ARG LINEAR_CLI_VERSION=2.9.1
ARG NOTION_CLI_VERSION=0.4.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git gosu jq ripgrep tini xz-utils \
  && update-ca-certificates \
  && npm install -g "@kyaukyuai/linear-cli@${LINEAR_CLI_VERSION}" \
  && npm install -g "ntn@${NOTION_CLI_VERSION}" \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY skills ./skills
COPY README.md ./

RUN npm run build
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV WORKSPACE_DIR=/workspace

VOLUME ["/workspace"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
