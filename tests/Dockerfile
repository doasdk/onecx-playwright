ARG RUNTIME_IMAGE=onecx-playwright:local
FROM ${RUNTIME_IMAGE}

COPY tests/smoke/package.json tests/smoke/package-lock.json ./
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund
COPY tests/smoke/ ./
