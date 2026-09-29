#!/usr/bin/env node
'use strict';

// 發版驗證：把「可能出錯的判斷」都放在這支 Node 腳本裡，
// workflow 只負責呼叫它（避免 YAML 裡塞一堆脆弱的 shell 引號）。
//
// 模式：
//   preflight        --tag vX.Y.Z              tag 格式 / 對版本號 / 來源 commit 在 origin/main
//   pack-verify      --tag vX.Y.Z --tarball t  解包 tgz 隔離安裝 → 真的啟動跑唯讀 smoke
//   publish-precheck --tag vX.Y.Z --tarball t  registry 已有同版？integrity 一致就跳過、不一致就 fail
//   registry-verify  --tag vX.Y.Z --tarball t  發布後退避確認 registry integrity 與 latest，再安裝跑 smoke
//   smoke-dir        --tag vX.Y.Z --dir d      只跑 smoke（本機手動驗這支腳本自己，不需 npm pack）
//
// 憑證：本檔不讀、不寫、不印任何憑證；smoke 打的是本機 loopback stub，權杖是測試字串。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const PKG_NAME = 'litejira-mcp';
const REGISTRY = 'https://registry.npmjs.org';
const MIN_NPM = '11.5.1';
const SMOKE_TOKEN = 'ltj_pat_release_verify_not_a_real_token';

// ── 純函式（單元測試打這一層）──────────────────────────────────────────────

// 只收正式版 vX.Y.Z：預發布（-rc.1）、建置後綴、前導零一律擋。
function parseReleaseTag(tag) {
  const m = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(tag || '').trim());
  if (!m) throw new Error(`tag 必須是正式版 vX.Y.Z（不接受預發布 / 建置後綴）：實得 ${JSON.stringify(tag)}`);
  return `${m[1]}.${m[2]}.${m[3]}`;
}

function assertTagMatchesPackage(tag, pkg) {
  const version = parseReleaseTag(tag);
  if (pkg.name !== PKG_NAME) throw new Error(`package.json name 應為 ${PKG_NAME}，實得 ${pkg.name}`);
  if (pkg.version !== version) throw new Error(`tag ${tag} 與 package.json 版本 ${pkg.version} 不一致`);
  return version;
}

function integrityOf(buffer) {
  return 'sha512-' + crypto.createHash('sha512').update(buffer).digest('base64');
}

function shasumOf(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

// registry 的 dist 可能只有 shasum（舊版）或兩者都有；有什麼就比什麼，兩者都沒有＝不可判定。
function compareDist(dist, local) {
  if (!dist || typeof dist !== 'object') return { same: false, how: 'registry 沒有 dist 欄位' };
  if (typeof dist.integrity === 'string' && dist.integrity !== '') {
    return { same: dist.integrity === local.integrity, how: `integrity（registry ${dist.integrity}）` };
  }
  if (typeof dist.shasum === 'string' && dist.shasum !== '') {
    return { same: dist.shasum === local.shasum, how: `shasum（registry ${dist.shasum}）` };
  }
  return { same: false, how: 'registry dist 既無 integrity 也無 shasum' };
}

// 已存在同版 → integrity 一致就跳過發布（重跑安全）；不一致就明確失敗，不覆寫也不裝沒事。
function decidePublish({ version, packument, local }) {
  const versions = (packument && packument.versions) || {};
  if (!Object.prototype.hasOwnProperty.call(versions, version)) {
    const latest = packument && packument['dist-tags'] && packument['dist-tags'].latest;
    if (latest && compareSemver(version, latest) <= 0) {
      throw new Error(`拒絕將 latest 從 ${latest} 倒退至 ${version}`);
    }
    return { publish: true, reason: `registry 尚無 ${PKG_NAME}@${version}，繼續發布` };
  }
  const cmp = compareDist(versions[version].dist, local);
  if (cmp.same) return { publish: false, reason: `registry 已有 ${PKG_NAME}@${version} 且與本地 tgz 一致（${cmp.how}），跳過發布` };
  throw new Error(
    `registry 已有 ${PKG_NAME}@${version}，但與本地 tgz 不一致（${cmp.how}；本地 ${local.integrity}）。` +
    '不覆寫已發布版本：請改用新版本號重新發版。'
  );
}

function compareSemver(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// 有限退避：registry 寫入到可讀有延遲，但不無限等（總長約 2 分鐘）。
function backoffDelays(attempts) {
  const out = [];
  for (let i = 0; i < attempts - 1; i++) out.push(Math.min(2000 * Math.pow(2, i), 30000));
  return out;
}

// ── 外部互動 ──────────────────────────────────────────────────────────────

function run(cmd, args, opts) {
  let bin = cmd;
  let finalArgs = args;
  // 直接用 Node 執行 npm CLI，避免 Windows .cmd 必須透過 shell 解譯參數。
  if (process.platform === 'win32' && cmd === 'npm') {
    const candidates = [process.env.npm_execpath,
      path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
      ...(process.env.PATH || '').split(path.delimiter).map(p => path.join(p, 'node_modules/npm/bin/npm-cli.js'))];
    const cli = candidates.find(p => p && /npm-cli\.js$/.test(p) && fs.existsSync(p));
    if (!cli) throw new Error('找不到 npm CLI，請確認 Node/npm 安裝完整');
    bin = process.execPath;
    finalArgs = [cli, ...args];
  }
  const r = spawnSync(bin, finalArgs, Object.assign({ encoding: 'utf8', shell: false }, opts));
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} 失敗（exit ${r.status}）：\n${r.stdout || ''}${r.stderr || ''}`);
  }
  return (r.stdout || '').trim();
}

function readPackage() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
}

function localDigests(tarball) {
  const buffer = fs.readFileSync(tarball);
  return { integrity: integrityOf(buffer), shasum: shasumOf(buffer), bytes: buffer.length };
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  console.log(`${name}=${value}`);
}

async function fetchPackument() {
  const res = await fetch(`${REGISTRY}/${PKG_NAME}`, {
    signal: AbortSignal.timeout(15000),
    headers: { accept: 'application/json', 'cache-control': 'no-cache' }
  });
  if (res.status === 404) return { versions: {}, 'dist-tags': {} };
  if (!res.ok) throw new Error(`讀取 registry packument 失敗：HTTP ${res.status}`);
  return res.json();
}

// ── 唯讀 smoke：對「真的裝起來的那份 package」啟動 stdio 伺服器 ──────────────
// 不需要真權杖：伺服器指向本機 loopback stub（傳輸層允許 loopback http）。

function stubPayloadFor(pathname) {
  if (pathname.endsWith('/tickets')) return { items: [], nextCursor: null };
  if (pathname.endsWith('/meta')) return { types: [], priorities: [], statuses: [] };
  if (pathname.endsWith('/members')) return { items: [] };
  if (pathname.endsWith('/versions')) return { items: [] };
  if (pathname.endsWith('/stats')) return { counts: {} };
  if (pathname.endsWith('/workflow')) return { rules: [] };
  return null;
}

function startStub() {
  const server = http.createServer(function (req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const payload = stubPayloadFor(url.pathname);
    res.writeHead(payload === null ? 404 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload === null ? { error: { code: 'not_found', message: url.pathname } } : { data: payload }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function startClient(serverPath, baseUrl) {
  const child = spawn(process.execPath, [serverPath], {
    env: Object.assign({}, process.env, {
      LTJ_API_URL: baseUrl,
      LTJ_API_TOKEN: SMOKE_TOKEN,
      LTJ_PROJECT: 'SMOKE',
      LTJ_MCP_ENABLE_WRITES: 'false',
      LTJ_MCP_NO_UPDATE_CHECK: '1'
    }),
    stdio: ['pipe', 'pipe', 'inherit']
  });
  const pending = new Map();
  let buffer = '';
  let nextId = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', function (chunk) {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line === '') continue;
      let message;
      try { message = JSON.parse(line); } catch (_) { continue; }
      const resolve = pending.get(message.id);
      if (resolve) { pending.delete(message.id); resolve(message); }
    }
  });
  return {
    call(method, params) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`stdio 逾時：${method}`)); }, 30000);
        pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
      });
    },
    stop() { child.kill(); }
  };
}

function resultOf(response, label) {
  if (response.error) throw new Error(`${label} 回 error：${response.error.message}`);
  if (response.result === undefined) throw new Error(`${label} 沒有 result`);
  return response.result;
}

async function smokeInstalledPackage(packageDir, version) {
  const serverPath = path.join(packageDir, 'litejira-mcp-server.js');
  for (const rel of ['litejira-mcp-launch.cjs', 'litejira-mcp-server.js', 'litejira-config.js', 'README.md']) {
    if (!fs.existsSync(path.join(packageDir, rel))) throw new Error(`安裝後缺少檔案：${rel}`);
  }
  const installed = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  if (installed.version !== version) throw new Error(`安裝到的版本是 ${installed.version}，預期 ${version}`);

  const stub = await startStub();
  const client = startClient(serverPath, `http://127.0.0.1:${stub.address().port}`);
  try {
    const init = resultOf(await client.call('initialize', { protocolVersion: '2024-11-05' }), 'initialize');
    console.log(`  initialize：${init.serverInfo.name} ${init.serverInfo.version}`);
    if (init.serverInfo.version !== version) throw new Error(`serverInfo.version ${init.serverInfo.version} 與 ${version} 不符`);
    const tools = resultOf(await client.call('tools/list'), 'tools/list').tools;
    if (!tools.some((t) => t.name === 'litejira.searchTickets')) throw new Error('tools/list 缺 litejira.searchTickets');
    const prompts = resultOf(await client.call('prompts/list'), 'prompts/list').prompts;
    const meta = resultOf(await client.call('resources/read', { uri: 'litejira://meta' }), 'resources/read meta');
    JSON.parse(meta.contents[0].text);
    const search = resultOf(await client.call('tools/call',
      { name: 'litejira.searchTickets', arguments: { limit: 1 } }), 'searchTickets');
    if (search.isError) throw new Error('searchTickets 回 isError');
    console.log(`  ${tools.length} 工具 / ${prompts.length} 提示 / meta 可讀 / searchTickets 通`);
  } finally {
    client.stop();
    stub.close();
  }
}

// 隔離安裝：臨時目錄 + 自己的 package.json，絕不動到工作目錄的 node_modules。
function installIsolated(spec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltj-release-'));
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'litejira-release-smoke', version: '0.0.0', private: true }));
  run('npm', ['install', spec, '--no-audit', '--no-fund', '--ignore-scripts', '--registry', REGISTRY], { cwd: dir });
  const packageDir = path.join(dir, 'node_modules', PKG_NAME);
  const bin = path.join(dir, 'node_modules', '.bin', 'litejira-mcp');
  if (!fs.existsSync(bin) && !fs.existsSync(bin + '.cmd')) throw new Error('安裝後沒有 litejira-mcp bin');
  return packageDir;
}

// ── 模式 ──────────────────────────────────────────────────────────────────

function cmdPreflight(args) {
  const pkg = readPackage();
  const version = assertTagMatchesPackage(args.tag, pkg);
  if (Object.keys(pkg.dependencies || {}).length > 0) throw new Error('此套件不應有 runtime dependencies');
  for (const rel of pkg.files) {
    if (!fs.existsSync(path.join(__dirname, '..', rel))) throw new Error(`package.json files 列了不存在的檔案：${rel}`);
  }
  const head = run('git', ['rev-parse', 'HEAD']);
  const tagHead = run('git', ['rev-parse', '--verify', `refs/tags/${args.tag}^{commit}`]);
  if (head !== tagHead) throw new Error(`HEAD 不是 ${args.tag} 指向的 commit，拒絕發版`);
  run('git', ['fetch', '--no-tags', 'origin', 'main']);
  const merged = spawnSync('git', ['merge-base', '--is-ancestor', head, 'FETCH_HEAD']);
  if (merged.status !== 0) throw new Error(`tag ${args.tag} 的 commit ${head} 不在 origin/main 上，拒絕發版`);
  console.log(`preflight 通過：${args.tag} → ${version}（commit ${head} 在 origin/main）`);
  setOutput('version', version);
}

async function cmdPackVerify(args) {
  const version = assertTagMatchesPackage(args.tag, readPackage());
  const local = localDigests(args.tarball);
  console.log(`tgz ${path.basename(args.tarball)}：${local.bytes} bytes ${local.integrity}`);
  await smokeInstalledPackage(installIsolated(path.resolve(args.tarball)), version);
  console.log('pack-verify 通過：打包後真的裝得起來、啟得動、讀得到');
  setOutput('integrity', local.integrity);
}

async function cmdPublishPrecheck(args) {
  const version = assertTagMatchesPackage(args.tag, readPackage());
  const npmVersion = run('npm', ['--version']);
  if (compareSemver(npmVersion, MIN_NPM) < 0) {
    throw new Error(`npm ${npmVersion} 太舊；trusted publisher / provenance 需要 >= ${MIN_NPM}`);
  }
  console.log(`npm ${npmVersion}（>= ${MIN_NPM}）`);
  const decision = decidePublish({ version, packument: await fetchPackument(), local: localDigests(args.tarball) });
  console.log(decision.reason);
  setOutput('should-publish', decision.publish ? 'true' : 'false');
}

async function cmdRegistryVerify(args) {
  const version = assertTagMatchesPackage(args.tag, readPackage());
  const local = localDigests(args.tarball);
  const delays = backoffDelays(8);
  let lastError = '';
  for (let attempt = 0; ; attempt++) {
    try {
      const packument = await fetchPackument();
      const entry = (packument.versions || {})[version];
      if (!entry) throw new Error(`registry 還沒有 ${version}`);
      const cmp = compareDist(entry.dist, local);
      if (!cmp.same) throw new Error(`registry 的 ${version} 與本地 tgz 不一致（${cmp.how}；本地 ${local.integrity}）`);
      const latest = (packument['dist-tags'] || {}).latest;
      if (!latest || compareSemver(latest, version) < 0) throw new Error(`dist-tags.latest 是 ${latest}，預期至少 ${version}`);
      console.log(`registry 一致：${version} = ${local.integrity}，latest=${latest}`);
      break;
    } catch (err) {
      lastError = err.message;
      if (attempt >= delays.length) throw new Error(`registry 確認失敗（${attempt + 1} 次）：${lastError}`);
      console.log(`  等待 registry（${attempt + 1}）：${lastError}`);
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  await smokeInstalledPackage(installIsolated(`${PKG_NAME}@${version}`), version);
  console.log('registry-verify 通過：公開安裝後真的啟得動');
}

function parseArgs(argv) {
  const out = { mode: argv[0] };
  for (let i = 1; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  args.tag = args.tag || process.env.RELEASE_TAG;
  const modes = {
    preflight: cmdPreflight,
    'pack-verify': cmdPackVerify,
    'publish-precheck': cmdPublishPrecheck,
    'registry-verify': cmdRegistryVerify,
    'smoke-dir': async (a) => smokeInstalledPackage(path.resolve(a.dir), assertTagMatchesPackage(a.tag, readPackage()))
  };
  const fn = modes[args.mode];
  if (!fn) throw new Error(`未知模式 ${args.mode}；可用：${Object.keys(modes).join(' / ')}`);
  if (['pack-verify', 'publish-precheck', 'registry-verify'].includes(args.mode) && !args.tarball) {
    throw new Error(`${args.mode} 需要 --tarball`);
  }
  await fn(args);
}

module.exports = {
  parseReleaseTag,
  assertTagMatchesPackage,
  integrityOf,
  shasumOf,
  compareDist,
  decidePublish,
  compareSemver,
  backoffDelays,
  smokeInstalledPackage,
  MIN_NPM
};

if (require.main === module) {
  main().catch(function (err) {
    console.error('release-verify 失敗：' + err.message);
    process.exit(1);
  });
}
