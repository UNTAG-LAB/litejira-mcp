'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {spawn}=require('node:child_process');
const PKG=process.env.LTJ_ACCEPT_PACKAGE_DIR || path.join(__dirname,'..');
const TOKEN='ltj_pat_isolated_cli_acceptance';
function run(args,env,cwd,input){return new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,[path.join(PKG,'litejira-mcp-launch.cjs'),...args],{env,cwd,stdio:['pipe','pipe','pipe'],windowsHide:true});
 let out='',err='';const timeout=setTimeout(()=>{child.kill();reject(new Error('onboarding CLI timeout'));},30000);
 child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);
 child.on('close',code=>{clearTimeout(timeout);assert.ok(!out.includes(TOKEN)&&!err.includes(TOKEN),'token must not appear in CLI output');resolve({code,out,err});});
 child.stdin.end(input||'');
});}
test('real CLI: migrate all hosts, verify persisted credentials, repeat without token, reject bad token without mutation',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'ltj-cli-full-'));
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const cwd=path.join(home,'workspace');fs.mkdirSync(cwd);
 for(const dir of ['.codex','.gemini'])fs.mkdirSync(path.join(home,dir));
 const old={command:'node',args:['/retired/.litejira/mcp/litejira-mcp-launch.cjs']};
 const cfile=path.join(home,'.codex/config.toml'),afile=path.join(home,'.claude.json'),gfile=path.join(home,'.gemini/settings.json');
 fs.writeFileSync(cfile,'# preserve user comment\n[mcp_servers.other]\ncommand = "untouched"\n\n[mcp_servers.litejira]\ncommand = "node"\nargs = ["/retired/.litejira/mcp/litejira-mcp-launch.cjs"]\nstartup_timeout_sec = 25\n');
 fs.writeFileSync(afile,JSON.stringify({mcpServers:{litejira:old},theme:'dark'}));
 fs.writeFileSync(gfile,JSON.stringify({mcpServers:{litejira:{...old,includeTools:['litejira.searchTickets']}},ui:{theme:'Default'}}));
 const calls=[];
 const server=http.createServer((req,res)=>{
  calls.push({url:req.url,method:req.method,authorized:req.headers.authorization==='Bearer '+TOKEN});
  res.setHeader('content-type','application/json');
  if(req.headers.authorization!=='Bearer '+TOKEN){res.writeHead(401);res.end(JSON.stringify({error:{code:'unauthenticated',message:'invalid'}}));return;}
  if(req.method!=='GET'){res.writeHead(405);res.end('{}');return;}
  const data=req.url.includes('/meta')?{types:[],statuses:[],priorities:[]}:{items:[],total:0};
  res.end(JSON.stringify({data}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const env={...process.env};for(const key of Object.keys(env))if(/^(LTJ_|CODEX_HOME$|CLAUDE_CONFIG_DIR$|GEMINI_CLI_HOME$)/i.test(key))delete env[key];
 Object.assign(env,{HOME:home,USERPROFILE:home,CODEX_HOME:path.join(home,'.codex'),LTJ_MCP_NO_UPDATE_CHECK:'1'});
 const first=await run(['setup','--client','auto','--token-stdin','--json'],{...env,LTJ_API_URL:`http://127.0.0.1:${server.address().port}`,LTJ_PROJECT:'ACCEPT'},cwd,TOKEN+'\n');
 assert.equal(first.code,0,first.err);const result=JSON.parse(first.out);assert.equal(result.ok,true);assert.equal(result.clients.length,3);
 assert.ok(result.clients.every(c=>c.configured&&c.stdioVerified));
 assert.match(fs.readFileSync(cfile,'utf8'),/startup_timeout_sec = 25/);
 assert.match(fs.readFileSync(cfile,'utf8'),/command = "untouched"/);
 assert.deepEqual(JSON.parse(fs.readFileSync(gfile,'utf8')).mcpServers.litejira.includeTools,['litejira.searchTickets']);
 for(const file of [cfile,afile,gfile])assert.ok(!fs.readFileSync(file,'utf8').includes(TOKEN));
 // Drop temporary token, URL and project environment: only the persisted configuration can work.
 const doctor=await run(['doctor','--client','auto'],env,cwd);
 assert.equal(doctor.code,0,doctor.err);assert.equal(JSON.parse(doctor.out).ok,true);
 const backups=()=>fs.readdirSync(path.dirname(cfile)).filter(n=>n.startsWith('config.toml.litejira-backup-'));
 const backupCount=backups().length;
 const repeat=await run(['setup','--client','auto','--json'],env,cwd);
 assert.equal(repeat.code,0,repeat.err);assert.equal(JSON.parse(repeat.out).ok,true);
 assert.equal(backups().length,backupCount,'unchanged registration must not create redundant backups');
 const files=[cfile,afile,gfile,path.join(home,'.litejira/credentials.env')];
 const before=files.map(f=>fs.readFileSync(f));
 const rejected=await run(['setup','--client','auto','--token-stdin','--json'],env,cwd,'ltj_pat_wrong_cli_negative\n');
 assert.notEqual(rejected.code,0);assert.equal(JSON.parse(rejected.out).ok,false);
 files.forEach((f,i)=>assert.deepEqual(fs.readFileSync(f),before[i]));
 // A host explicitly launches dev. With no dev credentials it must not borrow the default token.
 const claudeConfig=JSON.parse(fs.readFileSync(afile,'utf8'));
 claudeConfig.mcpServers.litejira.args.push('dev');fs.writeFileSync(afile,JSON.stringify(claudeConfig));
 const missingDev=await run(['doctor','--client','claude'],{...env,LTJ_API_URL:`http://127.0.0.1:${server.address().port}`,LTJ_PROJECT:'ACCEPT'},cwd);
 assert.notEqual(missingDev.code,0,'doctor must not inject default token into a dev launcher missing credentials');
 assert.ok(calls.filter(c=>c.authorized).some(c=>c.url.includes('/tickets')),'must perform real MCP read');
 assert.ok(calls.every(c=>c.method==='GET'),'all API calls must be read-only');
});

test('CLI unexpected filesystem failure still emits safe machine-readable results',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'ltj-cli-error-'));
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 fs.mkdirSync(path.join(home,'.codex'));
 fs.mkdirSync(path.join(home,'.litejira','credentials.env'),{recursive:true});
 const env={...process.env,HOME:home,USERPROFILE:home,CODEX_HOME:path.join(home,'.codex')};
 for(const key of Object.keys(env))if(/^LTJ_/.test(key))delete env[key];
 for(const command of ['setup','doctor']){
  const result=await run([command,'--client','codex','--json'],env,home);
  assert.equal(result.code,1);const report=JSON.parse(result.out);
  assert.equal(report.ok,false);assert.equal(report.error,'internal_error');
  assert.equal(report.mutationState,command==='setup'?'unknown':'unchanged');
  assert.equal(report.partiallyApplied,command==='setup'?null:false);
 }
});

test('unsupported legal quoted header cannot corrupt a different Codex server',()=>{
 const editor=require(path.join(PKG,'litejira-toml-edit.js'));
 const original='[mcp_servers.litejira]\ncommand="node"\n[mcp_servers."a]b"]\nargs=["untouched"]\n';
 const result=editor.upsertServerEntry(original,'litejira',{command:'new',args:['new-launcher']});
 assert.equal(result.ok,false);assert.equal(result.changed,false);
});
