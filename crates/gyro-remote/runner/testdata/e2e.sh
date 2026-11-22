#!/bin/sh
# Runs the server-run test over real OpenSSH against a throwaway Docker sshd.
# Needs Docker. Uses a fresh key pair and known_hosts in a temp dir, so it
# never reads or writes ~/.ssh. Nothing leaves this machine.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
image=gyro-runner-e2e-sshd
name="gyro-runner-e2e-$$"
work=$(mktemp -d "${TMPDIR:-/tmp}/gyro-e2e.XXXXXX")
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

docker build --quiet -t "$image" -f "$here/sshd.Dockerfile" "$here" >/dev/null
ssh-keygen -q -t ed25519 -N '' -C gyro-e2e -f "$work/id"
docker run -d --rm --name "$name" -p 127.0.0.1::22 \
  -e AUTHORIZED_KEY="$(cat "$work/id.pub")" "$image" >/dev/null
port=$(docker port "$name" 22/tcp | head -n1 | sed 's/.*://')
for _ in 1 2 3 4 5 6 7 8 9 10; do
  docker exec "$name" test -s /home/dev/.ssh/authorized_keys && break
  sleep 0.5
done
printf '[127.0.0.1]:%s %s\n' "$port" "$(docker exec "$name" cat /etc/ssh/ssh_host_ed25519_key.pub | cut -d' ' -f1-2)" > "$work/known_hosts"

GYRO_RUNNER_E2E_HOST=127.0.0.1 \
GYRO_RUNNER_E2E_PORT="$port" \
GYRO_RUNNER_E2E_USER=dev \
GYRO_RUNNER_E2E_IDENTITY="$work/id" \
GYRO_RUNNER_E2E_KNOWN_HOSTS="$work/known_hosts" \
  cargo test --manifest-path "$here/../../Cargo.toml" --lib server_runs::e2e_tests -- --nocapture
