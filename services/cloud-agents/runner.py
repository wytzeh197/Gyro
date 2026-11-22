"""Trusted lifecycle wrapper. Agent binaries are installed without modification.

There are no model/Git credentials in this process or filesystem. Outbound
requests are authenticated in the Worker. Never expose this control interface
as a sandbox port. Non-root agent processes have all capabilities dropped.
"""
import json
import os
import re
import selectors
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path("/run/gyro")
REPO = Path("/workspace/repo")
CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt"
BOOT_ID = Path("/proc/sys/kernel/random/boot_id")
TOKEN_PATTERN = re.compile(r"\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[abprs]-[A-Za-z0-9-]{10,}|xai-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b")

def redact(value):
    value = TOKEN_PATTERN.sub("[REDACTED]", value)
    value = re.sub(r'("(?:api[_-]?key|token|secret|password)"\s*:\s*")[^"]+', r'\1[REDACTED]', value, flags=re.I)
    value = re.sub(r"((?:api[_-]?key|token|secret|password)\s*[=:]\s*['\"]?)[^\s,;'\"]+", r"\1[REDACTED]", value, flags=re.I)
    value = re.sub(r"(bearer\s+)[A-Za-z0-9._~+/=-]+", r"\1[REDACTED]", value, flags=re.I)
    value = re.sub(r"(https?://)[^\s/@]+:[^\s/@]+@", r"\1[REDACTED]@", value, flags=re.I)
    return value

def atomic(name, value):
    ROOT.mkdir(parents=True, exist_ok=True)
    temp = ROOT / (name + ".tmp")
    temp.write_text(json.dumps(value))
    os.chmod(temp, 0o600)
    temp.replace(ROOT / name)

def read(name, default=None):
    try:
        return json.loads((ROOT / name).read_text())
    except FileNotFoundError:
        return default

def env_for(provider=None):
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/home/gyro", "LANG": "C.UTF-8",
           "NODE_EXTRA_CA_CERTS": CA, "GIT_SSL_CAINFO": CA, "SSL_CERT_FILE": CA,
           "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
           "GIT_AUTHOR_NAME": "Gyro Cloud prototype", "GIT_AUTHOR_EMAIL": "cloud-prototype@localhost",
           "GIT_COMMITTER_NAME": "Gyro Cloud prototype", "GIT_COMMITTER_EMAIL": "cloud-prototype@localhost"}
    if provider == "claude":
        env.update(ANTHROPIC_API_KEY="provided-by-worker", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1", IS_SANDBOX="1")
    elif provider == "codex":
        env.update(OPENAI_API_KEY="provided-by-worker", CODEX_HOME="/home/gyro/.codex")
    return env

def agent_command(config):
    if config["provider"] == "claude":
        argv = ["claude", "--print", "--verbose", "--output-format", "stream-json", "--no-session-persistence", "--dangerously-skip-permissions"]
        if config.get("model"):
            argv += ["--model", config["model"]]
        return argv + ["--", config["task"]]
    # A custom, API-key-only provider avoids a browser login/auth.json. The
    # env_key value is a placeholder; the Worker supplies the real bearer.
    argv = ["codex", "exec", "--ephemeral", "--json", "--dangerously-bypass-approvals-and-sandbox",
            "--config", 'model_provider="gyro_cloud"',
            "--config", 'model_providers.gyro_cloud.name="Gyro Cloud API"',
            "--config", 'model_providers.gyro_cloud.base_url="https://api.openai.com/v1"',
            "--config", 'model_providers.gyro_cloud.env_key="OPENAI_API_KEY"',
            "--config", 'model_providers.gyro_cloud.wire_api="responses"',
            "--config", 'model_providers.gyro_cloud.requires_openai_auth=false']
    if config.get("model"):
        argv += ["--model", config["model"]]
    return argv + ["--", config["task"]]

def as_user(argv):
    # uid alone does not remove capabilities with Cloudflare's DO scheduling
    # policy. Drop the bounding set and forbid privilege elevation explicitly.
    return ["setpriv", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs",
            "--reuid=1000", "--regid=1000", "--clear-groups", "--"] + argv

def git(*args):
    return ["git", "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never"] + list(args)

def kill_users():
    subprocess.run(["pkill", "-KILL", "-u", "1000"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)

class Runner:
    def __init__(self, config):
        self.config = config
        self.cursor = read("cursor", 0)
        self.last_output = time.monotonic()
        self.deadline = float(config["deadline_epoch"])
        self.stop = None
        signal.signal(signal.SIGUSR1, lambda *_: setattr(self, "stop", "waiting"))
        atomic("pid", {"pid": os.getpid(), "boot": BOOT_ID.read_text().strip()})

    def log(self, text):
        text = redact(text)
        self.cursor += 1
        history = read("logs", [])
        history.append({"id": self.cursor, "at": int(time.time() * 1000), "text": text[:4096]})
        atomic("logs", history[-512:])
        atomic("cursor", self.cursor)

    def state(self, status, reason=None):
        atomic("status", {"status": status, "reason": reason})

    def execute(self, argv, cwd, provider=None):
        self.last_output = time.monotonic()
        # Codex appends piped stdin to its prompt. The agent never gets the
        # runner's config stream.
        proc = subprocess.Popen(as_user(argv), cwd=cwd, env=env_for(provider), stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        selector = selectors.DefaultSelector()
        selector.register(proc.stdout, selectors.EVENT_READ)
        pending = b""
        try:
            while True:
                if time.time() >= self.deadline:
                    self.stop = "blocked"
                elif time.monotonic() - self.last_output >= self.config["idle_seconds"]:
                    self.stop = "waiting"
                if self.stop:
                    kill_users()
                    proc.wait(timeout=5)
                    return None
                events = selector.select(timeout=0.25)
                if events:
                    chunk = os.read(proc.stdout.fileno(), 4096)
                    if not chunk:
                        break
                    self.last_output = time.monotonic()
                    pending += chunk
                    while b"\n" in pending:
                        line, pending = pending.split(b"\n", 1)
                        self.log(line.decode("utf-8", "replace"))
                    # Bound a line before redacting, retaining enough overlap
                    # for known token patterns split between reads.
                    if len(pending) > 16384:
                        self.log("[oversized output line omitted]")
                        pending = b""
                elif proc.poll() is not None:
                    break
            if pending:
                self.log(pending.decode("utf-8", "replace"))
            return proc.wait(timeout=5)
        finally:
            selector.close()
            kill_users()
            proc.stdout.close()

    def run(self):
        try:
            self.state("preparing")
            if not self.config.get("restored"):
                code = self.execute(git("clone", "--single-branch", "--branch", self.config["branch"], "--", self.config["repo"], str(REPO)), "/workspace")
                if code != 0:
                    self.state(self.stop or "failed"); return
                code = self.execute(git("-C", str(REPO), "checkout", "-b", self.config["result_branch"]), "/workspace")
                if code != 0:
                    self.state(self.stop or "failed"); return
            self.state("running")
            code = self.execute(agent_command(self.config), str(REPO), self.config["provider"])
            self.state(self.stop or ("ready_to_push" if code == 0 else "failed"))
        except Exception:
            kill_users()
            self.state("failed", "runner_failed")

    def publish(self):
        try:
            self.state("publishing")
            # The explicit URL and refspec override any agent-modified remote.
            # GitHub's receive-pack request is also checked in the Worker.
            for command in [git("add", "-A"), git("-c", "user.name=Gyro Cloud prototype", "-c", "user.email=cloud-prototype@localhost", "commit", "--allow-empty", "-m", "Gyro Cloud prototype result"),
                            git("push", "--", self.config["repo"], "HEAD:refs/heads/" + self.config["result_branch"])]:
                if self.execute(command, str(REPO)) != 0:
                    self.state(self.stop or "failed", "push_failed"); return
            self.state("done")
        except Exception:
            kill_users()
            self.state("failed", "push_failed")

def quiesce():
    pid = read("pid")
    if pid and pid["boot"] == BOOT_ID.read_text().strip():
        try:
            os.kill(pid["pid"], signal.SIGUSR1)
        except ProcessLookupError:
            pass
    kill_users()
    # Wait for the supervisor to finish writing status/logs before a snapshot.
    for _ in range(40):
        if read("status", {}).get("status") not in ("running", "preparing", "publishing"):
            return
        time.sleep(0.1)
    raise RuntimeError("quiesce timeout")

def main():
    action = sys.argv[1]
    if action in ("run", "publish"):
        config = json.load(sys.stdin)
        Runner(config).run() if action == "run" else Runner(config).publish()
    elif action == "probe":
        after = int(sys.argv[2])
        result = read("status", {"status": "preparing"})
        result.update(events=[e for e in read("logs", []) if e["id"] > after], cursor=read("cursor", 0))
        print(json.dumps(result))
    elif action == "quiesce":
        quiesce()

if __name__ == "__main__":
    main()
