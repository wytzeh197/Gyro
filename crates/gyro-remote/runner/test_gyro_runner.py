"""Tests for gyro_runner.py. Run: python3 -m unittest discover -s crates/gyro-remote/runner -p 'test_*.py'

Each test gets its own HOME, so nothing touches the real ~/.gyro. The agent is
testdata/fake_agent.py, which never makes network calls.
"""
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNNER = HERE / "gyro_runner.py"
FAKE = HERE / "testdata" / "fake_agent.py"
HOSTILE = "fix it; rm -rf ~ $(id) `whoami` 'quote\" \\back\nsecond line {task} --flag"


def pid_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], stdout=subprocess.PIPE).stdout.decode().strip()
    return bool(state) and not state.startswith("Z")


class RunnerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir()
        self.env = dict(os.environ, HOME=str(self.home))
        for key in list(self.env):
            if key.startswith("GIT_"):
                del self.env[key]
        self.started = []

    def tearDown(self):
        for run_id in self.started:
            self.call("stop", run_id)
        self.tmp.cleanup()

    # ---------- helpers ----------

    def call(self, *args, spec=None, expect_ok=None):
        result = subprocess.run([sys.executable, str(RUNNER)] + list(args), env=self.env,
                                input=b"" if spec is None else json.dumps(spec).encode(),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        self.assertEqual(result.stderr.decode(), "", "runner wrote to stderr")
        lines = result.stdout.decode().splitlines()
        self.assertEqual(len(lines), 1, "expected exactly one JSON line, got %r" % result.stdout)
        payload = json.loads(lines[0])
        self.assertEqual(result.returncode, 0 if payload["ok"] else 2)
        if expect_ok is not None:
            self.assertEqual(payload["ok"], expect_ok, payload)
        return payload

    def git(self, *args, cwd):
        return subprocess.run(["git"] + list(args), cwd=str(cwd), env=self.env, check=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.decode().strip()

    def repo(self, project="demo", run_id="r1"):
        """Prepares the bare repo and pushes a base like the app does."""
        prepared = self.call("prepare", spec={"project": project}, expect_ok=True)
        bare = self.home / prepared["remote_path"]
        local = Path(self.tmp.name) / ("local-" + run_id)
        local.mkdir()
        self.git("init", "--quiet", "-b", "main", cwd=local)
        (local / "readme.md").write_text("hello\n")
        self.git("add", "-A", cwd=local)
        self.git("-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "base", cwd=local)
        self.git("push", "--quiet", str(bare), "HEAD:refs/gyro/base/" + run_id, cwd=local)
        return bare, self.git("rev-parse", "HEAD", cwd=local)

    def spec(self, run_id="r1", flags=(), **extra):
        spec = {"id": run_id, "project": "demo", "cli": "fake", "base_ref": "refs/gyro/base/" + run_id,
                "task": "do the thing", "argv": [sys.executable, str(FAKE)] + list(flags) + ["{task}"]}
        spec.update(extra)
        return spec

    def start(self, run_id="r1", flags=(), **extra):
        result = self.call("start", spec=self.spec(run_id, flags, **extra), expect_ok=True)
        self.started.append(run_id)
        return result

    def wait_state(self, run_id, states=("done", "failed", "timeout", "stopped", "lost"), timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status = self.call("show", run_id, expect_ok=True)
            if status["state"] in states:
                return status
            time.sleep(0.1)
        self.fail("run %s never reached %s" % (run_id, states))

    def events(self, run_id):
        path = self.home / ".gyro" / "runs" / run_id / "events.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()]

    def out_lines(self, run_id):
        return [event["line"] for event in self.events(run_id) if event["kind"] == "out"]

    # ---------- doctor, status, prepare ----------

    def test_doctor_reports_server_and_clis(self):
        result = self.call("doctor", spec={"clis": [
            {"id": "py", "binary": Path(sys.executable).name, "version_argv": ["--version"]},
            {"id": "missing", "binary": "gyro-no-such-cli"}]}, expect_ok=True)
        self.assertEqual(result["runner_version"], "1")
        self.assertEqual(len(result["runner_sha256"]), 64)
        self.assertTrue(result["git"].startswith("git version"))
        clis = {cli["id"]: cli for cli in result["clis"]}
        self.assertTrue(clis["py"]["found"])
        self.assertIn("Python", clis["py"]["version"])
        self.assertFalse(clis["missing"]["found"])

    def test_status_returns_only_the_verdict(self):
        talk = [sys.executable, "-c", "print('signed in as secret-person@example.com')"]
        cases = [
            ({"match": "signed in"}, True),
            ({"match": "Not logged in"}, False),
            ({"not_match": "signed in"}, False),
            ({"exit": 0}, True),
            ({"exit": 1}, False),
        ]
        for rule, expected in cases:
            result = self.call("status", spec={"argv": talk, "signed_in": rule}, expect_ok=True)
            self.assertEqual(result["signed_in"], expected, rule)
            self.assertNotIn("secret-person", json.dumps(result))
        failing = [sys.executable, "-c", "import sys; print('Not logged in'); sys.exit(1)"]
        self.assertFalse(self.call("status", spec={"argv": failing}, expect_ok=True)["signed_in"])
        missing = self.call("status", spec={"argv": ["gyro-no-such-cli", "status"]}, expect_ok=True)
        self.assertEqual(missing, {"ok": True, "found": False, "signed_in": None})
        slow = [sys.executable, "-c", "import time; time.sleep(10)"]
        self.assertEqual(self.call("status", spec={"argv": slow, "timeout_seconds": 1})["error"], "timeout")

    def test_prepare_is_idempotent(self):
        first = self.call("prepare", spec={"project": "demo"}, expect_ok=True)
        second = self.call("prepare", spec={"project": "demo"}, expect_ok=True)
        self.assertEqual(first, second)
        self.assertTrue((self.home / ".gyro/repos/demo.git/HEAD").exists())
        self.assertEqual(self.call("prepare", spec={"project": "../evil"})["error"], "invalid_spec")

    # ---------- runs ----------

    def test_run_commits_result_and_keeps_task_intact(self):
        bare, base = self.repo()
        task_file = Path(self.tmp.name) / "task.txt"
        started = self.start(flags=["--task-file", str(task_file), "--edit", "notes.txt", "--lines", "3"], task=HOSTILE)
        self.assertEqual(started["base_commit"], base)
        self.assertEqual(started["result_branch"], "gyro/cloud/r1")
        status = self.wait_state("r1")
        self.assertEqual(status["state"], "done")
        self.assertEqual(status["exit_code"], 0)
        self.assertTrue(status["changed"])
        self.assertEqual(task_file.read_text(), HOSTILE)
        self.assertEqual(self.out_lines("r1"), ["line 0", "line 1", "line 2"])
        self.assertEqual(self.events("r1")[-1]["kind"], "end")
        self.assertEqual(self.git("rev-parse", "gyro/cloud/r1", cwd=bare), status["result_commit"])
        self.assertEqual(self.git("show", "gyro/cloud/r1:notes.txt", cwd=bare), HOSTILE.rstrip("\n"))
        self.assertEqual(self.git("rev-parse", "gyro/cloud/r1^", cwd=bare), base)
        self.assertEqual(self.git("log", "-1", "--format=%an <%ae>", "gyro/cloud/r1", cwd=bare), "Gyro <runner@gyro.invalid>")

    def test_failed_run_without_changes(self):
        bare, base = self.repo()
        self.start(flags=["--exit", "3", "--say", "nope"])
        status = self.wait_state("r1")
        self.assertEqual((status["state"], status["reason"], status["exit_code"]), ("failed", "agent_exit", 3))
        self.assertFalse(status["changed"])
        self.assertEqual(status["result_commit"], base)

    def test_attach_streams_until_end(self):
        self.repo()
        self.start(flags=["--lines", "5", "--interval", "0.1"])
        result = subprocess.run([sys.executable, str(RUNNER), "attach", "r1"], env=self.env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        self.assertEqual(result.returncode, 0)
        events = [json.loads(line) for line in result.stdout.decode().splitlines()]
        self.assertEqual([e["line"] for e in events if e["kind"] == "out"], ["line %d" % n for n in range(5)])
        self.assertEqual(events[-1]["kind"], "end")

    def test_reattach_by_offset_has_no_gaps_or_duplicates(self):
        self.repo()
        self.start(flags=["--lines", "40", "--interval", "0.05"])
        first = subprocess.Popen([sys.executable, str(RUNNER), "attach", "r1"], env=self.env,
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        received = b""
        while received.count(b"\n") < 6:
            received += os.read(first.stdout.fileno(), 200)
        first.kill()  # Like an SSH connection dropping mid-stream.
        first.wait()
        first.stdout.close()
        received = received[:received.rindex(b"\n") + 1]
        rest = subprocess.run([sys.executable, str(RUNNER), "attach", "r1", "--from", str(len(received))],
                              env=self.env, stdout=subprocess.PIPE, timeout=30).stdout
        log = (self.home / ".gyro/runs/r1/events.jsonl").read_bytes()
        self.assertEqual(received + rest, log)
        self.assertEqual(self.out_lines("r1"), ["line %d" % n for n in range(40)])
        self.assertEqual(self.call("attach", "r1", "--from", str(len(log) + 1))["error"], "bad_offset")

    def test_stop_kills_grandchild_and_commits_partial(self):
        bare, _ = self.repo()
        child_file = Path(self.tmp.name) / "child.pid"
        self.start(flags=["--child", str(child_file), "--edit", "half.txt", "--ignore-term", "--sleep", "120"])
        self.wait_state("r1", states=("running",))
        deadline = time.monotonic() + 10
        while not child_file.exists() or not child_file.read_text():
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.05)
        grandchild = int(child_file.read_text())
        status = self.call("stop", "r1", expect_ok=True)
        self.assertEqual((status["state"], status["reason"]), ("stopped", "stop_requested"))
        self.assertTrue(status["changed"])
        self.assertFalse(pid_alive(grandchild))
        self.assertTrue(self.git("log", "-1", "--format=%s", "gyro/cloud/r1", cwd=bare).endswith("(partial)"))
        self.assertEqual(self.call("stop", "r1", expect_ok=True)["state"], "stopped")

    def test_time_limit_and_idle_limit(self):
        self.repo(run_id="r1")
        self.start("r1", flags=["--sleep", "60"], timeout_seconds=1)
        status = self.wait_state("r1")
        self.assertEqual((status["state"], status["reason"]), ("timeout", "time_limit"))
        self.repo(project="demo", run_id="r2")
        self.start("r2", flags=["--sleep", "60"], idle_seconds=1)
        status = self.wait_state("r2")
        self.assertEqual((status["state"], status["reason"]), ("timeout", "no_output"))

    def test_background_child_holding_output_does_not_hang_run(self):
        self.repo()
        began = time.monotonic()
        self.start(flags=["--background", "--say", "bye"])
        self.assertEqual(self.wait_state("r1")["state"], "done")
        self.assertLess(time.monotonic() - began, 15)

    def test_one_run_per_cli_unless_parallel(self):
        self.repo(run_id="r1")
        self.repo(project="demo", run_id="r2")
        self.start("r1", flags=["--sleep", "60"])
        busy = self.call("start", spec=self.spec("r2", ["--sleep", "60"]))
        self.assertEqual(busy["error"], "busy")
        self.assertFalse((self.home / ".gyro/runs/r2").exists())
        self.start("r2", flags=["--sleep", "60"], allow_parallel=True)
        self.call("stop", "r1", expect_ok=True)
        self.repo(project="demo", run_id="r3")
        self.start("r3", flags=["--say", "free again"])
        self.assertEqual(self.wait_state("r3")["state"], "done")

    def test_invalid_specs_create_nothing(self):
        self.repo()
        bad = [
            {"id": "../x"},
            {"id": "-x"},
            {"cli": "Fake"},
            {"task": "nul\x00byte"},
            {"argv": [sys.executable, str(FAKE)]},
            {"argv": [sys.executable, "{task}", "{task}"]},
            {"argv": [sys.executable, "--prompt={task}"]},
            {"argv": ["sh -c", "{task}"]},
            {"env": {"HOME": "/tmp"}},
            {"env": {"LD_PRELOAD": "/x.so"}},
            {"env": {"GIT_DIR": "/x"}},
            {"env": {"lower": "x"}},
            {"env": {"OK": "two\nlines"}},
            {"base_ref": "main"},
            {"base_ref": "refs/heads/main"},
            {"timeout_seconds": 0},
            {"timeout_seconds": True},
            {"git_author": {"name": "x>", "email": "a@b"}},
        ]
        for change in bad:
            result = self.call("start", spec=self.spec(**change))
            self.assertEqual(result["error"], "invalid_spec", change)
        self.assertEqual(self.call("start", spec=self.spec(base_ref="refs/gyro/base/nothere"))["error"], "no_base")
        self.assertEqual(self.call("start", spec=self.spec(project="other"))["error"], "no_repo")
        self.assertEqual(self.call("start", spec=self.spec(argv=["gyro-no-such-cli", "{task}"]))["error"], "cli_not_found")
        self.assertFalse((self.home / ".gyro/runs/r1").exists())
        self.assertEqual(self.call("show", "../etc")["error"], "invalid_args")
        self.assertEqual(self.call("show", "nope")["error"], "no_run")
        self.assertEqual(self.call("frobnicate")["error"], "invalid_args")

    def test_duplicate_run_id_is_refused(self):
        self.repo()
        self.start(flags=["--say", "hi"])
        self.wait_state("r1")
        self.assertEqual(self.call("start", spec=self.spec())["error"], "run_exists")

    def test_dead_supervisor_becomes_lost(self):
        self.repo()
        child_file = Path(self.tmp.name) / "child.pid"
        self.start(flags=["--child", str(child_file), "--sleep", "120"])
        self.wait_state("r1", states=("running",))
        supervisor = json.loads((self.home / ".gyro/runs/r1/pid.json").read_text())["pid"]
        agent = self.call("show", "r1")["agent"]["pid"]
        os.kill(supervisor, signal.SIGKILL)
        status = self.wait_state("r1")
        self.assertEqual((status["state"], status["reason"]), ("lost", "runner_exited"))
        self.assertEqual(self.events("r1")[-1]["state"], "lost")
        deadline = time.monotonic() + 5
        while pid_alive(agent) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertFalse(pid_alive(agent))
        self.assertFalse(pid_alive(int(child_file.read_text())))  # Same process group as the agent.

    def test_list_and_cleanup(self):
        bare, _ = self.repo(run_id="r1")
        self.repo(project="demo", run_id="r2")
        self.start("r1", flags=["--edit", "a.txt"])
        self.wait_state("r1")
        self.start("r2", flags=["--sleep", "60"], allow_parallel=True)
        listed = {run["id"]: run["state"] for run in self.call("list", expect_ok=True)["runs"]}
        self.assertEqual(listed["r1"], "done")
        self.assertIn(listed["r2"], ("starting", "running"))
        self.assertEqual(self.call("cleanup", "r2")["error"], "running")
        self.call("cleanup", "r1", "--keep-branch", expect_ok=True)
        self.assertFalse((self.home / ".gyro/runs/r1").exists())
        self.git("rev-parse", "--verify", "gyro/cloud/r1", cwd=bare)
        self.assertNotIn("refs/gyro/base/r1", self.git("for-each-ref", cwd=bare))
        self.call("stop", "r2", expect_ok=True)
        self.call("cleanup", "r2", expect_ok=True)
        self.assertNotIn("gyro/cloud/r2", self.git("for-each-ref", cwd=bare))
        self.assertEqual(self.git("worktree", "list", "--porcelain", cwd=bare).count("worktree "), 1)

    def test_log_cap_redaction_and_long_lines(self):
        self.repo(run_id="r1")
        secret = "sk-" + "a" * 30
        self.start("r1", flags=["--say", "key " + secret + " token=hunter2", "--big", "70000"])
        self.wait_state("r1")
        lines = self.out_lines("r1")
        self.assertNotIn(secret, lines[0])
        self.assertNotIn("hunter2", lines[0])
        self.assertIn("[REDACTED]", lines[0])
        big = [e for e in self.events("r1") if e["kind"] == "out"][1]
        self.assertTrue(big.get("cut"))
        self.assertEqual(len(big["line"]), 64 * 1024)
        self.repo(project="demo", run_id="r2")
        self.start("r2", flags=["--lines", "2000"], max_log_bytes=4096)
        self.assertEqual(self.wait_state("r2")["state"], "done")
        kinds = [e["kind"] for e in self.events("r2")]
        self.assertEqual(kinds.count("truncated"), 1)
        self.assertEqual(kinds[-1], "end")
        self.assertLess((self.home / ".gyro/runs/r2/events.jsonl").stat().st_size, 4096 + 1024)

    def test_runner_files_are_private(self):
        self.repo()
        self.start(flags=["--say", "hi"])
        self.wait_state("r1")
        run_dir = self.home / ".gyro/runs/r1"
        self.assertEqual(run_dir.stat().st_mode & 0o777, 0o700)
        for name in ("spec.json", "status.json", "events.jsonl", "pid.json", "runner.log"):
            self.assertEqual((run_dir / name).stat().st_mode & 0o777, 0o600, name)

    def test_agent_environment(self):
        self.repo()
        probe = "import json, os; print(json.dumps({k: os.environ.get(k) for k in ('SSH_AUTH_SOCK', 'GIT_TERMINAL_PROMPT', 'MY_FLAG')}))"
        self.env["SSH_AUTH_SOCK"] = "/tmp/agent.sock"
        self.call("start", spec=self.spec(argv=[sys.executable, "-c", probe, "{task}"], env={"MY_FLAG": "on"}), expect_ok=True)
        self.started.append("r1")
        self.wait_state("r1")
        seen = json.loads(self.out_lines("r1")[0])
        self.assertEqual(seen, {"SSH_AUTH_SOCK": None, "GIT_TERMINAL_PROMPT": "0", "MY_FLAG": "on"})


if __name__ == "__main__":
    unittest.main()
