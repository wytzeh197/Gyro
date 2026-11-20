FROM node:24.11.1-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates git python3 ripgrep util-linux procps \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global @anthropic-ai/claude-code@2.1.325 @openai/codex@0.169.0
COPY --from=docker.io/cloudflare/sandbox:1.0.3 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN usermod --login gyro --home /home/gyro --move-home node && groupmod --new-name gyro node \
    && mkdir -p /workspace /run/gyro /opt/gyro && chown gyro:gyro /workspace
COPY runner.py /opt/gyro/runner.py
WORKDIR /workspace
CMD ["sleep", "infinity"]
