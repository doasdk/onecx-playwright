FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS node-runtime

FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f

LABEL org.opencontainers.image.title="OneCX Playwright runtime" \
      org.opencontainers.image.description="Shared browser runtime; application lockfiles own test dependencies and authentication fixtures" \
      org.opencontainers.image.version="0.0.2" \
      org.onecx.playwright.contract="1"

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm

RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && test "$(node --version)" = "v22.22.0" \
    && npm --version

ENV CI=true \
    TEST_ROOT=/app/integration \
    OUTPUT_DIR=/e2e-results \
    ONECX_PLAYWRIGHT_VERSION=1.64.0

WORKDIR /app/integration

COPY runtime/ /opt/onecx-playwright/
RUN sh -n /opt/onecx-playwright/entrypoint.sh \
    && chmod 755 /opt/onecx-playwright/entrypoint.sh

ENTRYPOINT ["/opt/onecx-playwright/entrypoint.sh"]
CMD ["tests:gui"]
