# The Cloud Run smoke test's image: this package's built dist/, laid out as a
# project's image lays it out, plus the smoke job and runner. Build from the
# repository root after `pnpm build`; deploy.sh does both.
FROM node:24.21.0-bookworm-slim
COPY package.json /opt/runner/node_modules/@eankhbayar/agent-runtime/package.json
COPY dist /opt/runner/node_modules/@eankhbayar/agent-runtime/dist
COPY smoke/cloud-run/job.mjs smoke/cloud-run/runner.mjs /opt/runner/
WORKDIR /opt/runner
CMD ["node", "/opt/runner/job.mjs"]
