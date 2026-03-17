FROM node:22-slim

ARG LINEAR_CLI_VERSION=2.4.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git jq ripgrep tini xz-utils \
  && update-ca-certificates \
  && npm install -g "@kyaukyuai/linear-cli@${LINEAR_CLI_VERSION}" \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY skills ./skills
COPY README.md ./

RUN npm run build

ENV NODE_ENV=production
ENV WORKSPACE_DIR=/workspace

VOLUME ["/workspace"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
