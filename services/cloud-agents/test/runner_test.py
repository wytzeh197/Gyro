import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("runner", Path(__file__).resolve().parents[1] / "runner.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

class RunnerTest(unittest.TestCase):
    def test_cli_arguments_and_api_only_environment(self):
        config = {"provider": "claude", "task": "a; $(touch /tmp/nope)", "model": "model"}
        argv = runner.agent_command(config)
        self.assertEqual(argv[-1], config["task"])
        self.assertIn("--no-session-persistence", argv)
        self.assertNotIn("shell", argv)
        self.assertEqual(runner.env_for("claude")["ANTHROPIC_API_KEY"], "provided-by-worker")
        config["provider"] = "codex"
        self.assertIn("--ephemeral", runner.agent_command(config))
        self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", runner.env_for("claude"))
        self.assertIn("--bounding-set=-all", runner.as_user(["true"]))
        self.assertIn("--no-new-privs", runner.as_user(["true"]))

    def test_logs_redact_known_secret_families(self):
        values = ["sk-" + "a"*30, "github_pat_"+"b"*30, "AKIA"+"A"*16, "Bearer " + "a"*30, '"secret": "private-value"']
        for value in values:
            self.assertNotEqual(runner.redact(value), value)

    def harness(self, root, task_script):
        root = Path(root)
        (root/"boot-id").write_text("test-boot")
        conf = {"repo": str(root / "remote.git"), "branch": "main", "result_branch": "gyro/cloud/test", "provider": "codex", "task": "test", "deadline_epoch": time.time()+30, "idle_seconds": 5}
        processes=[]
        original_popen = subprocess.Popen
        original_git = runner.git
        def popen(*args, **kwargs):
            proc=original_popen(*args, **kwargs)
            processes.append(proc)
            return proc
        def kill():
            for proc in processes:
                if proc.poll() is None:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
        # Only this local test permits file:// Git and bypasses Linux setpriv.
        def local_git(*args):
            return [arg.replace("protocol.file.allow=never", "protocol.file.allow=always") for arg in original_git(*args)]
        environment={"PATH":os.environ["PATH"],"HOME":str(root),"GIT_TERMINAL_PROMPT":"0", "GIT_AUTHOR_NAME":"Test", "GIT_AUTHOR_EMAIL":"test@localhost", "GIT_COMMITTER_NAME":"Test", "GIT_COMMITTER_EMAIL":"test@localhost"}
        return conf, [patch.object(runner,"ROOT",root/"control"), patch.object(runner,"BOOT_ID",root/"boot-id"), patch.object(runner,"REPO",root/"workspace"/"repo"),
            patch.object(runner,"as_user",lambda argv:argv), patch.object(runner,"kill_users",kill),
            patch.object(runner,"env_for",lambda provider=None:environment), patch.object(runner,"git",local_git),
            patch.object(runner,"agent_command",lambda _: [sys.executable,"-c",task_script]),patch.object(subprocess,"Popen",popen)]

    def test_real_git_run_pushes_only_the_generated_branch(self):
        with tempfile.TemporaryDirectory(prefix="gyro-cloud-runner-") as root:
            path=Path(root); (path/"workspace").mkdir()
            def git(*args):
                return subprocess.check_output(["git",*args],stderr=subprocess.DEVNULL,text=True).strip()
            git("init","--bare",str(path/"remote.git")); git("init","-b","main",str(path/"seed"))
            git("-C",str(path/"seed"),"-c","user.name=Test","-c","user.email=test@localhost","commit","--allow-empty","-m","seed")
            git("-C",str(path/"seed"),"push",str(path/"remote.git"),"main")
            before=git("--git-dir",str(path/"remote.git"),"rev-parse","main")
            conf,patches=self.harness(root,"from pathlib import Path; Path('result.txt').write_text('review me'); print('changed')")
            from contextlib import ExitStack
            with ExitStack() as stack:
                for p in patches: stack.enter_context(p)
                # Production cwd is /workspace. Redirect only that fixed path
                # in this local harness; all Git commands still execute.
                original_execute=runner.Runner.execute
                def execute(self,argv,cwd,provider=None):
                    return original_execute(self,argv,str(path/"workspace") if cwd=="/workspace" else cwd,provider)
                stack.enter_context(patch.object(runner.Runner,"execute",execute))
                run=runner.Runner(conf); run.run()
                self.assertEqual(runner.read("status")["status"],"ready_to_push")
                runner.Runner(conf).publish()
                self.assertEqual(runner.read("status")["status"],"done")
            self.assertEqual(git("--git-dir",str(path/"remote.git"),"rev-parse","main"),before)
            self.assertEqual(git("--git-dir",str(path/"remote.git"),"show","gyro/cloud/test:result.txt"),"review me")

    def test_watchdog_stops_a_silent_agent_without_waiting_for_the_mac(self):
        from contextlib import ExitStack
        for mode in ("idle", "cap"):
            with tempfile.TemporaryDirectory(prefix="gyro-cloud-watchdog-") as root:
                conf,patches=self.harness(root,"import time; time.sleep(20)")
                conf["idle_seconds"]=0.3 if mode=="idle" else 30
                conf["deadline_epoch"]=time.time()+(.3 if mode=="cap" else 30)
                with ExitStack() as stack:
                    for p in patches: stack.enter_context(p)
                    worker=runner.Runner(conf)
                    start=time.monotonic()
                    self.assertIsNone(worker.execute([sys.executable,"-c","import time; time.sleep(20)"],root))
                    self.assertLess(time.monotonic()-start,3)
                    self.assertEqual(worker.stop,"waiting" if mode=="idle" else "blocked")

if __name__ == "__main__":
    unittest.main()
