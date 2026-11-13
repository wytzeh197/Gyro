// Production Problems panel and chat composers. Native storage/provider sends are simulated.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(resolve("apps/desktop/package.json"));
const { createServer, transformWithEsbuild } = await import(pathToFileURL(require.resolve("vite")));
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { ChatSurface, WorkspaceToolPanel, providersForConfig, problemAttachmentName, problemAttachmentText } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";
import { EnvironmentPlanSteps } from "@problem-plan";
const empty={commandProfiles:[],modelProviders:[],requireCommandApproval:true,requireFileEditApproval:true,telemetryEnabled:false};
const config={...empty,selectedProviderId:"openai",modelProviders:providersForConfig(empty).map(p=>p.id==="openai"?{...p,enabled:true,authStatus:"connected"}:p)};
const diagnostic={id:"type-error",path:"src/main.ts",message:"Type 'string' is not assignable to type 'number'.",severity:"error",source:"TypeScript",startLineNumber:12,startColumn:7};
window.deliveries=[];window.sends=[];window.errors=[];window.opened=[];
function Fixture(){
 const [attachments,setAttachments]=React.useState({});
 const [drafts,setDrafts]=React.useState({a:"Fix this problem",b:"Explain this error"});
 window.attachments=attachments;window.drafts=drafts;
 return <main style={{height:"100vh",display:"grid",gridTemplateRows:"180px minmax(0,1fr)"}}>
 <section style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:24}}>
 <WorkspaceToolPanel activePaneTab="problems" profiles={[]} terminalPanes={[]} workspacePath="/fixture/source" ide={{diagnostics:[diagnostic]}} onPaneTabChange={()=>{}} onOpenDiffInEditor={(...args)=>window.opened.push(args)} />
 <div style={{padding:20}}><h3>Release plan</h3><EnvironmentPlanSteps workspacePath="/fixture/source" plan={{title:"Release plan",items:[{id:"verify",title:"Verify staging",detail:"Waiting for staging access",status:"blocked"}]}} /></div>
 </section>
 <section style={{display:"grid",gridTemplateColumns:"1fr 1fr",minHeight:0}}>
 {["a","b"].map(pane=><div data-fixture-pane={pane} key={pane} style={{minWidth:0,minHeight:0}}>
 <ChatSurface config={config} events={[]} paneKey={pane} sessionTitle={"Chat "+pane} workspacePath={"/fixture/"+pane} shellReady isTiled
 sessionModel={{providerId:"openai",modelId:"gpt-6.1-sol",modelLabel:"GPT-6.1 Sol",reasoningEffort:"medium"}}
 draft={drafts[pane]} onDraftChange={value=>setDrafts(c=>({...c,[pane]:value}))}
 attachments={attachments[pane]??[]} onAttachProblem={problem=>{
 window.deliveries.push({pane,problem,text:problemAttachmentText(problem)});
 const attachment={id:crypto.randomUUID(),kind:"ide-snapshot",name:problemAttachmentName(problem),path:"/stored/problem.txt",size:problemAttachmentText(problem).length};
 setAttachments(c=>({...c,[pane]:[...(c[pane]??[]),attachment]}));
 }} onAttachMediaFiles={()=>{throw Error("Problem routed as media")}}
 onMediaDropError={error=>window.errors.push(error)}
 onRemoveAttachment={id=>setAttachments(c=>({...c,[pane]:(c[pane]??[]).filter(a=>a.id!==id)}))}
 onSend={prompt=>window.sends.push({pane,prompt,attachments:attachments[pane]??[]})}
 isEnvironmentRailOpen={false} onComposerAction={()=>{}}/>
 </div>)}</section></main>;
}
createRoot(document.getElementById("root")).render(<Fixture/>);
`;
const profile = await mkdtemp(join(tmpdir(), "gyro-problem-drag-"));
const server = await createServer({
  configFile: false,
  esbuild: { jsx: "automatic" },
  root: resolve("apps/desktop"),
  optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"], entries: [] },
  cacheDir: join(profile, "vite-cache"),
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{
    name: "problem-drag-verification",
    enforce: "pre",
    resolveId(id) {
      if (id === "@problem-plan") return resolve("packages/ui/src/plan-mode.tsx");
      if (id === "/__problem_drag.tsx") return "\0problem-drag.tsx";
    },
    async load(id) {
      if (id === "\0problem-drag.tsx") return (await transformWithEsbuild(fixture, "fixture.tsx", { loader: "tsx", jsx: "automatic" })).code;
    },
    configureServer(s) {
      s.middlewares.use("/__problem_drag.html", async (req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end(await s.transformIndexHtml("/__problem_drag.html",
          '<html data-theme="dark"><body style="background:#141414"><div id="root"></div><script type="module" src="/__problem_drag.tsx"></script></body></html>'));
      });
    },
  }],
});
await server.listen();
const origin = "http://127.0.0.1:" + server.httpServer.address().port;
let browser, ws;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  browser = spawn(process.env.GYRO_CAPTURE_BROWSER || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--use-mock-keychain", "--password-store=basic",
    "--user-data-dir=" + profile, "--remote-debugging-port=0", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "", launchError;
  browser.on("error", error => { launchError = error; });
  browser.stderr.on("data", value => { stderr = (stderr + value).slice(-4000); });
  async function until(check, label) {
    const end = Date.now() + 25000;
    while (Date.now() < end) {
      if (launchError) throw launchError;
      const result = await check();
      if (result) return result;
      await pause(100);
    }
    throw Error("Timed out: " + label);
  }
  const endpoint = await until(() => stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], "browser start");
  const pages = await (await fetch("http://" + new URL(endpoint).host + "/json/list")).json();
  ws = new WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data), request = pending.get(message.id);
    if (message.method === "Runtime.exceptionThrown") console.error(JSON.stringify(message.params));
    if (!request) return;
    pending.delete(message.id);
    message.error ? request.reject(message.error) : request.resolve(message.result);
  };  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(Error(method + " timeout")); }, 20000);
      pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1200, height: 820, deviceScaleFactor: 1, mobile: false });
  await call("Page.navigate", { url: origin + "/__problem_drag.html" });
  await until(async()=>await evaluate('document.querySelectorAll(".gyro-composer-shell").length')===2,"two chat composers");
  assert.equal(await evaluate('document.querySelector(".gyro-problem-row").draggable'),true);
  await evaluate('document.querySelector(".gyro-problem-row").click()');
  assert.deepEqual(await evaluate("window.opened[0]"),["src/main.ts",12,7]);
  async function drop(pane, invalid=false, sourceSelector=".gyro-problem-row") {
    return evaluate(`(()=>{
      const source=document.querySelector(${JSON.stringify(sourceSelector)});
      const transfer=new DataTransfer();
      source.dispatchEvent(new DragEvent("dragstart",{bubbles:true,dataTransfer:transfer}));
      if (${invalid}) transfer.setData("application/x-gyro-problem","not json");
      const target=${pane ? 'document.querySelector('+JSON.stringify('[data-fixture-pane="'+pane+'"] textarea')+')' : 'source'};
      const r=target.getBoundingClientRect(),point={clientX:r.x+r.width/2,clientY:r.y+r.height/2};
      const over=new DragEvent("dragover",{bubbles:true,cancelable:true,dataTransfer:transfer,...point});
      target.dispatchEvent(over);
      const highlighted=document.querySelectorAll("[data-media-drop-target]").length;
      target.dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:transfer,...point}));
      source.dispatchEvent(new DragEvent("dragend",{bubbles:true,dataTransfer:transfer}));
      return {accepted:over.defaultPrevented,highlighted};
    })()`);
  }
  assert.deepEqual(await drop("b"),{accepted:true,highlighted:1});
  await until(async()=>await evaluate("window.attachments.b?.length")===1,"attachment in target chat");
  assert.equal(await evaluate("window.attachments.a?.length??0"),0);
  assert.equal(await evaluate("window.deliveries.length"),1);
  assert.equal(await evaluate("window.deliveries[0].problem.workspacePath"),"/fixture/source");
  assert.match(await evaluate("window.deliveries[0].text"),/Location: 12:7/);
  assert.deepEqual(await evaluate("window.drafts"),{a:"Fix this problem",b:"Explain this error"});
  assert.equal(await evaluate("window.sends.length"),0);
  assert.equal(await evaluate('document.querySelectorAll("[data-media-drop-target]").length'),0);
  assert.equal(await evaluate('document.querySelector("[data-fixture-pane=b] .gyro-composer-attachment strong").textContent'),"main.ts-L12.problem.txt");
  await evaluate('document.querySelector("[data-fixture-pane=b] .gyro-composer-attachment button[aria-label^=Remove]").click()');
  await until(async()=>await evaluate("window.attachments.b.length")===0,"remove attachment");  assert.deepEqual(await drop("a"),{accepted:true,highlighted:1});
  await until(async()=>await evaluate("window.attachments.a?.length")===1,"second drop targets other chat");
  assert.equal(await evaluate("window.deliveries.length"),2);
  await drop(null);
  assert.equal(await evaluate("window.deliveries.length"),2);
  await drop("b",true);
  assert.equal(await evaluate("window.errors.length"),1);
  assert.equal(await evaluate("window.deliveries.length"),2);
  assert.equal(await evaluate("window.drafts.b"),"Explain this error");
  await evaluate('document.querySelector("[data-fixture-pane=a] .gyro-send-button").click()');
  await until(async()=>await evaluate("window.sends.length")===1,"user explicitly sends");
  assert.equal(await evaluate("window.sends[0].prompt"),"Fix this problem");
  assert.equal(await evaluate("window.sends[0].attachments[0].name"),"main.ts-L12.problem.txt");
  const badgePoint = await evaluate('(()=>{const r=document.querySelector(".gyro-plan-blocked-badge").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  await call("Input.dispatchMouseEvent",{type:"mouseMoved",...badgePoint});
  await until(async()=>await evaluate('document.querySelector(".gyro-plan-blocked-tooltip")?.textContent')==="Waiting for staging access","blocked reason on hover");
  assert.deepEqual(await drop("b",false,".gyro-plan-blocked-badge"),{accepted:true,highlighted:1});
  await until(async()=>await evaluate("window.attachments.b?.length")===1,"blocked step attaches");
  await call("Input.dispatchMouseEvent",{type:"mouseMoved",x:900,y:740});
  await until(async()=>!(await evaluate('Boolean(document.querySelector(".gyro-plan-blocked-tooltip"))')),"tooltip closes after drag");
  assert.equal(await evaluate("window.deliveries.length"),3);
  assert.equal(await evaluate("window.deliveries[2].problem.planStep.title"),"Verify staging");
  assert.match(await evaluate("window.deliveries[2].text"),/Waiting for staging access/);
  assert.equal(await evaluate("window.attachments.b[0].name"),"Verify-staging.problem.txt");
  assert.equal(await evaluate("window.sends.length"),1);
  const output=resolve("artifacts/problem-drag");
  await mkdir(output,{recursive:true});
  for(const theme of ["dark","light"]){
    await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));
    await pause(100);
    const shot=await call("Page.captureScreenshot",{format:"png"});
    await writeFile(join(output,"problem-attachment-"+theme+".png"),Buffer.from(shot.data,"base64"));
  }
  console.log("Problem drag browser checks passed: production source drag, file navigation, split-pane routing, one attachment per drop, composer chip, draft preservation, remove, invalid/outside drops, and explicit send.");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  ws?.close();
  const stopped = browser && browser.exitCode === null && browser.signalCode === null
    ? new Promise(resolve => browser.once("exit", resolve)) : Promise.resolve();
  browser?.kill("SIGTERM");
  await Promise.race([stopped, pause(5000)]);
  server.httpServer?.closeAllConnections();
  await Promise.race([server.close(), pause(5000)]);
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
