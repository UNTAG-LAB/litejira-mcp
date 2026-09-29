'use strict';

// `litejira-mcp setup [prod|dev]`：在終端機輸入 PAT，驗證後寫入 ~/.litejira/credentials*.env。
//
// 設計重點：
//   * token 絕不出現在 argv、stdout、錯誤訊息或任何 log —— 只讀進記憶體、驗證、寫進 0600 的檔案。
//   * 先驗證再保存：token 打錯就不動既有憑證（避免把本來能用的設定蓋掉）。
//   * 只問 token：站台與專案由 litejira-config 的預設裁決（正式站 + 主專案 MAIN）。
//   * 既有檔案採「就地更新」：不認得的行原樣保留，其他既有鍵也不動。

const fs = require('fs');
const path = require('path');
const os = require('os');

const { callV1 } = require('./litejira-v1-transport');
const {
  CREDENTIAL_KEYS,
  OFFICIAL_API_URL,
  isLegacyOfficialUrl,
  resolveSettings
} = require('./litejira-config');

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

function printHelp(write) {
  write('用法：litejira-mcp setup [prod|dev]\n');
  write('\n');
  write('  在終端機輸入你的 LiteJira PAT（輸入時不顯示），驗證成功後寫入 ~/.litejira/。\n');
  write('  不帶參數 → credentials.env（`litejira-mcp` 預設讀這個）\n');
  write('  prod / dev → credentials.prod.env / credentials.dev.env（`litejira-mcp prod|dev` 讀）\n');
  write('\n');
  write('  只會問 token：站台預設 ' + OFFICIAL_API_URL + '，專案預設 MAIN。\n');
  write('  已設定的 LTJ_API_URL / LTJ_PROJECT（環境變數或憑證檔）一律保留，不會被覆蓋；\n');
  write('  唯一例外是已退役的舊正式站網址 —— 會自動改用新正式站，並在驗證成功後更新憑證檔。\n');
  write('  token 不需要、也不應該貼進 AI 對話視窗。\n');
}

async function runSetup(argv, options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  const stdin = opts.stdin || process.stdin;
  const dir = opts.dir || CRED_DIR;
  const args = Array.isArray(argv) ? argv.slice() : [];

  const target = (args[0] || '').toLowerCase();
  if (target === '--help' || target === '-h' || target === 'help') {
    printHelp(function (line) { stdout.write(line); });
    return 0;
  }
  if (target && target !== 'prod' && target !== 'dev') {
    stderr.write('無法辨識的參數「' + args[0] + '」；只接受 prod 或 dev。\n');
    printHelp(function (line) { stderr.write(line); });
    return 2;
  }

  const resolved = resolveTargetFile(target, dir);
  const existing = readCredFile(resolved.file);

  // 憑證檔的既有值補進環境再解析：這樣顯示出來的站台 / 專案就是之後真正會生效的那組。
  const effectiveEnv = Object.assign({}, existing.values, pickEnv_(env));
  if (env.LTJ_API_TOKEN || env.LTJ_API_PAT) effectiveEnv.LTJ_API_TOKEN = env.LTJ_API_TOKEN || env.LTJ_API_PAT;
  const settings = resolveSettings(effectiveEnv);

  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    stderr.write(
      'setup 需要互動式終端機（TTY）才能安全地接收 token。\n' +
      '偵測到目前不是 TTY（例如被管線接走、在 CI 或由 AI 工具代跑）。\n' +
      '請自己開一個終端機執行：litejira-mcp setup' + (target ? ' ' + target : '') + '\n' +
      '（不想互動時，也可以自行建立 ' + resolved.file + '，內容一行：LTJ_API_TOKEN=<你的 PAT>）\n'
    );
    return 2;
  }

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
    return 2;
  }
  if (!settings.project) {
    stderr.write('自訂站台沒有內建預設專案；請先在憑證檔設定 LTJ_PROJECT=<專案 key> 再執行 setup。\n');
    return 2;
  }
  const hasExistingToken = !!settings.token;
  if (hasExistingToken) {
    stdout.write('  偵測到既有 token：直接按 Enter 可沿用並重新驗證。\n');
  }
  if (env.LTJ_API_TOKEN || env.LTJ_API_PAT) {
    stdout.write('  注意：目前環境變數已有 token，執行時會優先於憑證檔；按 Enter 沿用會將它保存至本機。\n');
  }
  stdout.write('  PAT 請從 LiteJira 網站取得；不要貼進 AI 對話視窗。\n');

  let token;
  try {
    const entered = await promptSecret('請貼上 PAT（輸入不顯示）：', { input: stdin, output: stdout });
    token = entered.trim() || (hasExistingToken ? settings.token : '');
  } catch (err) {
    if (err && err.cancelled) {
      stderr.write('已取消，未變更任何憑證。\n');
      return 130;
    }
    throw err;
  }
  if (!token) {
    stderr.write('沒有輸入 token，未變更任何憑證。\n');
    return 2;
  }

  stdout.write('驗證中…（讀取 ' + settings.project + ' 專案設定）\n');
  try {
    await verifyToken(settings, token, opts);
  } catch (err) {
    // 錯誤訊息一律來自傳輸層，不含 token 本身。
    stderr.write('驗證失敗：' + (err && (err.code ? err.code + ': ' : '') + (err.message || String(err))) + '\n');
    stderr.write('未變更任何憑證。請確認 PAT 正確且尚未過期後重試。\n');
    return 1;
  }

  // 驗證成功才寫檔，而且遷移後的網址要一起落地 —— 否則下次啟動讀到的還是舊網址，
  // 每次都得靠執行期再遷移一遍（而 setup 明明已經確認過新網址可用）。
  const updates = { LTJ_API_TOKEN: token };
  if (settings.migratedFromLegacy) updates.LTJ_API_URL = settings.apiUrl;
  writeCredFile(resolved.file, mergeCredText(existing.lines, updates));
  stdout.write('✅ 已驗證並寫入本機 ' + resolved.file + '。\n');
  if (settings.migratedFromLegacy) {
    stdout.write('   已將站台從舊正式站網址更新為 ' + settings.apiUrl + '（舊網址已退役）。\n');
    if (isLegacyOfficialUrl(env.LTJ_API_URL)) {
      stdout.write('   注意：環境變數 LTJ_API_URL 仍是舊網址，執行時會優先於憑證檔；請一併更新或移除它。\n');
    }
  }
  stdout.write('   站台 ' + settings.apiUrl + '、專案 ' + settings.project + '；實際可讀寫的範圍仍以你在 LiteJira 的權限為準。\n');
  stdout.write('   接著在 AI 工具註冊 MCP：command 填 litejira-mcp' + (target ? '、args 填 ["' + target + '"]' : '') + '。\n');
  return 0;
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
  credFileCandidates,
  mergeCredText,
  readCredFile,
  resolveTargetFile,
  runSetup
};
