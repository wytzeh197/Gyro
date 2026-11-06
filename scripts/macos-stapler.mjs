import { spawnSync } from "node:child_process";
export function staplerFailureIsTransient(output) {
  return /network connection was lost|NSURLErrorDomain Code=-1005|NSURLErrorDomain Code=-1009|kCFErrorDomainCFNetwork Code=-1005|CloudKit's response is inconsistent/i.test(
    output,
  );
}
export function runStapler(action, targetPath, spawn = spawnSync) {
  if (!["staple", "validate"].includes(action))
    throw new Error("Unsupported stapler action");
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const result = spawn("xcrun", ["stapler", action, targetPath], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (!result.error && result.status === 0) return;
    const output =
      `${result.stdout ?? ""}\n${result.stderr ?? ""}${result.error?.message ?? ""}`.trim();
    const failure = new Error(
      `xcrun stapler ${action} ${targetPath} exited ${result.status ?? "missing"}${output ? `:\n${output}` : ""}`,
    );
    if (attempt === 4 || !staplerFailureIsTransient(output)) throw failure;
    console.error(
      `Apple ticket service connection dropped during ${action} (attempt ${attempt} of 4); retrying.`,
    );
    const wait = spawn("sleep", [String(10 * attempt)], { encoding: "utf8" });
    if (wait.error || wait.status !== 0)
      throw new Error("Could not wait before retrying Apple ticket service");
  }
}
