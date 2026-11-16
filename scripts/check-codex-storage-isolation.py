#!/usr/bin/env python3
"""Exercise real Gyro + Codex processes against a local, free SSE fixture."""
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading


requests = []


class Model(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        requests.append(self.rfile.read(int(self.headers["Content-Length"])))
        message = {"type": "message", "id": "msg_fixture", "role": "assistant",
                   "content": [{"type": "output_text", "text": "Storage is isolated.", "annotations": []}]}
        events = [
            {"type": "response.created", "response": {"id": "resp_fixture"}},
            {"type": "response.output_item.done", "output_index": 0, "item": message},
            {"type": "response.completed", "response": {"id": "resp_fixture", "status": "completed",
                "output": [message], "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}},
        ]
        body = "".join("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n" for event in events).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    repo = Path(__file__).resolve().parent.parent
    gyro = Path(os.environ.get("GYRO_SMOKE_BINARY", repo / "target/debug/gyro"))
    codex = shutil.which("codex")
    assert codex and gyro.is_file(), "Build gyro-cli and install Codex before running this check"
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="gyro-codex-native-isolation-") as folder:
            root = Path(folder)
            home, shared, data, workspace = [root / name for name in ["home", "shared", "data", "workspace"]]
            for directory in [home, shared, data, workspace]:
                directory.mkdir()
            (shared / "config.toml").write_text(
                'check_for_update_on_startup=false\nweb_search="disabled"\n'
                f'openai_base_url="http://127.0.0.1:{server.server_port}/v1"\n')
            (shared / "auth.json").write_text(json.dumps({"OPENAI_API_KEY": "sk-local-fixture-not-a-real-key"}))
            (data / "config.json").write_text(json.dumps({
                "telemetryEnabled": False, "requireCommandApproval": False, "requireFileEditApproval": False,
                "modelProviders": [{"id": "openai", "displayName": "Codex", "apiKeyRef": "provider:openai", "enabled": True}],
                "commandProfiles": [{"id": "codex-test", "displayName": "Codex test", "command": codex,
                    "args": [], "providerId": "openai", "defaultModel": "gpt-6.1-sol", "readiness": "ready"}],
            }))
            env = {**os.environ, "HOME": str(home), "CODEX_HOME": str(shared),
                   "CODEX_SQLITE_HOME": str(shared), "GYRO_TEST_DATA_DIR": str(data), "GYRO_TEST_EMPTY_KEYCHAIN": "1"}
            for name in ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL"]:
                env.pop(name, None)
            def run(args):
                result = subprocess.run([str(gyro), *args, "--profile", "codex-test", "--no-open", "--json"],
                    env=env, cwd=workspace, text=True, capture_output=True, timeout=45)
                assert result.returncode == 0, result.stderr
                return json.loads(result.stdout)
            first = run(["run", "Check storage isolation"])
            session = first["sessionId"]
            second = run(["resume", session, "--message", "Continue the same thread"])
            assert first["run"]["resumed"] is False
            assert second["run"]["resumed"] is True
            assert second["run"]["response"] == "Storage is isolated."
            homes = list((data / "providers/codex").iterdir())
            assert len(homes) == 1
            private = homes[0]
            assert list((private / "sessions").rglob("*.jsonl"))
            assert list(private.glob("state_*.sqlite"))
            assert not list(shared.glob("*.sqlite"))
            assert not (shared / "sessions").exists()
            assert len(requests) == 2
            # The second native request contains the first answer: this really
            # resumed Codex's own context, rather than just a UI cursor.
            assert b"Storage is isolated." in requests[1]
            print("PASS: real Codex completed two local fixture turns; private storage and native resume verified")
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
