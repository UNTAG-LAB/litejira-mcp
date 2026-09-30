'use strict';

// `litejira-mcp setup [prod|dev] [--client …]`：取得 PAT、驗證、寫入 ~/.litejira/credentials*.env，
// 並把 litejira 這個 MCP server 註冊進 AI 主機（Codex / Claude Code / Gemini）的官方設定檔。
//
// 設計重點：
//   * token 絕不出現在 argv、stdout、錯誤訊息、設定檔或任何 log ——
//     只從 --token-stdin / 環境變數 / 互動輸入讀進記憶體、驗證、寫進 0600 的檔案。
//   * 先驗證再保存：token 打錯就不動既有憑證（避免把本來能用的設定蓋掉）。
//   * 先 preflight 再動手：任何一個主機設定檔形狀不對，就在碰 token 之前整批停下來，零變更。
//   * 只問 token：站台與專案由 litejira-config 的預設裁決（正式站 + 主專案 MAIN）。
//   * 既有檔案採「就地更新」：不認得的行原樣保留，其他既有鍵也不動。
//
// 非互動（AI 代跑）路徑：`--token-stdin` 由呼叫端把 PAT 從 stdin 餵進來（有長度上限、不回音、
// 不寫進任何輸出），或是設好 LTJ_API_TOKEN 環境變數。互動路徑照舊可用。

const fs = require('fs');
const path = require('path');
const os = require('os');

const { callV1 } = require('./litejira-v1-transport');
const hosts = require('./litejira-hosts');
const {
  CREDENTIAL_KEYS,
  OFFICIAL_API_URL,
  isLegacyOfficialUrl,
  resolveSettings
} = require('./litejira-config');

// stdin 讀 token 的上限：PAT 只有幾十個字元，超過就是餵錯東西（別把一整個檔案吞進來）。
const TOKEN_STDIN_MAX_BYTES = 4096;
const TOKEN_STDIN_TIMEOUT_MS = 30000;

const CRED_DIR = path.join(os.homedir(), '.litejira');

// 與 launcher 的 resolveCredFile 同一套規則：dev/prod 各自的檔名，無參數用 credentials.*。
// 第一個存在的檔就是要更新的目標；都不存在時用陣列第一個名字建新檔。
function credFileCandidates(target) {
  return (target === 'dev' || target === 'prod')
    ? [`credentials.${target}.txt`, `credentials.${target}.env`]
    : ['credentials.env', 'credentials.txt'];
}

function resolveTargetFile(target, dir) {
  const base = dir || CRED_DIR;
  const names = credFileCandidates(target);
  for (const name of names) {
    const p = path.join(base, name);
    if (fs.existsSync(p)) return { file: p, existed: true };
  }
  return { file: path.join(base, target ? `credentials.${target}.env` : 'credentials.env'), existed: false };
}

// 解析既有檔案：回傳原始行與白名單鍵值，讓我們能就地更新而不丟掉任何一行。
function readCredFile(file) {
  if (!fs.existsSync(file)) return { lines: [], values: {} };
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const values = {};
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && CREDENTIAL_KEYS.indexOf(m[1]) !== -1) values[m[1]] = m[2];
  }
  return { lines: lines, values: values };
}

// 就地更新：既有的 KEY= 行改值，沒有的行原樣保留，缺的鍵補在最後。
function mergeCredText(lines, updates) {
  const out = lines.slice();
  const remaining = Object.assign({}, updates);
  for (let i = 0; i < out.length; i++) {
    const m = out[i].match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && Object.prototype.hasOwnProperty.call(remaining, m[1])) {
      out[i] = m[1] + '=' + remaining[m[1]];
      delete remaining[m[1]];
    }
  }
  // 補新鍵前先去掉結尾空行，否則每跑一次就在檔尾長出一行空白。
  if (Object.keys(remaining).length > 0) {
    while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
    for (const key of Object.keys(remaining)) out.push(key + '=' + remaining[key]);
  }
  if (out.length === 0 || out[out.length - 1] !== '') out.push('');
  return out.join('\n');
}

function writeCredFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
  // 檔案已存在時 writeFileSync 的 mode 不生效，所以再明確收一次權限（Windows 上會靜默失敗，可接受）。
  try { fs.chmodSync(file, 0o600); } catch (_) { /* 非 POSIX 平台略過 */ }
}

// 不回音的單行輸入。raw mode 下自己處理鍵盤，畫面只回 *，token 不進終端機捲動紀錄。
function promptSecret(question, io) {
  const input = io.input;
  const output = io.output;
  return new Promise(function (resolve, reject) {
    output.write(question);
    let value = '';
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    function cleanup() {
      input.removeListener('data', onData);
      input.setRawMode(!!wasRaw);
      input.pause();
    }

    function onData(chunk) {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          output.write('\n');
          resolve(value);
          return;
        }
        if (ch === '') {           // Ctrl+C：視為取消，不寫任何檔案
          cleanup();
          output.write('\n');
          reject(Object.assign(new Error('cancelled'), { cancelled: true }));
          return;
        }
        if (ch === '' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        if (ch < ' ') continue;          // 其他控制字元忽略
        value += ch;
        output.write('*');
      }
    }

    input.on('data', onData);
  });
}

// 用 getMeta 驗證：唯讀、一定要有專案，剛好也順便確認「這把 token 看得到這個專案」。
async function verifyToken(settings, token, deps) {
  const fetchFn = (deps && deps.fetch) || globalThis.fetch;
  await callV1({
    fetch: fetchFn,
    baseUrl: settings.apiUrl,
    token: token,
    action: 'getMeta',
    params: { project: settings.project }
  });
}

// 從 stdin 讀一行 token：有位元組上限與逾時，讀到就停，全程不回音、不記錄。
function readTokenFromStdin(stdin, options) {
  const opts = options || {};
  const maxBytes = opts.maxBytes || TOKEN_STDIN_MAX_BYTES;
  const timeoutMs = opts.timeoutMs || TOKEN_STDIN_TIMEOUT_MS;
  return new Promise(function (resolve, reject) {
    let buffer = '';
    let done = false;
    const timer = setTimeout(function () {
      finish(function () { reject(new Error('--token-stdin 等待逾時（' + timeoutMs + 'ms）：stdin 沒有送進 token。')); });
    }, timeoutMs);
    if (timer.unref) timer.unref();

    function finish(then) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
      try { stdin.pause(); } catch (_) { /* ignore */ }
      then();
    }
    function onData(chunk) {
      buffer += chunk.toString('utf8');
      if (buffer.length > maxBytes) {
        finish(function () { reject(new Error('--token-stdin 收到超過 ' + maxBytes + ' 位元組：這不像一把 PAT，已中止且未變更任何設定。')); });
        return;
      }
      const nl = buffer.search(/[\r\n]/);
      if (nl !== -1) {
        const value = buffer.slice(0, nl);
        finish(function () { resolve(value); });
      }
    }
    function onEnd() { finish(function () { resolve(buffer); }); }
    function onError(err) { finish(function () { reject(err); }); }

    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
    try { stdin.resume(); } catch (_) { /* ignore */ }
  });
}

// CLI 參數解析。回傳 { ok, options } 或 { ok:false, message }。
function parseSetupArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const parsed = {
    target: '',
    client: '',
    tokenStdin: false,
    json: false,
    register: true,
    verify: true,
    help: false
  };
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '--help' || arg === '-h' || arg === 'help') { parsed.help = true; continue; }
    if (arg === '--token-stdin') { parsed.tokenStdin = true; continue; }
    if (arg === '--json') { parsed.json = true; continue; }
    if (arg === '--no-register') { parsed.register = false; continue; }
    if (arg === '--no-verify') { parsed.verify = false; continue; }
    if (arg === '--client' || arg.startsWith('--client=')) {
      const value = arg === '--client' ? args[++i] : arg.slice('--client='.length);
      if (!value) return { ok: false, message: '--client 後面要接 codex / claude / gemini / auto。' };
      parsed.client = String(value).toLowerCase();
      if (parsed.client !== 'auto' && hosts.knownClients().indexOf(parsed.client) === -1) {
        return { ok: false, message: '不認得的 --client「' + value + '」；只接受 ' + hosts.knownClients().join(' / ') + ' / auto。' };
      }
      continue;
    }
    const lower = arg.toLowerCase();
    if (lower === 'prod' || lower === 'dev') { parsed.target = lower; continue; }
    return { ok: false, message: '無法辨識的參數「' + arg + '」；只接受 prod / dev 與 --client / --token-stdin / --json / --no-register / --no-verify。' };
  }
  return { ok: true, options: parsed };
}

function printHelp(write) {
  write('用法：litejira-mcp setup [prod|dev] [--client codex|claude|gemini|auto] [--token-stdin] [--json]\n');
  write('\n');
  write('  取得 PAT → 連線驗證 → 寫入 ~/.litejira/ → 註冊進 AI 主機的 MCP 設定檔。\n');
  write('  不帶參數 → credentials.env（`litejira-mcp` 預設讀這個）\n');
  write('  prod / dev → credentials.prod.env / credentials.dev.env（`litejira-mcp prod|dev` 讀）\n');
  write('\n');
  write('  --client   要註冊的主機；auto（預設）= 偵測已安裝的 ~/.codex、~/.claude.json、~/.gemini。\n');
  write('  --token-stdin  從 stdin 讀一行 PAT（非互動；token 不進 argv、不進輸出）。\n');
  write('  --json     輸出結構化結果（configured / stdioVerified / hostReloadRequired）。\n');
  write('  --no-register / --no-verify  只存憑證 / 跳過啟動驗證。\n');
  write('\n');
  write('  只會問 token：站台預設 ' + OFFICIAL_API_URL + '，專案預設 MAIN。\n');
  write('  已設定的 LTJ_API_URL / LTJ_PROJECT（環境變數或憑證檔）一律保留，不會被覆蓋；\n');
  write('  唯一例外是已退役的舊正式站網址 —— 會自動改用新正式站，並在驗證成功後更新憑證檔。\n');
  write('  token 不需要、也不應該貼進 AI 對話視窗。\n');
}

async function runSetup(argv, options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const resultStream = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  // --json 時人看的進度全部改走 stderr，stdout 只留那一份 JSON（見下方 emit）。
  let stdout = resultStream;
  const stdin = opts.stdin || process.stdin;
  const dir = opts.dir || CRED_DIR;

  const parsedArgs = parseSetupArgs(argv);
  if (!parsedArgs.ok) {
    stderr.write(parsedArgs.message + '\n');
    printHelp(function (line) { stderr.write(line); });
    return 2;
  }
  const cli = parsedArgs.options;
  if (cli.help) {
    printHelp(function (line) { stdout.write(line); });
    return 0;
  }
  const target = cli.target;
  const wantRegister = cli.register && opts.register !== false;
  const report = {
    ok: false,
    package: { name: 'litejira-mcp', version: require('./package.json').version },
    target: target || 'default',
    credentialsFile: null,
    clients: [],
    hostReloadRequired: true,
    hostReloadNote: 'setup 無法替你重載 AI 主機；Codex / Claude Code / Gemini 何時重讀設定不在本工具掌握範圍，'
      + '請依該主機的方式重連或重啟後再使用 litejira 工具。'
  };
  // --json 的 stdout 必須是「一份、可直接 JSON.parse 的輸出」：人看的進度一律走 stderr。
  // 混著印會讓呼叫端得先切字串才讀得到結果，那正是自動化最容易出錯的地方。
  if (cli.json) stdout = stderr;
  const emit = function (code) {
    if (cli.json) resultStream.write(JSON.stringify(report, null, 2) + '\n');
    return code;
  };

  // 目標主機先決定：auto 偵測不到就明確失敗，不假裝成功。
  const ctx = hosts.makeContext({ env: env, cwd: opts.cwd, home: opts.home });
  let clients = [];
  if (wantRegister) {
    clients = (cli.client && cli.client !== 'auto') ? [cli.client] : hosts.detectClients(ctx);
    if (clients.length === 0) {
      report.error = 'no_host_detected';
      report.message = '找不到任何已安裝的 AI 主機設定目錄（~/.codex 或 CODEX_HOME、~/.claude.json、~/.gemini）。'
        + '未變更任何設定；請用 --client codex|claude|gemini 明確指定要註冊哪一個。';
      stderr.write(report.message + '\n');
      return emit(2);
    }
  }

  const resolved = resolveTargetFile(target, dir);
  const existing = readCredFile(resolved.file);

  // 憑證檔的既有值補進環境再解析：這樣顯示出來的站台 / 專案就是之後真正會生效的那組。
  const effectiveEnv = Object.assign({}, existing.values, pickEnv_(env));
  if (env.LTJ_API_TOKEN || env.LTJ_API_PAT) effectiveEnv.LTJ_API_TOKEN = env.LTJ_API_TOKEN || env.LTJ_API_PAT;
  const settings = resolveSettings(effectiveEnv);

  report.credentialsFile = resolved.file;
  const envToken = (env.LTJ_API_TOKEN || env.LTJ_API_PAT || '').trim();
  const interactive = !!stdin.isTTY && typeof stdin.setRawMode === 'function';
  const savedToken = (existing.values.LTJ_API_TOKEN || '').trim();
  // token 來源：明講的 --token-stdin > 環境變數 > 互動輸入 > 既有憑證檔裡那把。
  // 最後一項是升級舊設定的主要路徑：既然本機已經有一把能用的 PAT，
  // 就不該為了重寫設定檔去要求使用者再貼一次 token（那反而增加外洩機會）。
  const tokenSource = cli.tokenStdin
    ? 'stdin'
    : (envToken ? 'env' : (interactive ? 'prompt' : (savedToken ? 'existing' : 'none')));
  if (tokenSource === 'none') {
    report.error = 'no_token_source';
    report.message = 'setup 沒有可用的 token 來源，本機憑證檔裡也沒有既有的 PAT。'
      + '非互動情境請用 `litejira-mcp setup --token-stdin`（把 PAT 從 stdin 餵一行進來），'
      + '或設好 LTJ_API_TOKEN 環境變數；在終端機直接執行則會互動詢問。未變更任何設定。';
    stderr.write(report.message + '\n');
    return emit(2);
  }
  report.tokenSource = tokenSource;

  stdout.write('LiteJira MCP 設定\n');
  stdout.write('  站台：' + settings.apiUrl +
    (settings.apiUrlSource === 'default' ? '（預設正式站）'
      : settings.migratedFromLegacy ? '（已自動改用新正式站）' : '（沿用既有設定）') + '\n');
  if (settings.migratedFromLegacy) {
    stdout.write('  ↳ 既有設定是已退役的舊正式站網址（Apps Script）：' + settings.legacyApiUrl + '\n');
    stdout.write('  ↳ 本次改用新正式站網址驗證；驗證成功後會一併更新憑證檔裡的 LTJ_API_URL。\n');
  }
  stdout.write('  專案：' + (settings.project || '（未設定）') +
    (settings.projectSource === 'default' ? '（正式站預設主專案）'
      : settings.projectSource === 'env' ? '（沿用既有設定）' : '') + '\n');
  stdout.write('  憑證檔：' + resolved.file + '\n');
  // 不在 allowlist 的 GAS 網址：問題出在站台本身，不是少了 LTJ_PROJECT。
  // 這裡不猜也不改寫（可能是別人自架的部署），只把狀況講清楚讓人自己決定。
  if (settings.isUnknownLegacyGas && !settings.project) {
    stderr.write(
      '目前設定的站台仍是 Apps Script（GAS）網址：' + settings.apiUrl + '\n' +
      '這不是我們認得的舊正式站部署，所以不會自動遷移（貿然改寫可能把資料送到別人的系統）。\n' +
      '請確認這個站台是否仍在使用：若你要用的是正式站，請把 LTJ_API_URL 改成 ' + OFFICIAL_API_URL +
      '（或把該行刪掉沿用預設）後重跑 setup；若確定要留著這個自訂站台，請另外設定 LTJ_PROJECT=<專案 key>。\n' +
      '未變更任何憑證。\n'
    );
    report.error = 'unknown_legacy_gas';
    return emit(2);
  }
  if (!settings.project) {
    stderr.write('自訂站台沒有內建預設專案；請先在憑證檔設定 LTJ_PROJECT=<專案 key> 再執行 setup。\n');
    report.error = 'missing_project';
    return emit(2);
  }

  // Preflight：先用 dry-run 走一遍所有目標設定檔。任何一個形狀有問題就在碰 token 之前停下來，
  // 這樣「設定檔壞了」不會變成「token 已寫入、但註冊只做了一半」。
  let plan = null;
  if (wantRegister) {
    plan = hosts.registerClients(clients, {
      env: env, cwd: opts.cwd, home: opts.home, target: target,
      execPath: opts.execPath, launcher: opts.launcher, dryRun: true
    });
    const blocked = collectBlocked_(plan);
    if (blocked.length > 0) {
      report.error = 'host_config_blocked';
      report.clients = plan.results;
      for (const item of blocked) stderr.write('✋ ' + item.message + '\n');
      stderr.write('未變更任何設定，也沒有動到憑證。\n');
      return emit(3);
    }
    stdout.write('  將註冊到：' + clients.join('、') + '\n');
    stdout.write('  啟動指令：' + plan.command + ' ' + plan.args.join(' ') + '\n');
  }

  const hasExistingToken = !!settings.token;
  if (tokenSource === 'prompt') {
    if (hasExistingToken) {
      stdout.write('  偵測到既有 token：直接按 Enter 可沿用並重新驗證。\n');
    }
    stdout.write('  PAT 請從 LiteJira 網站取得；不要貼進 AI 對話視窗。\n');
  }

  let token;
  if (tokenSource === 'stdin') {
    try {
      const piped = await readTokenFromStdin(stdin, opts);
      token = String(piped || '').trim();
    } catch (err) {
      stderr.write((err && err.message ? err.message : String(err)) + '\n');
      report.error = 'token_stdin_failed';
      return emit(2);
    }
  } else if (tokenSource === 'env') {
    stdout.write('  token 來源：環境變數（不會顯示，驗證成功後保存到憑證檔）。\n');
    token = envToken;
  } else if (tokenSource === 'existing') {
    stdout.write('  token 來源：本機既有憑證檔（沿用並重新驗證，不需要再貼一次 PAT）。\n');
    token = savedToken;
  } else {
    try {
      const entered = await promptSecret('請貼上 PAT（輸入不顯示）：', { input: stdin, output: stdout });
      token = entered.trim() || (hasExistingToken ? settings.token : '');
    } catch (err) {
      if (err && err.cancelled) {
        stderr.write('已取消，未變更任何憑證。\n');
        report.error = 'cancelled';
        return emit(130);
      }
      throw err;
    }
  }
  if (!token) {
    stderr.write('沒有輸入 token，未變更任何憑證。\n');
    report.error = 'empty_token';
    return emit(2);
  }

  stdout.write('驗證中…（讀取 ' + settings.project + ' 專案設定）\n');
  try {
    await verifyToken(settings, token, opts);
  } catch (err) {
    // 錯誤訊息一律來自傳輸層，不含 token 本身。
    stderr.write('驗證失敗：' + (err && (err.code ? err.code + ': ' : '') + (err.message || String(err))) + '\n');
    stderr.write('未變更任何憑證，也沒有動到任何 AI 主機設定。請確認 PAT 正確且尚未過期後重試。\n');
    report.error = 'token_verification_failed';
    return emit(1);
  }

  // 驗證成功才寫檔，而且遷移後的網址要一起落地 —— 否則下次啟動讀到的還是舊網址，
  // 每次都得靠執行期再遷移一遍（而 setup 明明已經確認過新網址可用）。
  const updates = { LTJ_API_TOKEN: token };
  if (settings.migratedFromLegacy) updates.LTJ_API_URL = settings.apiUrl;
  // 站台 / 專案如果是從「這次 shell 的環境變數」解析出來的，就得一起落地：
  // AI 主機不會繼承這個 shell，不寫下來的話 shell 一關，設定檔裡那條指令就找不到站台了。
  if (settings.apiUrlSource === 'env' && env.LTJ_API_URL && !existing.values.LTJ_API_URL) {
    updates.LTJ_API_URL = settings.apiUrl;
  }
  if (settings.projectSource === 'env' && env.LTJ_PROJECT && !existing.values.LTJ_PROJECT) {
    updates.LTJ_PROJECT = settings.project;
  }
  writeCredFile(resolved.file, mergeCredText(existing.lines, updates));
  stdout.write('✅ 已驗證並寫入本機 ' + resolved.file + '。\n');
  if (settings.migratedFromLegacy) {
    stdout.write('   已將站台從舊正式站網址更新為 ' + settings.apiUrl + '（舊網址已退役）。\n');
    if (isLegacyOfficialUrl(env.LTJ_API_URL)) {
      stdout.write('   注意：環境變數 LTJ_API_URL 仍是舊網址，執行時會優先於憑證檔；請一併更新或移除它。\n');
    }
  }
  stdout.write('   站台 ' + settings.apiUrl + '、專案 ' + settings.project + '；實際可讀寫的範圍仍以你在 LiteJira 的權限為準。\n');

  if (!wantRegister) {
    report.ok = true;
    report.registered = false;
    return emit(0);
  }

  // 真正寫入主機設定檔。preflight 已經過了，這裡只可能遇到 I/O 層面的問題。
  const applied = hosts.registerClients(clients, {
    env: env, cwd: opts.cwd, home: opts.home, target: target,
    execPath: opts.execPath, launcher: opts.launcher, dryRun: false
  });
  report.command = applied.command;
  report.args = applied.args;
  const blockedNow = collectBlocked_(applied);
  for (const item of blockedNow) stderr.write('✋ ' + item.message + '\n');
  for (const entry of applied.results) {
    for (const file of entry.files || []) {
      if (file.status === 'warning') { stderr.write('⚠️  ' + file.message + '\n'); continue; }
      if (file.status === 'blocked') continue;
      stdout.write('   ' + entry.label + '（' + file.scope + '）：' + file.status + ' → ' + file.file + '\n');
      if (file.clearedEnv && file.clearedEnv.length > 0) {
        stdout.write('     ↳ 已清掉會蓋過新設定的 env：' + file.clearedEnv.join('、') + '\n');
      }
    }
  }

  // 驗證：用「設定檔裡實際寫的那條指令」啟動一次，跑唯讀的 initialize / tools / meta / search。
  const clientReports = [];
  for (const entry of applied.results) {
    const item = {
      client: entry.client,
      label: entry.label,
      files: entry.files,
      configured: (entry.files || []).some(function (f) { return f.status === 'added' || f.status === 'replaced' || f.status === 'unchanged'; }),
      // 使用者/管理者明講停用的，不管我們寫得多漂亮都不是「可用」：不驗證，也不報成功。
      policyDisabled: (entry.files || []).some(function (f) { return f.policyDisabled === true; }),
      stdioVerified: false
    };
    clientReports.push(item);
  }
  report.clients = clientReports;

  if (cli.verify) {
    const doctor = require('./litejira-doctor');
    const redact = doctor.makeRedactor([token, envToken]);
    // 驗證用的環境要「像主機那樣乾淨」：這裡不塞 token，也不留本次 shell 的 LTJ_* ——
    // 塞了就等於自己餵答案，憑證沒存好、站台沒寫進檔案這類問題會被蓋掉，驗證變成裝飾。
    const verifyEnv = {};
    for (const key of Object.keys(env)) {
      if (/^LTJ_/.test(key)) continue;
      verifyEnv[key] = env[key];
    }
    for (const item of clientReports) {
      if (!item.configured) continue;
      if (item.policyDisabled) {
        item.verifyError = 'policy_disabled';
        stderr.write('⚠️  ' + item.label + ' 的 litejira 被明確停用，跳過啟動驗證（不能算設定成功）。\n');
        continue;
      }
      const host = hosts.HOSTS[item.client];
      const read = host.read(ctx);
      if (!read.found || !read.entry || !read.entry.command) {
        item.verifyError = 'not_readable_back';
        continue;
      }
      item.verifiedFile = read.file;
      item.verifiedScope = read.scope;
      const verified = await doctor.verifyStdio(
        { command: read.entry.command, args: read.entry.args || [], env: read.entry.env },
        { redact: redact, baseEnv: verifyEnv, timeoutMs: opts.verifyTimeoutMs }
      );
      item.stdioVerified = verified.stdioVerified;
      item.serverVersion = verified.version;
      item.checks = verified.checks;
      for (const check of verified.checks) {
        if (!check.ok) stderr.write('⚠️  ' + item.label + ' 啟動驗證未通過（' + check.name + '）：' + check.detail + '\n');
      }
      if (verified.stdioVerified) {
        stdout.write('   ✅ ' + item.label + ' 設定檔那條指令實測可啟動（v' + verified.version + '，唯讀查詢通過）。\n');
      }
    }
  }

  report.ok = blockedNow.length === 0 && clientReports.every(function (c) {
    return c.configured && !c.policyDisabled && (!cli.verify || c.stdioVerified);
  });
  // 寫檔之後才失敗的話，檔案已經被改過了（有備份）。這裡要講實話，不能沿用
  // preflight 那句「零變更」—— 那個保證只涵蓋「碰 token 之前」。
  if (!report.ok) {
    report.partiallyApplied = true;
    stderr.write('⚠️  設定檔已經寫入，但上面的檢查沒有全部通過：這不是「零變更」的狀態。\n');
    stderr.write('    每個被改過的檔案旁都有 .litejira-backup-* 備份，需要時可以還原。\n');
  }
  stdout.write('   ℹ️  ' + report.hostReloadNote + '\n');
  return emit(report.ok ? 0 : 1);
}

// 把各主機回報的 blocked 攤平，方便一次講完所有真正的阻礙。
function collectBlocked_(applied) {
  const out = [];
  for (const entry of applied.results || []) {
    if (entry.status === 'blocked') { out.push(entry); continue; }
    for (const file of entry.files || []) {
      if (file.status === 'blocked') out.push(file);
    }
  }
  return out;
}

// 只取我們認得的鍵，避免把整個 process.env 混進設定解析。
function pickEnv_(env) {
  const out = {};
  for (const key of CREDENTIAL_KEYS) {
    if (env[key] !== undefined && env[key] !== '') out[key] = env[key];
  }
  return out;
}

module.exports = {
  TOKEN_STDIN_MAX_BYTES,
  credFileCandidates,
  mergeCredText,
  parseSetupArgs,
  readCredFile,
  readTokenFromStdin,
  resolveTargetFile,
  runSetup
};
