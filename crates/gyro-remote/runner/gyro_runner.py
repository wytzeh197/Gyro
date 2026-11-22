#!/usr/bin/env python3
"""Gyro server runner: runs an agent CLI on the user's own server.

The Gyro app uploads this file to ~/.gyro/runner/gyro_runner.py and drives it
over SSH. It uses only the Python standard library (3.8+) and git.

Trust model: the server, the SSH user and the agent CLIs belong to the user.
The agent runs with that user's permissions and its own login. This script
never opens, lists or copies anything in a CLI's config directory
(~/.codex, ~/.claude, ~/.gemini, ~/.config/opencode, ~/.cursor, ~/.kimi).

Verbs. Each one prints exactly one JSON object, except `attach`, which streams.
  doctor            stdin {"clis": [{"id", "binary", "version_argv"}]}
  status            stdin {"argv", "signed_in": {"exit", "match", "not_match"}}
                    returns only found/signed_in, never the command's output
  prepare           stdin {"project"}: creates ~/.gyro/repos/{project}.git
  start             stdin run spec (see validate_start); returns at once
  attach ID --from N
                    streams events.jsonl from byte N until the run ends
  show ID | stop ID | list | cleanup ID [--keep-branch]

The task text arrives on stdin, never on a command line, and fills exactly
one argv element. No command is ever run through a shell.
"""
import fcntl
import hashlib
import json
import os
import platform
import re
import select
import selectors
import shutil
import signal
import subprocess
import sys
import time
import traceback
from pathlib import Path

VERSION = "1"
HOME = Path.home()
GYRO = HOME / ".gyro"
REPOS = GYRO / "repos"
RUNS = GYRO / "runs"
LOCKS = GYRO / "locks"

ACTIVE = ("starting", "running", "committing")
TERMINAL = ("done", "failed", "timeout", "stopped", "lost")

MAX_SPEC_BYTES = 2 * 1024 * 1024
MAX_TASK_CHARS = 256 * 1024
MAX_ARG_CHARS = 32 * 1024
MAX_LINE_CHARS = 64 * 1024
DEFAULT_LOG_BYTES = 64 * 1024 * 1024
KILL_GRACE_SECONDS = 5.0
EXIT_DRAIN_SECONDS = 2.0

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
CLI_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
BASE_REF_RE = re.compile(r"^(?:refs/gyro/base/[A-Za-z0-9][A-Za-z0-9_-]{0,63}|[0-9a-f]{40}|[0-9a-f]{64})$")
BINARY_RE = re.compile(r"^(?:/[^\x00\n]{1,1023}|[A-Za-z0-9._+-]{1,64})$")
ENV_KEY_RE = re.compile(r"^[A-Z_][A-Z0-9_]{0,63}$")
# Variables that change how programs load code, or that the runner owns.
ENV_DENY = ("HOME", "PATH", "SHELL", "USER", "LOGNAME", "BASH_ENV", "ENV", "SHELLOPTS", "PS4",
            "PROMPT_COMMAND", "NODE_OPTIONS", "PYTHONPATH", "PYTHONSTARTUP", "PERL5OPT", "RUBYOPT")
ENV_DENY_PREFIX = ("LD_", "DYLD_", "GIT_", "SSH_")
USER_BIN_DIRS = (".npm-global/bin", ".local/bin", ".bun/bin", ".cargo/bin", ".deno/bin")

TOKEN_PATTERN = re.compile(
    r"\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}"
    r"|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[abprs]-[A-Za-z0-9-]{10,}"
    r"|xai-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b")


class Fail(Exception):
    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code
        self.message = message


def redact(value):
    value = TOKEN_PATTERN.sub("[REDACTED]", value)
    value = re.sub(r'("(?:api[_-]?key|token|secret|password)"\s*:\s*")[^"]+', r"\1[REDACTED]", value, flags=re.I)
    value = re.sub(r"((?:api[_-]?key|token|secret|password)\s*[=:]\s*['\"]?)[^\s,;'\"]+", r"\1[REDACTED]", value, flags=re.I)
    value = re.sub(r"(bearer\s+)[A-Za-z0-9._~+/=-]+", r"\1[REDACTED]", value, flags=re.I)
    value = re.sub(r"(https?://)[^\s/@]+:[^\s/@]+@", r"\1[REDACTED]@", value, flags=re.I)
    return value


def now_ms():
    return int(time.time() * 1000)


# ---------- files ----------

def write_json(path, value):
    temp = path.with_name(path.name + ".tmp")
    fd = os.open(str(temp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(value, handle)
    os.replace(str(temp), str(path))


def read_json(path, default=None):
    try:
        with open(str(path)) as handle:
            return json.load(handle)
    except (FileNotFoundError, ValueError):
        return default


def private_dir(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


# ---------- validation ----------

def read_spec():
    data = sys.stdin.buffer.read(MAX_SPEC_BYTES + 1)
    if len(data) > MAX_SPEC_BYTES:
        raise Fail("invalid_spec", "spec is too large")
    if not data.strip():
        return {}
    try:
        spec = json.loads(data.decode("utf-8"))
    except ValueError:
        raise Fail("invalid_spec", "spec is not valid JSON")
    if not isinstance(spec, dict):
        raise Fail("invalid_spec", "spec must be a JSON object")
    return spec


def name_field(spec, key, pattern=NAME_RE):
    value = spec.get(key)
    if not isinstance(value, str) or not pattern.match(value):
        raise Fail("invalid_spec", "%s is missing or has invalid characters" % key)
    return value


def text_field(value, key, limit, allow_newlines=True):
    if not isinstance(value, str) or "\x00" in value or len(value) > limit:
        raise Fail("invalid_spec", "%s must be text without NUL, at most %d characters" % (key, limit))
    if not allow_newlines and ("\n" in value or "\r" in value):
        raise Fail("invalid_spec", "%s must be a single line" % key)
    return value


def int_field(spec, key, default, low, high):
    value = spec.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise Fail("invalid_spec", "%s must be an integer from %d to %d" % (key, low, high))
    return value


def argv_field(value, key, require_task):
    if not isinstance(value, list) or not 1 <= len(value) <= 256:
        raise Fail("invalid_spec", "%s must be a list of 1 to 256 strings" % key)
    for item in value:
        text_field(item, key, MAX_ARG_CHARS)
    if not BINARY_RE.match(value[0]):
        raise Fail("invalid_spec", "%s[0] must be a command name or absolute path" % key)
    if require_task:
        count = sum(1 for item in value if item == "{task}")
        if count != 1:
            raise Fail("invalid_spec", "%s must contain exactly one \"{task}\" element" % key)
        if any("{task}" in item and item != "{task}" for item in value):
            raise Fail("invalid_spec", "\"{task}\" must be a whole argv element")
    return list(value)


def env_field(value):
    if value is None:
        return {}
    if not isinstance(value, dict) or len(value) > 64:
        raise Fail("invalid_spec", "env must be an object with at most 64 entries")
    for key, item in value.items():
        if not ENV_KEY_RE.match(key) or key in ENV_DENY or key.startswith(ENV_DENY_PREFIX):
            raise Fail("invalid_spec", "env key %s is not allowed" % key[:64])
        text_field(item, "env value", 4096, allow_newlines=False)
    return dict(value)


def author_field(value):
    if value is None:
        return {"name": "Gyro", "email": "runner@gyro.invalid"}
    if not isinstance(value, dict):
        raise Fail("invalid_spec", "git_author must be an object")
    name = text_field(value.get("name"), "git_author.name", 200, allow_newlines=False)
    email = text_field(value.get("email"), "git_author.email", 200, allow_newlines=False)
    if "<" in name + email or ">" in name + email or not name.strip() or "@" not in email:
        raise Fail("invalid_spec", "git_author is not valid")
    return {"name": name, "email": email}


# ---------- environment and processes ----------

def search_path():
    dirs = [str(HOME / item) for item in USER_BIN_DIRS]
    dirs += os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin").split(os.pathsep)
    unique = []
    for item in dirs:
        if item and item not in unique:
            unique.append(item)
    return os.pathsep.join(unique)


def agent_env(extra):
    env = {key: value for key, value in os.environ.items()
           if not key.startswith("SSH_") and not key.startswith("GYRO_RUNNER_")}
    env.update(extra)
    env["PATH"] = search_path()
    env["HOME"] = str(HOME)
    env["GIT_TERMINAL_PROMPT"] = "0"
    env.setdefault("TERM", "dumb")
    return env


def git(*args, **kwargs):
    cwd = kwargs.get("cwd")
    check = kwargs.get("check", True)
    command = ["git", "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=",
               "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never"] + list(args)
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    result = subprocess.run(command, cwd=None if cwd is None else str(cwd), env=env,
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=300)
    if check and result.returncode != 0:
        raise Fail("git_failed", "git %s failed: %s" % (args[0] if args[0] != "-c" else "commit",
                                                         redact(result.stderr.decode("utf-8", "replace").strip())[:400]))
    return result


def boot_id():
    try:
        return Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    except OSError:
        return None


def process_start(pid):
    try:
        stat = Path("/proc/%d/stat" % pid).read_text()
        return stat[stat.rindex(")") + 2:].split()[19]
    except (OSError, ValueError, IndexError):
        return None


def process_identity(pid):
    return {"pid": pid, "boot": boot_id(), "start": process_start(pid)}


def alive(identity):
    if not identity or not isinstance(identity.get("pid"), int):
        return False
    if identity.get("boot") and identity["boot"] != boot_id():
        return False
    try:
        os.kill(identity["pid"], 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    if identity.get("start") and process_start(identity["pid"]) != identity["start"]:
        return False
    if is_zombie(identity["pid"]):
        return False
    return True


def is_zombie(pid):
    try:
        stat = Path("/proc/%d/stat" % pid).read_text()
        return stat[stat.rindex(")") + 2:].split()[0] == "Z"
    except (OSError, ValueError, IndexError):
        pass
    try:
        out = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, timeout=5).stdout.decode().strip()
        return out.startswith("Z")
    except (OSError, subprocess.SubprocessError):
        return False


def parent_map():
    parents = {}
    proc = Path("/proc")
    if (proc / "self" / "stat").exists():
        for entry in proc.iterdir():
            if not entry.name.isdigit():
                continue
            try:
                stat = (entry / "stat").read_text()
                parents[int(entry.name)] = int(stat[stat.rindex(")") + 2:].split()[1])
            except (OSError, ValueError, IndexError):
                continue
        return parents
    try:
        out = subprocess.run(["ps", "-A", "-o", "pid=", "-o", "ppid="], stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, timeout=10).stdout.decode()
    except (OSError, subprocess.SubprocessError):
        return parents
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            parents[int(parts[0])] = int(parts[1])
    return parents


def descendants(root):
    parents = parent_map()
    found, frontier = set(), {root}
    while frontier:
        children = {pid for pid, parent in parents.items() if parent in frontier and pid not in found}
        found |= children
        frontier = children
    return found


def kill_tree(proc, grace=KILL_GRACE_SECONDS):
    """Stops the agent, its process group and every descendant we can find."""
    pid = proc.pid
    known = descendants(pid)
    for sig in (signal.SIGTERM, signal.SIGKILL):
        known |= descendants(pid)
        try:
            os.killpg(pid, sig)
        except (ProcessLookupError, PermissionError):
            pass
        for child in list(known):
            try:
                os.kill(child, sig)
            except (ProcessLookupError, PermissionError):
                known.discard(child)
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline:
            if proc.poll() is not None and not any(alive({"pid": child}) for child in known):
                return
            time.sleep(0.05)


# ---------- verbs ----------

def cmd_doctor(spec):
    env = agent_env({})
    clis = []
    entries = spec.get("clis") or []
    if not isinstance(entries, list) or len(entries) > 64:
        raise Fail("invalid_spec", "clis must be a list of at most 64 entries")
    for entry in entries:
        if not isinstance(entry, dict):
            raise Fail("invalid_spec", "each cli must be an object")
        cli_id = name_field(entry, "id", CLI_RE)
        binary = entry.get("binary")
        if not isinstance(binary, str) or not BINARY_RE.match(binary):
            raise Fail("invalid_spec", "binary for %s is not valid" % cli_id)
        path = shutil.which(binary, path=env["PATH"])
        version = None
        if path and entry.get("version_argv") is not None:
            version_argv = entry["version_argv"]
            if not isinstance(version_argv, list) or len(version_argv) > 8:
                raise Fail("invalid_spec", "version_argv for %s is not valid" % cli_id)
            for item in version_argv:
                text_field(item, "version_argv", 64, allow_newlines=False)
            version = first_line([path] + version_argv, env, 15)
        clis.append({"id": cli_id, "found": bool(path), "path": path, "version": version})
    npm = shutil.which("npm", path=env["PATH"])
    prefix = os.environ.get("NPM_CONFIG_PREFIX") or str(HOME / ".npm-global")
    usage = shutil.disk_usage(str(HOME))
    return {
        "runner_version": VERSION,
        "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "os": platform.system(),
        "distro": os_release(),
        "arch": platform.machine(),
        "python": platform.python_version(),
        "git": first_line(["git", "--version"], env, 10),
        "home_free_bytes": usage.free,
        "npm": {"found": bool(npm), "user_prefix": prefix,
                "user_prefix_writable": os.access(prefix, os.W_OK) or (not os.path.exists(prefix) and os.access(str(HOME), os.W_OK))},
        "clis": clis,
    }


def os_release():
    try:
        for line in Path("/etc/os-release").read_text().splitlines():
            if line.startswith("PRETTY_NAME="):
                return line.split("=", 1)[1].strip().strip('"')[:120]
    except OSError:
        pass
    return None


def first_line(argv, env, timeout):
    try:
        result = subprocess.run(argv, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None
    for line in result.stdout.decode("utf-8", "replace").splitlines():
        if line.strip():
            return redact(line.strip())[:200]
    return None


def cmd_status(spec):
    argv = argv_field(spec.get("argv"), "argv", require_task=False)
    rule = spec.get("signed_in") or {}
    if not isinstance(rule, dict):
        raise Fail("invalid_spec", "signed_in must be an object")
    expected_exit = rule.get("exit", 0 if not (rule.get("match") or rule.get("not_match")) else None)
    if expected_exit is not None and (isinstance(expected_exit, bool) or not isinstance(expected_exit, int)):
        raise Fail("invalid_spec", "signed_in.exit must be an integer")
    patterns = {}
    for key in ("match", "not_match"):
        if rule.get(key) is not None:
            try:
                patterns[key] = re.compile(text_field(rule[key], "signed_in." + key, 500))
            except re.error:
                raise Fail("invalid_spec", "signed_in.%s is not a valid pattern" % key)
    timeout = int_field(spec, "timeout_seconds", 20, 1, 120)
    env = agent_env({})
    path = shutil.which(argv[0], path=env["PATH"])
    if not path:
        return {"found": False, "signed_in": None}
    try:
        result = subprocess.run([path] + argv[1:], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=timeout, start_new_session=True)
    except subprocess.TimeoutExpired:
        return {"found": True, "signed_in": None, "error": "timeout"}
    except OSError:
        return {"found": False, "signed_in": None}
    # The output can contain account names or emails. Only the verdict leaves.
    output = result.stdout.decode("utf-8", "replace")
    signed_in = True
    if expected_exit is not None and result.returncode != expected_exit:
        signed_in = False
    if "match" in patterns and not patterns["match"].search(output):
        signed_in = False
    if "not_match" in patterns and patterns["not_match"].search(output):
        signed_in = False
    return {"found": True, "signed_in": signed_in}


def cmd_prepare(spec):
    project = name_field(spec, "project")
    repo = REPOS / (project + ".git")
    if not (repo / "HEAD").exists():
        private_dir(REPOS)
        git("init", "--quiet", "--bare", "--", str(repo))
    return {"project": project, "remote_path": ".gyro/repos/%s.git" % project}


def validate_start(spec):
    run = {
        "id": name_field(spec, "id"),
        "project": name_field(spec, "project"),
        "cli": name_field(spec, "cli", CLI_RE),
        "task": text_field(spec.get("task"), "task", MAX_TASK_CHARS),
        "argv": argv_field(spec.get("argv"), "argv", require_task=True),
        "env": env_field(spec.get("env")),
        "timeout_seconds": int_field(spec, "timeout_seconds", 3600, 1, 86400),
        "idle_seconds": int_field(spec, "idle_seconds", 0, 0, 86400),
        "max_log_bytes": int_field(spec, "max_log_bytes", DEFAULT_LOG_BYTES, 4096, 1024 * 1024 * 1024),
        "allow_parallel": spec.get("allow_parallel", False) is True,
        "git_author": author_field(spec.get("git_author")),
    }
    base_ref = spec.get("base_ref")
    if not isinstance(base_ref, str) or not BASE_REF_RE.match(base_ref):
        raise Fail("invalid_spec", "base_ref must be refs/gyro/base/<id> or a commit id")
    run["base_ref"] = base_ref
    message = spec.get("commit_message")
    if message is None:
        first = run["task"].strip().splitlines()[0] if run["task"].strip() else "agent run"
        message = "Gyro: " + (first[:66] + "…" if len(first) > 67 else first)
    run["commit_message"] = text_field(message, "commit_message", 4000)
    return run


def cmd_start(spec):
    run = validate_start(spec)
    repo = REPOS / (run["project"] + ".git")
    if not (repo / "HEAD").exists():
        raise Fail("no_repo", "project repo does not exist; run prepare and push the base first")
    run_dir = RUNS / run["id"]
    if run_dir.exists():
        raise Fail("run_exists", "a run with this id already exists")
    env = agent_env(run["env"])
    if not shutil.which(run["argv"][0], path=env["PATH"]):
        raise Fail("cli_not_found", "%s is not installed or not on PATH" % run["argv"][0][:64])
    base = git("rev-parse", "--verify", "--quiet", "--end-of-options", run["base_ref"] + "^{commit}", cwd=repo, check=False)
    if base.returncode != 0:
        raise Fail("no_base", "base_ref was not pushed to the server")
    base_commit = base.stdout.decode().strip()

    lock_fd = None
    if not run["allow_parallel"]:
        private_dir(LOCKS)
        lock_fd = os.open(str(LOCKS / (run["cli"] + ".lock")), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(lock_fd)
            raise Fail("busy", "another %s run is still active on this server" % run["cli"])

    branch = "gyro/cloud/" + run["id"]
    private_dir(RUNS)
    run_dir.mkdir(mode=0o700)
    try:
        git("worktree", "add", "--quiet", "-b", branch, "--", str(run_dir / "work"), base_commit, cwd=repo)
        write_json(run_dir / "spec.json", run)
        status = {"id": run["id"], "project": run["project"], "cli": run["cli"], "state": "starting",
                  "created_at": now_ms(), "updated_at": now_ms(), "base_commit": base_commit,
                  "result_branch": branch, "exit_code": None, "result_commit": None, "changed": None,
                  "reason": None}
        write_json(run_dir / "status.json", status)
        os.close(os.open(str(run_dir / "events.jsonl"), os.O_WRONLY | os.O_CREAT, 0o600))
        log_fd = os.open(str(run_dir / "runner.log"), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            proc = subprocess.Popen(
                [sys.executable, os.path.abspath(__file__), "_supervise", run["id"]],
                cwd=str(run_dir), stdin=subprocess.DEVNULL, stdout=log_fd, stderr=log_fd,
                start_new_session=True, close_fds=True,
                pass_fds=(lock_fd,) if lock_fd is not None else ())
        finally:
            os.close(log_fd)
        write_json(run_dir / "pid.json", process_identity(proc.pid))
    except Exception:
        remove_run(run_dir, repo, run["id"], keep_branch=False)
        raise
    finally:
        if lock_fd is not None:
            os.close(lock_fd)  # The supervisor holds its own copy of the lock.
    return {"id": run["id"], "pid": proc.pid, "base_commit": base_commit, "result_branch": branch}


class Supervisor(object):
    def __init__(self, run_id):
        self.dir = RUNS / run_id
        self.run = read_json(self.dir / "spec.json")
        self.status = read_json(self.dir / "status.json")
        if not self.run or not self.status:
            raise Fail("no_run", "run files are missing")
        fd = os.open(str(self.dir / "events.jsonl"), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        self.events = os.fdopen(fd, "ab", buffering=0)
        self.written = os.path.getsize(str(self.dir / "events.jsonl"))
        self.truncated = False
        self.stop_reason = None
        signal.signal(signal.SIGTERM, lambda *_: self.request_stop("stopped", "stop_requested"))
        signal.signal(signal.SIGINT, lambda *_: self.request_stop("stopped", "stop_requested"))
        signal.signal(signal.SIGHUP, signal.SIG_IGN)

    def request_stop(self, state, reason):
        if not self.stop_reason:
            self.stop_reason = (state, reason)

    def emit(self, kind, **fields):
        record = {"t": now_ms(), "kind": kind}
        record.update(fields)
        data = (json.dumps(record, ensure_ascii=False) + "\n").encode("utf-8")
        if kind == "out":
            if self.truncated:
                return
            if self.written + len(data) > self.run["max_log_bytes"]:
                self.truncated = True
                data = (json.dumps({"t": now_ms(), "kind": "truncated"}) + "\n").encode("utf-8")
        self.events.write(data)
        self.written += len(data)

    def out_line(self, raw, cut=False):
        line = raw.decode("utf-8", "replace").rstrip("\r")
        if len(line) > MAX_LINE_CHARS:
            line, cut = line[:MAX_LINE_CHARS], True
        fields = {"line": redact(line)}
        if cut:
            fields["cut"] = True
        self.emit("out", **fields)

    def set_state(self, state, **fields):
        self.status.update(fields)
        self.status["state"] = state
        self.status["updated_at"] = now_ms()
        write_json(self.dir / "status.json", self.status)
        self.emit("state", state=state)

    def execute(self):
        run = self.run
        argv = [run["task"] if item == "{task}" else item for item in run["argv"]]
        env = agent_env(run["env"])
        argv[0] = shutil.which(argv[0], path=env["PATH"]) or argv[0]
        try:
            proc = subprocess.Popen(argv, cwd=str(self.dir / "work"), env=env, stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    start_new_session=True, close_fds=True)
        except OSError as error:
            self.emit("out", line="could not start %s: %s" % (run["argv"][0], error.strerror))
            return None
        self.set_state("running", agent=process_identity(proc.pid), started_at=now_ms())
        deadline = time.monotonic() + run["timeout_seconds"]
        last_output = time.monotonic()
        exited_at = None
        pending = b""
        skipping = False
        selector = selectors.DefaultSelector()
        selector.register(proc.stdout, selectors.EVENT_READ)
        try:
            while True:
                if not self.stop_reason and time.monotonic() >= deadline:
                    self.request_stop("timeout", "time_limit")
                if not self.stop_reason and run["idle_seconds"] and time.monotonic() - last_output >= run["idle_seconds"]:
                    self.request_stop("timeout", "no_output")
                if self.stop_reason:
                    kill_tree(proc)
                    break
                if selector.select(timeout=0.25):
                    chunk = os.read(proc.stdout.fileno(), 65536)
                    if not chunk:
                        break
                    last_output = time.monotonic()
                    pending += chunk
                    while b"\n" in pending:
                        line, pending = pending.split(b"\n", 1)
                        if skipping:
                            skipping = False
                        else:
                            self.out_line(line)
                    if len(pending) > MAX_LINE_CHARS * 4:
                        if not skipping:
                            self.out_line(pending, cut=True)
                        pending, skipping = b"", True
                if proc.poll() is not None:
                    # A background child may still hold the pipe open.
                    exited_at = exited_at or time.monotonic()
                    if time.monotonic() - exited_at >= EXIT_DRAIN_SECONDS:
                        break
            if pending and not skipping:
                self.out_line(pending)
        finally:
            selector.close()
            kill_tree(proc, grace=1.0)  # Leftover background processes from the agent.
            proc.stdout.close()
        return proc.wait()

    def commit(self, partial):
        work = self.dir / "work"
        author = self.run["git_author"]
        git("add", "-A", cwd=work)
        if git("diff", "--cached", "--quiet", cwd=work, check=False).returncode == 1:
            message = self.run["commit_message"] + (" (partial)" if partial else "")
            git("-c", "user.name=" + author["name"], "-c", "user.email=" + author["email"],
                "commit", "--quiet", "--no-verify", "--no-gpg-sign", "-m", message, cwd=work)
        head = git("rev-parse", "--verify", "HEAD^{commit}", cwd=work).stdout.decode().strip()
        git("update-ref", "refs/heads/" + self.status["result_branch"], head, cwd=work)
        return head

    def finish(self, state, reason, exit_code, result_commit):
        self.status.update(state=state, reason=reason, exit_code=exit_code, result_commit=result_commit,
                           changed=None if result_commit is None else result_commit != self.status["base_commit"],
                           ended_at=now_ms(), updated_at=now_ms())
        # The end event goes first: once status.json is terminal, attach has everything.
        self.emit("end", state=state, reason=reason, exit_code=exit_code, result_commit=result_commit,
                  changed=self.status["changed"])
        write_json(self.dir / "status.json", self.status)

    def main(self):
        exit_code = None
        try:
            exit_code = self.execute()
            if exit_code is None:
                self.finish("failed", "spawn_failed", None, None)
                return
            if self.stop_reason:
                state, reason = self.stop_reason
            else:
                state, reason = ("done", None) if exit_code == 0 else ("failed", "agent_exit")
            self.set_state("committing")
            result = self.commit(partial=state != "done")
            self.finish(state, reason, exit_code, result)
        except Exception:
            traceback.print_exc()
            self.finish("failed", "runner_error", exit_code, None)


def status_of(run_id):
    run_dir = RUNS / run_id
    status = read_json(run_dir / "status.json")
    if status is None:
        raise Fail("no_run", "run not found")
    if status["state"] in ACTIVE and not alive(read_json(run_dir / "pid.json")):
        events = os.open(str(run_dir / "events.jsonl"), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            fcntl.flock(events, fcntl.LOCK_EX)
            status = read_json(run_dir / "status.json")
            if status["state"] in ACTIVE:
                agent = status.get("agent")
                if agent and alive(agent):
                    try:
                        os.killpg(agent["pid"], signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        pass
                status.update(state="lost", reason="runner_exited", ended_at=now_ms(), updated_at=now_ms())
                line = json.dumps({"t": now_ms(), "kind": "end", "state": "lost", "reason": "runner_exited",
                                   "exit_code": None, "result_commit": None, "changed": None}) + "\n"
                os.write(events, line.encode("utf-8"))
                write_json(run_dir / "status.json", status)
        finally:
            os.close(events)
    return status


def reader_gone(fd):
    """True when nobody reads our stdout any more (the SSH channel closed)."""
    try:
        poller = select.poll()
        poller.register(fd, 0)  # POLLERR and POLLHUP are always reported.
        return any(mask & (select.POLLERR | select.POLLHUP | select.POLLNVAL) for _, mask in poller.poll(0))
    except (AttributeError, OSError, ValueError):
        return False


def cmd_attach(run_id, offset):
    path = RUNS / run_id / "events.jsonl"
    status_of(run_id)
    size = os.path.getsize(str(path))
    if offset < 0 or offset > size:
        raise Fail("bad_offset", "offset is past the end of the event log")
    out = sys.stdout.buffer
    checked = 0.0
    with open(str(path), "rb") as events:
        events.seek(offset)
        while True:
            chunk = events.read(65536)
            if chunk:
                out.write(chunk)
                out.flush()
                continue
            if time.monotonic() - checked >= 0.5:
                checked = time.monotonic()
                if reader_gone(out.fileno()):
                    return 0  # SSH went away; the run carries on without us.
                if status_of(run_id)["state"] in TERMINAL:
                    rest = events.read()
                    if rest:
                        out.write(rest)
                        out.flush()
                    return 0
            time.sleep(0.1)


def cmd_stop(run_id):
    status = status_of(run_id)
    if status["state"] in TERMINAL:
        return status
    supervisor = read_json(RUNS / run_id / "pid.json")
    if alive(supervisor):
        try:
            os.kill(supervisor["pid"], signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + KILL_GRACE_SECONDS * 3
    while time.monotonic() < deadline:
        status = status_of(run_id)
        if status["state"] in TERMINAL:
            return status
        time.sleep(0.1)
    if alive(supervisor):
        os.kill(supervisor["pid"], signal.SIGKILL)
        time.sleep(0.2)
    return status_of(run_id)


def cmd_list():
    runs = []
    if RUNS.exists():
        for entry in RUNS.iterdir():
            if entry.is_dir() and NAME_RE.match(entry.name) and (entry / "status.json").exists():
                status = status_of(entry.name)
                runs.append({key: status.get(key) for key in
                             ("id", "project", "cli", "state", "reason", "created_at", "ended_at",
                              "exit_code", "result_branch", "changed")})
    runs.sort(key=lambda item: item.get("created_at") or 0)
    return {"runs": runs}


def remove_run(run_dir, repo, run_id, keep_branch):
    if (repo / "HEAD").exists():
        git("worktree", "remove", "--force", "--", str(run_dir / "work"), cwd=repo, check=False)
        git("worktree", "prune", cwd=repo, check=False)
        git("update-ref", "-d", "refs/gyro/base/" + run_id, cwd=repo, check=False)
        if not keep_branch:
            git("update-ref", "-d", "refs/heads/gyro/cloud/" + run_id, cwd=repo, check=False)
    shutil.rmtree(str(run_dir), ignore_errors=True)


def cmd_cleanup(run_id, keep_branch):
    status = status_of(run_id)
    if status["state"] in ACTIVE:
        raise Fail("running", "stop the run before cleaning it up")
    remove_run(RUNS / run_id, REPOS / (status["project"] + ".git"), run_id, keep_branch)
    return {"id": run_id, "removed": True, "kept_branch": keep_branch}


# ---------- entry point ----------

def run_id_arg(args, index):
    if len(args) <= index or not NAME_RE.match(args[index]):
        raise Fail("invalid_args", "a valid run id is required")
    return args[index]


def main(args):
    if len(args) < 2:
        raise Fail("invalid_args", "usage: gyro_runner.py <verb> [...]")
    verb = args[1]
    if verb == "_supervise":
        Supervisor(run_id_arg(args, 2)).main()
        return None
    if verb == "attach":
        run_id = run_id_arg(args, 2)
        offset = 0
        if len(args) >= 5 and args[3] == "--from" and args[4].isdigit():
            offset = int(args[4])
        elif len(args) != 3:
            raise Fail("invalid_args", "usage: attach <id> [--from <byte offset>]")
        cmd_attach(run_id, offset)
        return None
    if verb == "doctor":
        return cmd_doctor(read_spec())
    if verb == "status":
        return cmd_status(read_spec())
    if verb == "prepare":
        return cmd_prepare(read_spec())
    if verb == "start":
        return cmd_start(read_spec())
    if verb == "show":
        return status_of(run_id_arg(args, 2))
    if verb == "stop":
        return cmd_stop(run_id_arg(args, 2))
    if verb == "list":
        return cmd_list()
    if verb == "cleanup":
        return cmd_cleanup(run_id_arg(args, 2), "--keep-branch" in args[3:])
    raise Fail("invalid_args", "unknown verb")


def entry():
    try:
        result = main(sys.argv)
    except Fail as error:
        sys.stdout.write(json.dumps({"ok": False, "error": error.code, "message": error.message}) + "\n")
        return 2
    except BrokenPipeError:
        # Keep Python from complaining when it flushes stdout on the way out.
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        return 0
    except Exception as error:
        traceback.print_exc()
        sys.stdout.write(json.dumps({"ok": False, "error": "internal", "message": type(error).__name__}) + "\n")
        return 3
    if result is not None:
        payload = {"ok": True}
        payload.update(result)
        sys.stdout.write(json.dumps(payload) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(entry())
