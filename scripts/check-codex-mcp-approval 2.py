#!/usr/bin/env python3
"""Reproduce Gyro Full Access MCP rejection through a local fixture model.

Run: python3 scripts/check-codex-mcp-approval.py
Companion Rust tests verify the actual generated config and retained Gyro policy.
"""
import json, subprocess, tempfile, pathlib, queue, threading, http.server, os, time
# Run manually with Python 3 and an installed Codex CLI. No remote model or credentials used.
TOOL='gyro_workspace_get_context'
class Model(http.server.BaseHTTPRequestHandler):
 def log_message(self,*a): pass
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
  time.sleep(0.1)
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  item={'type':'function_call','id':'fc_1','call_id':'call_1','namespace':'mcp__gyro_capabilities','name':TOOL,'arguments':'{}'}
  events=[{'type':'response.created','response':{'id':'resp_1'}},{'type':'response.output_item.done','output_index':0,'item':item},{'type':'response.completed','response':{'id':'resp_1','status':'completed','output':[item],'usage':{'input_tokens':1,'output_tokens':1,'total_tokens':2}}}]
  for e in events:self.wfile.write(('data: '+json.dumps(e)+'\n\n').encode())
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Model)
threading.Thread(target=server.serve_forever,daemon=True).start()
with tempfile.TemporaryDirectory(prefix='gyro-mcp-turn-') as directory:
 p=pathlib.Path(directory)
 fixture=p/'mcp.py'
 source='import sys,json\nfor line in sys.stdin:\n r=json.loads(line)\n if "id" not in r: continue\n m=r.get("method")\n if m=="initialize": v={"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"gyro-test","version":"1"}}\n elif m=="tools/list": v={"tools":[{"name":"gyro_workspace_get_context","description":"Read fixture context","inputSchema":{"type":"object","properties":{}}}]}\n elif m=="tools/call": v={"content":[{"type":"text","text":"gyro-dispatcher-reached"}]}\n else: v={}\n print(json.dumps({"jsonrpc":"2.0","id":r["id"],"result":v}),flush=True)\n'
 fixture.write_text(source)
 for fixed in [False,True]:
  args=['codex','app-server','--stdio']
  config={'model_provider':'gyro_test','model':'fixture','model_providers.gyro_test.name':'Fixture','model_providers.gyro_test.base_url':'http://127.0.0.1:'+str(server.server_port)+'/v1','model_providers.gyro_test.wire_api':'responses','model_providers.gyro_test.requires_openai_auth':False,'mcp_servers.gyro_capabilities.command':'python3','mcp_servers.gyro_capabilities.args':[str(fixture)]}
  if fixed:config['mcp_servers.gyro_capabilities.tools.'+TOOL+'.approval_mode']='approve'
  for k,v in config.items():args+=['-c',k+'='+json.dumps(v)]
  # Isolate user configuration and credentials; all model output comes from localhost.
  env=dict(os.environ,CODEX_HOME=str(p/('fixed' if fixed else 'before')))
  pathlib.Path(env['CODEX_HOME']).mkdir()
  child=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,env=env)
  q=queue.Queue()
  def read(out,q):
   for line in out:q.put(json.loads(line))
  threading.Thread(target=read,args=(child.stdout,q),daemon=True).start()
  def send(msg):child.stdin.write(json.dumps(msg)+'\n');child.stdin.flush()
  def call(i,method,params):
   send({'id':i,'method':method,'params':params})
   while True:
    msg=q.get(timeout=30)
    if msg.get('id')==i:
     assert 'error' not in msg,msg
     return msg['result']
  try:
   call(1,'initialize',{'clientInfo':{'name':'gyro-smoke','version':'1'},'capabilities':{'experimentalApi':True}})
   th=call(2,'thread/start',{'cwd':directory,'ephemeral':True,'approvalPolicy':'on-request','sandbox':'danger-full-access'})
   call(3,'turn/start',{'threadId':th['thread']['id'],'input':[{'type':'text','text':'Call the fixture tool once.'}]})
   deadline=time.monotonic()+10
   while time.monotonic()<deadline:
    msg=q.get(timeout=10)
    if 'id' in msg and 'method' in msg:
     print('Before: '+msg['method']+' was unhandled by Gyro.',flush=True)
     assert not fixed,'fixed config still requested approval'
     send({'id':msg['id'],'error':{'code':-32601,'message':'unsupported Gyro client request'}})
    if msg.get('method')=='item/completed' and msg.get('params',{}).get('item',{}).get('type')=='mcpToolCall':
     item=msg['params']['item']
     print(('After: ' if fixed else 'Before: ')+str(item.get('error') or item['status']),flush=True)
     if fixed:assert 'gyro-dispatcher-reached' in json.dumps(item),item
     else:assert 'user rejected' in json.dumps(item),item
     break
    if msg.get('method')=='turn/completed':raise AssertionError(msg)
   else:raise AssertionError('Fixture turn timed out')
  finally:
   child.terminate();child.wait(timeout=10)
server.shutdown()
print('PASS: reproduced false rejection before the patch and successful tool execution after it, using a local fixture model.')
