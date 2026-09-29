'use strict';

// 共用設定解析：launcher / server / ltj-cli 三個進入點都走這裡，
// 讓「只有一把 token」也能直接讀寫正式站的主專案。
//
// 規則（precedence 由高到低）：
//   1. 呼叫端明給的參數（工具的 project、URI 的 ?project=）—— 不在本模組處理
//   2. 環境變數 / credentials 檔（LTJ_API_URL、LTJ_PROJECT、…）
//   3. 本模組的內建預設（含「舊正式站網址 → 新正式站」的遷移）
//
// 內建預設只在「正式站」成立：正式站 litejira.untaglab.com 目前只有一個主專案 MAIN，
// 所以省略專案時補 MAIN 是安全的。自訂站點我們不知道它有哪些專案，
// 補 MAIN 只會把工單投到錯的地方，因此自訂站一律維持「沒設就明確報錯」。

const OFFICIAL_API_URL = 'https://litejira.untaglab.com';
const OFFICIAL_DEFAULT_PROJECT = 'MAIN';

// 舊正式站：LiteJira 1.x 時期正式站是一個 Apps Script 部署，很多人的 credentials 檔
// 至今還留著那個網址。留著會有兩個後果：連到已退役的站台、而且因為「不是正式站」而
// 不套用 MAIN 預設，於是 setup 在問 token 之前就先要求 LTJ_PROJECT。
//
// 遷移只對「確認過的那幾個 deployment」成立 —— 這是 allowlist，不是「所有 GAS 網址」：
// 別人自架的 Apps Script 站台與我們無關，把它改寫成正式站等於把工單送到別人的系統。
// 下面這個 deployment id 由 ProjectLiteJira 的正式部署設定確認。
const LEGACY_OFFICIAL_API_URLS = Object.freeze([
  'https://script.google.com/macros/s/AKfycbxIDAs2fsZyyypMoDgbzI9PMcJFpGB0WwXZEj-mNg-CbWtOQay1if9jwvcnaDBsGI8b/exec'
]);

// 認得出「這是 Apps Script 站台」的 host：不在 allowlist 時不猜、不遷移，
// 只用來把訊息講清楚（你連的還是舊 GAS 站，請確認 / 更新站台），而不是叫人去補 LTJ_PROJECT。
const LEGACY_GAS_HOSTS = Object.freeze(['script.google.com', 'script.googleusercontent.com']);

// credentials 檔允許的鍵（launcher 與 setup 共用同一份白名單）。
const CREDENTIAL_KEYS = Object.freeze([
  'LTJ_API_URL',
  'LTJ_API_TOKEN',
  'LTJ_API_PAT',
  'LTJ_MCP_ENABLE_WRITES',
  'LTJ_PROJECT',
  'LTJ_MCP_MAX_UPLOAD_BYTES'
]);

// credentials 檔常被當成 shell 片段編輯，值兩側可能包著成對的單 / 雙引號。
// 不脫引號的話 `LTJ_API_URL="https://…"` 會連 URL 都 parse 不出來，於是被當成「自訂站台」。
// 只脫「成對」的引號：值裡本來就有引號（單邊、不成對）一律原樣保留。
function unquoteValue(raw) {
  const value = String(raw === undefined || raw === null ? '' : raw).trim();
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1).trim();
  return value;
}

function parseUrl_(raw) {
  const value = unquoteValue(raw);
  if (!value) return null;
  try {
    return new URL(value);
  } catch (_) {
    return null;
  }
}

// 路徑比對用：結尾斜線不該改變「是不是同一個 deployment」的判斷。
function normalizePath_(pathname) {
  return pathname.replace(/\/+$/, '') || '/';
}

// 只比對 origin：路徑、結尾斜線、大小寫、預設埠都不該影響「這是不是正式站」的判斷。
function isOfficialUrl(raw) {
  const url = parseUrl_(raw);
  if (!url) return false;
  const official = new URL(OFFICIAL_API_URL);
  return url.protocol === official.protocol && url.host.toLowerCase() === official.host.toLowerCase();
}

// 舊正式站則相反：要比對到 path 全等。GAS 的 host 是所有人共用的，
// 只看 host 就遷移會把別人的 Apps Script 站台一起改寫掉。
function isLegacyOfficialUrl(raw) {
  const url = parseUrl_(raw);
  if (!url) return false;
  return LEGACY_OFFICIAL_API_URLS.some(function (legacy) {
    const known = new URL(legacy);
    return url.protocol === known.protocol
      && url.host.toLowerCase() === known.host.toLowerCase()
      && normalizePath_(url.pathname) === normalizePath_(known.pathname);
  });
}

// 「看起來是 Apps Script 站台」：僅供訊息使用，不影響任何遷移決策。
function isLegacyGasHost(raw) {
  const url = parseUrl_(raw);
  if (!url) return false;
  return LEGACY_GAS_HOSTS.indexOf(url.host.toLowerCase()) !== -1;
}

// 寫入開關：未設 → 預設開啟（同仁裝完就能寫）；'false' → 唯讀；
// 其他值一律 fail closed —— 打錯字（'ture'、'1'、'yes'）不該被當成「開啟」，
// 但也不能靜默當成 false，所以額外回報 invalid 讓呼叫端可以講清楚。
function resolveEnableWrites(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { enableWrites: true, invalid: false, raw: '' };
  }
  const value = String(raw).trim().toLowerCase();
  if (value === 'true') return { enableWrites: true, invalid: false, raw: String(raw) };
  if (value === 'false') return { enableWrites: false, invalid: false, raw: String(raw) };
  return { enableWrites: false, invalid: true, raw: String(raw) };
}

// 從環境解析出「實際要用的」站台 / 專案 / 寫入開關，並記錄各自來自哪裡。
function resolveSettings(env) {
  const runtimeEnv = env || process.env;
  const rawUrl = unquoteValue(runtimeEnv.LTJ_API_URL);
  const rawProject = unquoteValue(runtimeEnv.LTJ_PROJECT);

  // 舊正式站的網址一律當成「正式站」處理：實際連線走新網址，專案預設也跟著成立。
  let apiUrl;
  let apiUrlSource;
  let legacyApiUrl = '';
  if (!rawUrl) {
    apiUrl = OFFICIAL_API_URL;
    apiUrlSource = 'default';
  } else if (isLegacyOfficialUrl(rawUrl)) {
    apiUrl = OFFICIAL_API_URL;
    apiUrlSource = 'migrated';
    legacyApiUrl = rawUrl;
  } else {
    apiUrl = rawUrl;
    apiUrlSource = 'env';
  }

  const official = isOfficialUrl(apiUrl);
  // 不在 allowlist 的 GAS 網址：維持原樣（不猜），但標記出來讓呼叫端能講清楚問題在站台。
  const unknownLegacyGas = apiUrlSource === 'env' && isLegacyGasHost(apiUrl);

  let project = rawProject;
  let projectSource = rawProject ? 'env' : 'none';
  if (!project && official) {
    project = OFFICIAL_DEFAULT_PROJECT;
    projectSource = 'default';
  }

  const writes = resolveEnableWrites(runtimeEnv.LTJ_MCP_ENABLE_WRITES);

  return {
    apiUrl: apiUrl,
    apiUrlSource: apiUrlSource,
    migratedFromLegacy: apiUrlSource === 'migrated',
    legacyApiUrl: legacyApiUrl,
    isUnknownLegacyGas: unknownLegacyGas,
    isOfficial: official,
    project: project,
    projectSource: projectSource,
    token: runtimeEnv.LTJ_API_TOKEN || runtimeEnv.LTJ_API_PAT || '',
    enableWrites: writes.enableWrites,
    enableWritesInvalid: writes.invalid,
    enableWritesRaw: writes.raw
  };
}

// 把解析結果寫回 env（launcher 用：子行程只看得到環境變數）。
// 寫回的是「解析後真正要用的值」，不只是補缺：舊正式站網址與引號包起來的值都必須被改寫，
// 否則子行程照著環境變數連的還是舊站，遷移等於沒發生。
// 真正的既有設定（自訂站台、明給的專案）解析結果就等於原值，所以不會被動到。
function applyDefaults(env) {
  const target = env || process.env;
  const settings = resolveSettings(target);
  if (settings.apiUrl && target.LTJ_API_URL !== settings.apiUrl) target.LTJ_API_URL = settings.apiUrl;
  if (settings.project && target.LTJ_PROJECT !== settings.project) target.LTJ_PROJECT = settings.project;
  return settings;
}

module.exports = {
  CREDENTIAL_KEYS,
  LEGACY_OFFICIAL_API_URLS,
  OFFICIAL_API_URL,
  OFFICIAL_DEFAULT_PROJECT,
  applyDefaults,
  isLegacyGasHost,
  isLegacyOfficialUrl,
  isOfficialUrl,
  resolveEnableWrites,
  resolveSettings,
  unquoteValue
};
