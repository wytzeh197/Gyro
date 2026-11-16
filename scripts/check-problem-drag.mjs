import assert from "node:assert/strict";
import { beginPlanProblemDrag, beginProblemDrag, isProblemDrag, readProblemDrag, problemAttachmentText, problemAttachmentName, PROBLEM_DRAG_MIME } from "../packages/ui/src/problem-drag.ts";
import { isMediaDrag, workspaceDropFromTransfer } from "../packages/ui/src/chat-media-transfer.ts";

const diagnostic = { id: "ts:1", path: "src/main.ts", message: "Type 'string' is not assignable to type 'number'.", severity: "error", source: "TypeScript", startLineNumber: 12, startColumn: 7, endLineNumber: 12, endColumn: 11 };
const data = new Map();
const transfer = { types: [], effectAllowed: "", setData(type, value) { data.set(type, value); this.types = [...data.keys()]; }, getData(type) { return data.get(type) ?? ""; } };
beginProblemDrag(transfer, diagnostic, "/project/source");
assert.equal(transfer.effectAllowed, "copy");
assert.equal(isProblemDrag(transfer), true);
assert.equal(isProblemDrag({types: ["Files"]}), false);
assert.equal(isMediaDrag(transfer), false);
assert.equal(workspaceDropFromTransfer(transfer), undefined);
const problem = readProblemDrag(transfer);
assert.deepEqual(problem, {diagnostic, workspacePath: "/project/source"});
const content = problemAttachmentText(problem);
for (const part of ["Workspace: /project/source", "File: src/main.ts", "Location: 12:7–12:11", "Severity: error", "Source: TypeScript", diagnostic.message]) assert.ok(content.includes(part));
assert.equal(problemAttachmentName(problem), "main.ts-L12.problem.txt");
assert.equal(problemAttachmentName({diagnostic:{...diagnostic,path:"C:\\project\\main.ts"}}), "main.ts-L12.problem.txt");
for (const invalid of [
  "not json", "null", "x".repeat(65537),
  JSON.stringify({diagnostic:{...diagnostic,startLineNumber:0}}),
  JSON.stringify({diagnostic:{...diagnostic,message:""}}),
  JSON.stringify({diagnostic:{...diagnostic,severity:"unknown"}}),
  JSON.stringify({diagnostic:{...diagnostic,path:"bad\u0000path"}}),
  JSON.stringify({diagnostic, workspacePath:42}),
]) assert.equal(readProblemDrag({getData:()=>invalid}), undefined);
assert.equal(readProblemDrag({getData(){throw Error("closed data store");}}), undefined);
assert.equal(data.get(PROBLEM_DRAG_MIME).includes(diagnostic.message), true);
const planStep = {id:"verify", title:"Verify staging", detail:"Waiting for staging access"};
beginPlanProblemDrag(transfer, planStep, "Release plan", "/project/source");
const planProblem = readProblemDrag(transfer);
assert.deepEqual(planProblem, {planStep, planTitle:"Release plan", workspacePath:"/project/source"});
assert.equal(isMediaDrag(transfer), false);
assert.equal(problemAttachmentName(planProblem), "Verify-staging.problem.txt");
assert.match(problemAttachmentText(planProblem), /Step: Verify staging/);
assert.match(problemAttachmentText(planProblem), /Waiting for staging access/);
assert.match(problemAttachmentText({...planProblem, planStep:{...planStep, detail:" "}}), /No blocking reason was recorded/);
assert.equal(readProblemDrag({getData:()=>JSON.stringify({planStep:{...planStep,title:""},planTitle:"Plan"})}), undefined);
console.log("Problem drag checks passed: payload round-trip, source workspace, location, filename, invalid payloads, and isolation from media/folder drops.");
