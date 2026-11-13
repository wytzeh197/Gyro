import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const c=JSON.parse(read("docs/contracts/gyro-cloud-v3.json")),config=JSON.parse(read("config/cloud-v3.json")),native=read("crates/gyro-core/src/cloud_connection/v3.rs");
assert.equal(c.contractVersion,config.contractVersion);assert.equal(c.policyVersion,config.policyVersion);assert.equal(config.enabled,false);
assert.ok(native.includes(`VERSION: &str = "${c.contractVersion}"`));assert.ok(native.includes(`POLICY: &str = "${c.policyVersion}"`));
assert.equal(c.project.maximumPayloadBytes,2_000_000_000);assert.equal(c.project.chunkBytes,4194304);assert.equal(c.plans.cloud.currency,"USD");assert.equal(c.plans.cloud.uploadBytes,40_000_000_000);assert.equal(c.plans.plus.uploadBytes,160_000_000_000);
for(const route of ["GET /v3/capabilities","GET /v3/jobs/by-request/:requestId","GET /v3/exports/:id/revisions/:revision","POST /v3/uploads"]){assert.ok(c.routes.includes(route));}
if(process.argv[2])assert.deepEqual(c,JSON.parse(readFileSync(process.argv[2],"utf8")));
console.log(`${c.routes.length} v3 route inventory entries and native wire limits agree; this is not full hosted or response-schema acceptance.`);
