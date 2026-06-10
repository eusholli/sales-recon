FROM ghcr.io/openclaw/openclaw:2026.5.22

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl unzip trash-cli \
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
# Pin to a known-good commit (v0.42.37.0). Floating `master` was both
# non-reproducible and frozen by Docker layer cache. Bump this SHA deliberately
# to update gbrain. v0.42.37 adds job-layer lock reaping + cooperative-abort,
# resumable sync (v115), and open-provenance custom-source typed edges (v114).
ARG GBRAIN_REF=03ffc6ebdbc7dd8b29e5bfd0c3a9a6c983b54f01
RUN git clone https://github.com/garrytan/gbrain.git /home/node/gbrain \
    && cd /home/node/gbrain \
    && git checkout "${GBRAIN_REF}" \
    && bun install \
    && bun link

# Verify the binary is on PATH at build time.
RUN gbrain --version

USER node
# Install the Brave web-search plugin (moved out of core in 5.x).
# Installing at build time bakes it into the image so every container start
# has it available without depending on the config volume state.
RUN node /app/dist/index.js plugins install @openclaw/brave-plugin

USER root
COPY scripts/docker-entrypoint.release.sh /usr/local/bin/sales-recon-entrypoint.sh
RUN chmod +x /usr/local/bin/sales-recon-entrypoint.sh
# Dispatcher + prompt assets used by the autonomous intel cron job. Copied
# into the image (not volume-mounted) so a deploy ships the dispatcher and
# its prompts atomically.
COPY intel-dispatcher.py /app/intel-dispatcher.py
COPY marketing-once.py /app/marketing-once.py
COPY marketing-runner.py /app/marketing-runner.py
COPY prompts /app/prompts
RUN chmod +x /app/intel-dispatcher.py /app/marketing-once.py /app/marketing-runner.py
USER node

WORKDIR /app
ENTRYPOINT ["/usr/local/bin/sales-recon-entrypoint.sh"]
