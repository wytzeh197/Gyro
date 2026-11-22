# A throwaway Linux server for the runner's SSH test (runner/testdata/e2e.sh).
# No keys are baked in: the test passes its public key in AUTHORIZED_KEY and
# reads the host key back with `docker exec`.
FROM node:24.11.1-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-server git python3 python3-venv ca-certificates curl procps ripgrep \
    && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd
RUN useradd -m -s /bin/bash dev \
    && install -d -o dev -g dev -m 700 /home/dev/.ssh \
    && printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nAllowTcpForwarding no\nX11Forwarding no\nAllowUsers dev\n' > /etc/ssh/sshd_config.d/test.conf \
    && ssh-keygen -A
COPY fake_agent.py /usr/local/bin/fake-agent
RUN chmod 755 /usr/local/bin/fake-agent
EXPOSE 22
CMD ["/bin/sh", "-c", "printf '%s\\n' \"$AUTHORIZED_KEY\" > /home/dev/.ssh/authorized_keys && chown dev:dev /home/dev/.ssh/authorized_keys && chmod 600 /home/dev/.ssh/authorized_keys && exec /usr/sbin/sshd -D -e"]
