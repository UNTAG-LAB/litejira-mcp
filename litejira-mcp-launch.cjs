#!/usr/bin/env node
// MCP server launcher: load credentials from ~/.litejira/credentials.env,
// then spawn litejira-mcp-server.js with inherited stdio so Claude Code
// talks to the real server directly.
//
// Keeps secrets out of .mcp.json (which is checked into git).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const credFile = path.join(os.homedir(), '.litejira', 'credentials.env');
if (fs.existsSync(credFile)) {
  const text = fs.readFileSync(credFile, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(LTJ_API_URL|LTJ_API_TOKEN|LTJ_API_PAT|LTJ_MCP_ENABLE_WRITES)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const serverPath = path.join(__dirname, 'litejira-mcp-server.js');
const child = spawn(process.execPath, [serverPath], {
  stdio: 'inherit',
  env: process.env
});
child.on('exit', (code, signal) => {
  process.exit(typeof code === 'number' ? code : (signal ? 1 : 0));
});
