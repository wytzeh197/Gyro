"""Bounded DeepSeek probes using production-shaped synthetic history.

Requires a fixture emitted by the Rust efficiency_quality_fixture example.
No calls without --live. No SDK retries. Does not represent full-app acceptance.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--fixture", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--max-cost-usd", type=float, default=0)
parser.add_argument("--spent-before-usd", type=float, default=0)
parser.add_argument("--task-id", choices=["gyro-retry-terminal-guards", "gyro-usage-confidence"], default="gyro-retry-terminal-guards")
parser.add_argument("--cases", nargs="+", choices=["historical-evidence", "checkpoint", "coding"], default=["historical-evidence", "checkpoint", "coding"])
parser.add_argument("--trials", type=int, choices=[1, 2, 3], default=2)
parser.add_argument("--live", action="store_true")
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
fixture = json.loads(args.fixture.read_text())
task = next(t for t in json.loads((root / "docs/performance/efficiency-repo-pilot.json").read_text())["tasks"] if t["id"] == args.task_id)
path = task["allowedChanges"][0]
assert fixture["fixture"] and fixture["retiredBytes"] > 0
assert fixture["spillText"] == fixture["originalArguments"]
assert fixture["before"] != fixture["after"]

# Official peak rates checked on 2026-10-31. Ignoring cache discounts and using
# peak rates makes receipt-based spend an upper estimate, not invoice cost.
rates = {"deepseek-flash": (0.30, 1.20), "deepseek-v4-pro": (1.32, 3.96)}
report = {
    "schema": "gyro.efficiency-live-quality.v1",
    "scope": "direct-model-probes-with-production-shaped-synthetic-history",
    "fixtureSha256": hashlib.sha256(args.fixture.read_bytes()).hexdigest(),
    "pricingSource": "https://api-docs.deepseek.com/quick_start/pricing/",
    "priceDate": "2026-10-31", "priceBasis": "peak rates without cache discount",
    "spendCapUsd": args.max_cost_usd, "spentBeforeUsd": args.spent_before_usd,
    "spentUpperUsd": args.spent_before_usd,
    "requests": [], "cases": [],
    "taskId": args.task_id, "plannedCases": args.cases, "plannedTrials": args.trials,
    "verifierSha256": hashlib.sha256(task["verifier"].encode()).hexdigest(),
}
args.output.parent.mkdir(parents=True, exist_ok=True)


def save():
    args.output.write_text(json.dumps(report, indent=2) + "\n")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def call(model, messages, tools, output_cap, choice=None):
    payload = {"model": model, "messages": messages, "reasoning_effort": "high",
               "max_tokens": output_cap, "stream": False}
    if tools:
        payload["tools"] = tools
    if choice is not None:
        payload["tool_choice"] = choice
    wire = json.dumps(payload, ensure_ascii=True).encode()
    # Text-only probes: deliberately generous allowance for tokenization and
    # provider tool/message framing. A missing receipt keeps the full reserve
    # charged and stops the run; the output ceiling is enforced by the API.
    input_ceiling = len(wire) * 4 + 8192
    input_rate, output_rate = rates[model]
    reserve = (input_ceiling * input_rate + output_cap * output_rate) / 1_000_000
    if len(report["requests"]) >= 40 or report["spentUpperUsd"] + reserve > args.max_cost_usd:
        raise RuntimeError("budget-stop")
    report["spentUpperUsd"] += reserve
    record = {"model": model, "requestedEffort": "high", "maxOutputTokens": output_cap,
              "reservedUsd": reserve, "inputTokenCeiling": input_ceiling, "usage": None}
    report["requests"].append(record)
    save()
    started = time.monotonic()
    request = urllib.request.Request("https://api.deepseek.com/v1/chat/completions", data=wire,
                                     headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=180) as response:
            raw = response.read(2_000_001)
            if len(raw) > 2_000_000:
                raise RuntimeError("oversized-response")
            result = json.loads(raw)
    except Exception as error:
        record["errorType"] = type(error).__name__
        record["httpStatus"] = getattr(error, "code", None)
        record["elapsedMs"] = round((time.monotonic() - started) * 1000)
        save()
        raise RuntimeError("request-failed-or-usage-unavailable") from None
    usage = result.get("usage", {})
    incoming, outgoing = usage.get("prompt_tokens"), usage.get("completion_tokens")
    if not all(isinstance(n, int) and n >= 0 for n in (incoming, outgoing)):
        raise RuntimeError("usage-unavailable")
    record["usage"] = usage
    record["elapsedMs"] = round((time.monotonic() - started) * 1000)
    record["returnedModel"] = result.get("model")
    actual_upper = (incoming * input_rate + outgoing * output_rate) / 1_000_000
    record["costUpperUsd"] = actual_upper
    report["spentUpperUsd"] += actual_upper - reserve
    save()
    if incoming > input_ceiling or outgoing > output_cap:
        raise RuntimeError("provider-exceeded-reserved-token-bound")
    choice = result["choices"][0]
    return choice["message"], choice.get("finish_reason")


def verify_files(files):
    with tempfile.TemporaryDirectory(prefix="gyro-live-repair-") as directory:
        directory = Path(directory)
        workspace = directory / "workspace"
        for name, text in files.items():
            dest = workspace / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(text)
        verifier = directory / "independent-verifier.mjs"
        boundary = (root / "docs/reviews/model-quality-2026-10-31/retry-boundary-verifier.mjs").read_text() if args.task_id == "gyro-retry-terminal-guards" else ""
        verifier.write_text(task["verifier"] + "\n" + boundary)
        result = subprocess.run(["node", "--test", str(verifier)], cwd=workspace,
                                env={**os.environ, "GYRO_VERIFY_WORKSPACE": str(workspace)},
                                capture_output=True, text=True, timeout=60)
        return result.returncode == 0


def verify_replacements(replacements):
    if not isinstance(replacements, list) or not 1 <= len(replacements) <= 12:
        return False
    files = dict(task["files"])
    for edit in replacements:
        if not isinstance(edit, dict) or set(edit) not in ({"old", "new"}, {"path", "old", "new"}):
            return False
        selected_path = edit.get("path", path)
        if selected_path not in task["allowedChanges"]:
            return False
        source = files[selected_path]
        old, new = edit["old"], edit["new"]
        if not isinstance(old, str) or not isinstance(new, str) or not old or source.count(old) != 1:
            return False
        files[selected_path] = source.replace(old, new, 1)
    return verify_files(files)


prompts = {
    "historical-evidence": 'Recover the exact archivedMarker from the earlier history.ts proposal. Return JSON with exactly marker, path and status (pending or applied). Read saved historical evidence if necessary; do not guess.',
    "checkpoint": 'Assess these checks only: the format check passed; integration tests were not run. Tools are now disabled. Return a concise JSON checkpoint with exactly complete (boolean), verified (list of check names), remaining (list of check names). Use exactly format and integration as the check names. Do not claim unrun checks passed.',
    "coding": task["turns"][0] + '\nFor this probe, return JSON with exactly replacements: a list of objects with path, old and new strings. Each old string must match exactly once in its file; use the smallest replacement needed. The verifier will apply the replacements and run independent tests. Do not execute tools or add other files. Current source files:\n' + '\n'.join(name + ':\n' + task["files"][name] for name in task["allowedChanges"]),
}
if not args.live:
    assert verify_replacements([{"path": name, "old": task["files"][name], "new": source} for name, source in task["referenceSolution"].items()])
    assert not verify_replacements([])
    assert not verify_replacements([{"path": "outside.txt", "old": "a", "new": "b"}])
    print("Dry run: validated fixture and three probe definitions; no provider calls.")
    raise SystemExit(0)
assert 0 < args.max_cost_usd <= 1, "This verification is authorized for at most USD 1"
assert 0 <= args.spent_before_usd < args.max_cost_usd
assert not args.output.exists(), "Use a new report path; never erase previous spending evidence"
secrets = json.loads((Path.home() / "Library/Application Support/Gyro/secrets.json").read_text())
key = secrets["entries"]["provider:deepseek"]
assert key
try:
    for model in rates:
        for trial in range(1, args.trials + 1):
            for case, prompt in prompts.items():
                if case not in args.cases:
                    continue
                for arm in (("before", "after") if trial % 2 else ("after", "before")):
                    messages = copy.deepcopy(fixture[arm])
                    # Synthetic historical assistant frames have no generated
                    # reasoning; DeepSeek requires the field in tool histories.
                    for message in messages:
                        if message.get("role") == "assistant":
                            message.setdefault("reasoning_content", "")
                    messages.append({"role": "user", "content": prompt})
                    tools = fixture["tools"] if case == "historical-evidence" or (case == "checkpoint" and arm == "after") else []
                    choice = "none" if case == "checkpoint" and arm == "after" else None
                    row = {"model": model, "trial": trial, "case": case, "arm": arm,
                           "verified": False, "spillReads": 0, "requestStart": len(report["requests"])}
                    report["cases"].append(row)
                    for _ in range(3):
                        message, finish = call(model, messages, tools, 16384 if case == "coding" else 4096, choice)
                        calls = message.get("tool_calls") or []
                        if calls:
                            if case != "historical-evidence":
                                row["failure"] = "forbidden-tool-call"
                                break
                            messages.append(message)  # Preserve provider-owned reasoning state.
                            for tool in calls:
                                function = tool["function"]
                                arguments = json.loads(function["arguments"])
                                row.setdefault("toolRequests", []).append({"name": function["name"], "arguments": arguments})
                                valid = function["name"] == "gyro_workspace_read" and arguments.get("path") == fixture["spillAddress"]
                                if valid:
                                    row["spillReads"] += 1
                                    data = {"status": "completed", "result": {"capabilityId": "workspace-read", "data": {"path": arguments["path"], "content": fixture["spillText"]}}}
                                else:
                                    data = {"status": "failed", "error": "Only the saved spill address in this fixture can be read."}
                                messages.append({"role": "tool", "tool_call_id": tool["id"], "content": json.dumps(data)})
                            continue
                        content = message.get("content") or ""
                        row["finishReason"] = finish
                        row["answerSha256"] = hashlib.sha256(content.encode()).hexdigest()
                        # The production checkpoint is prose, not a strict JSON
                        # bridge. A single JSON code fence does not change its
                        # meaning; preserve that formatting in the evidence.
                        parsed_content = content.strip()
                        fenced = re.fullmatch(r"```(?:json|JSON)?\s*\n([\s\S]*?)\n```", parsed_content)
                        if fenced:
                            parsed_content = fenced.group(1)
                            row["answerFormatting"] = "json-code-fence"
                        try:
                            answer = json.loads(parsed_content)
                        except json.JSONDecodeError:
                            row["failure"] = "invalid-answer-json"
                            row["finalText"] = content
                            break
                        row["answer"] = answer  # Synthetic final answer only; never reasoning content.
                        if case == "historical-evidence":
                            row["verified"] = answer == {"marker": fixture["expectedMarker"], "path": "history.ts", "status": "pending"}
                        elif case == "checkpoint":
                            row["verified"] = answer == {"complete": False, "verified": ["format"], "remaining": ["integration"]}
                        else:
                            row["verified"] = verify_replacements(answer.get("replacements"))
                        row["verified"] = row["verified"] and finish == "stop"
                        break
                    row["requestEnd"] = len(report["requests"])
                    if not row["verified"] and "failure" not in row:
                        row["failure"] = "verification-failed" if "answer" in row else "tool-round-limit"
                    save()
                    print(json.dumps(row), flush=True)
except RuntimeError as error:
    report["stopped"] = str(error)
except KeyboardInterrupt:
    report["stopped"] = "operator-interrupted; outstanding request reserve retained"
finally:
    save()
    print(json.dumps({"cases": len(report["cases"]), "verified": sum(r["verified"] for r in report["cases"]), "spentUpperUsd": report["spentUpperUsd"], "stopped": report.get("stopped")}), flush=True)
