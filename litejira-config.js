'use strict';

// 共用設定解析：launcher / server / ltj-cli 三個進入點都走這裡，
// 讓「只有一把 token」也能直接讀寫正式站的主專案。
//
// 規則（precedence 由高到低）：
//   1. 呼叫端明給的參數（工具的 project、URI 的 ?project=）—— 不在本模組處理
//   2. 環境變數 / credentials 檔（LTJ_API_URL、LTJ_PROJECT、…）
//   3. 本模組的內建預設
//
// 內建預設只在「正式站」成立：正式站 litejira.untaglab.com 目前只有一個主專案 MAIN，
// 所以省略專案時補 MAIN 是安全的。自訂站點我們不知道它有哪些專案，
// 補 MAIN 只會把工單投到錯的地方，因此自訂站一律維持「沒設就明確報錯」。

const OFFICIAL_API_URL = 'https://litejira.untaglab.com';
const OFFICIAL_DEFAULT_PROJECT = 'MAIN';

// credentials 檔允許的鍵（launcher 與 setup 共用同一份白名單）。
const CREDENTIAL_KEYS = Object.freeze([
  'LTJ_API_URL',
  'LTJ_API_TOKEN',
  'LTJ_API_PAT',
  'LTJ_MCP_ENABLE_WRITES',
  'LTJ_PROJECT',
  'LTJ_MCP_MAX_UPLOAD_BYTES'
]);

// 只比對 origin：路徑、結尾斜線、大小寫、預設埠都不該影響「這是不是正式站」的判斷。
function isOfficialUrl(raw) {
  if (!raw) return false;
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch (_) {
    return false;
  }
  const official = new URL(OFFICIAL_API_URL);
  return url.protocol === official.protocol && url.host.toLowerCase() === official.host.toLowerCase();
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
  const rawUrl = String(runtimeEnv.LTJ_API_URL || '').trim();
  const rawProject = String(runtimeEnv.LTJ_PROJECT || '').trim();

  const apiUrl = rawUrl || OFFICIAL_API_URL;
  const official = isOfficialUrl(apiUrl);

  let project = rawProject;
  let projectSource = rawProject ? 'env' : 'none';
  if (!project && official) {
    project = OFFICIAL_DEFAULT_PROJECT;
    projectSource = 'default';
  }

  const writes = resolveEnableWrites(runtimeEnv.LTJ_MCP_ENABLE_WRITES);

  return {
    apiUrl: apiUrl,
    apiUrlSource: rawUrl ? 'env' : 'default',
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
// 只補「原本沒有」的鍵，既有值一律不動。
function applyDefaults(env) {
  const target = env || process.env;
  const settings = resolveSettings(target);
  if (settings.apiUrlSource === 'default') target.LTJ_API_URL = settings.apiUrl;
  if (settings.projectSource === 'default') target.LTJ_PROJECT = settings.project;
  return settings;
}

module.exports = {
  CREDENTIAL_KEYS,
  OFFICIAL_API_URL,
  OFFICIAL_DEFAULT_PROJECT,
  applyDefaults,
  isOfficialUrl,
  resolveEnableWrites,
  resolveSettings
};
