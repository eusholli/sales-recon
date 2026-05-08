FROM ghcr.io/openclaw/openclaw:2026.4.9

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*

USER node
WORKDIR /home/node

# Install bun (required by gbrain — see gbrain/INSTALL_FOR_AGENTS.md).
# We pin via the bun installer rather than the OpenClaw base.
RUN curl -fsSL https://bun.sh/install | bash

ENV PATH="/home/node/.bun/bin:${PATH}"

# Clone gbrain at a pinned commit and link the CLI globally for the node user.
# Per INSTALL_FOR_AGENTS.md, do NOT use `bun install -g github:...` — it skips
# postinstall hooks; use the clone + bun link path instead.
ARG GBRAIN_REF=master
RUN git clone https://github.com/garrytan/gbrain.git /home/node/gbrain \
    && cd /home/node/gbrain \
    && git checkout "${GBRAIN_REF}" \
    && bun install \
    && bun link

# Verify the binary is on PATH at build time.
RUN gbrain --version

USER root
COPY scripts/docker-entrypoint.release.sh /usr/local/bin/sales-recon-entrypoint.sh
RUN chmod +x /usr/local/bin/sales-recon-entrypoint.sh
USER node

WORKDIR /app
ENTRYPOINT ["/usr/local/bin/sales-recon-entrypoint.sh"]
