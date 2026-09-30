'use strict';

// Codex 的 ~/.codex/config.toml 就地編輯：只動 [mcp_servers.litejira]，其他一律原樣保留。
//
// 為什麼不用正規表示式一把抓：config.toml 是使用者自己維護的檔案，裡面可能有
// 多行字串（"""…"""）、跨行陣列（args = [\n "a",\n "b"\n]）、引號表頭（["odd name"]）、
// 子表（[mcp_servers.x.env]）。單純的 regex 會把這些切錯，輕則刪掉別人的設定，
// 重則寫出一個壞掉的 config.toml（Codex 於是連一個 MCP server 都起不來）。
//
// 這裡的做法是「逐行掃描 + 狀態機」：追蹤多行字串與括號深度，只有在
// 「不在字串內、括號深度為 0」時才把一行認定為表頭。認不得的形狀一律
// 保守拒絕（回 unsupported），由呼叫端明講原因，而不是硬改。

// 掃一行，回傳掃完後的狀態。state = { multi: '"""'|"'''"|null, depth: number }
function scanLine_(line, state) {
  let multi = state.multi;
  let depth = state.depth;
  let i = 0;
  while (i < line.length) {
    if (multi) {
      if (line.startsWith(multi, i)) { multi = null; i += 3; continue; }
      i += 1;
      continue;
    }
    const ch = line[i];
    if (ch === '#') break;                     // 註解到行尾為止
    if (line.startsWith('"""', i)) { multi = '"""'; i += 3; continue; }
    if (line.startsWith("'''", i)) { multi = "'''"; i += 3; continue; }
    if (ch === '"') {                           // 單行 basic string（含跳脫）
      i += 1;
      let closed = false;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === '"') { i += 1; closed = true; break; }
        i += 1;
      }
      // 單行字串不能跨行：沒收尾就是這個檔本身壞了，別再往下猜。
      if (!closed) return { multi: multi, depth: depth, broken: true };
      continue;
    }
    if (ch === "'") {                           // 單行 literal string（無跳脫）
      i += 1;
      let closed = false;
      while (i < line.length) {
        if (line[i] === "'") { closed = true; i += 1; break; }
        i += 1;
      }
      if (!closed) return { multi: multi, depth: depth, broken: true };
      continue;
    }
    if (ch === '[' || ch === '{') { depth += 1; i += 1; continue; }
    if (ch === ']' || ch === '}') { depth -= 1; i += 1; continue; }
    i += 1;
  }
  return { multi: multi, depth: depth < 0 ? 0 : depth, broken: !!state.broken };
}

// 解析表頭內的 dotted key：支援 bare key 與引號 key。認不得回 null。
function parseKeyPath_(raw) {
  const parts = [];
  let i = 0;
  const s = raw;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i += 1;
    if (i >= s.length) return null;
    if (s[i] === '"' || s[i] === "'") {
      const quote = s[i];
      i += 1;
      let value = '';
      while (i < s.length && s[i] !== quote) {
        if (quote === '"' && s[i] === '\\') {
          const next = s[i + 1];
          if (next === 'n') value += '\n';
          else if (next === 't') value += '\t';
          else if (next === '\\') value += '\\';
          else if (next === '"') value += '"';
          else return null;                     // \uXXXX 等：保守不處理
          i += 2;
          continue;
        }
        value += s[i];
        i += 1;
      }
      if (i >= s.length) return null;
      i += 1;
      parts.push(value);
    } else {
      let value = '';
      while (i < s.length && /[A-Za-z0-9_-]/.test(s[i])) { value += s[i]; i += 1; }
      if (value === '') return null;
      parts.push(value);
    }
    while (i < s.length && /\s/.test(s[i])) i += 1;
    if (i >= s.length) break;
    if (s[i] !== '.') return null;
    i += 1;
  }
  return parts.length > 0 ? parts : null;
}

// 把整份文件切成「前言 + 一串表」。回傳 null 代表文件裡有我們看不懂的東西。
function parseDocument(text) {
  const lines = String(text === undefined || text === null ? '' : text).split('\n');
  const tables = [];
  let state = { multi: null, depth: 0 };
  let current = null;                            // { path, isArray, start, end }
  let preambleEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const atTop = !state.multi && state.depth === 0;
    const header = atTop ? trimmed.match(/^(\[\[?)([^\]]*)(\]\]?)\s*(#.*)?$/) : null;
    if (header) {
      const isArray = header[1] === '[[';
      if ((isArray && header[3] !== ']]') || (!isArray && header[3] !== ']')) return null;
      const path = parseKeyPath_(header[2]);
      if (!path) return null;
      if (current) current.end = i;
      else preambleEnd = Math.min(preambleEnd, i);
      current = { path: path, isArray: isArray, start: i, end: lines.length };
      tables.push(current);
      state = { multi: null, depth: 0 };
      continue;
    }
    // Unknown table-looking headers must never be folded into the previous table.
    // For example [mcp_servers."a]b"] is legal TOML but outside this editor's grammar.
    if (atTop && trimmed.startsWith('[')) return null;
    state = scanLine_(line, state);
    if (state.broken) return null;
  }
  if (state.multi || state.depth !== 0) return null;   // 未閉合 → 檔案本身就壞了
  if (tables.length === 0) preambleEnd = lines.length;
  const doc = { lines: lines, tables: tables, preambleEnd: preambleEnd };
  // 這裡只做「明顯非法就拒絕」的檢查（重複表頭 / 重複鍵 / 不成形的值），
  // 不是完整的 TOML 驗證器：通過檢查不代表 Codex 一定吃得下，但沒通過就一定別亂改。
  return validateDocument_(doc) ? doc : null;
}

// 明顯非法的三件事：同一個 [table] 重複宣告、同一張表裡同一個鍵出現兩次、值不成形。
// 認不得一律回 false（呼叫端會回報 malformed，並且一個字都不寫）。
function validateDocument_(doc) {
  const seenTables = new Set();
  for (const table of doc.tables) {
    if (table.isArray) continue;                   // [[…]] 可以重複，那是陣列語意
    const key = table.path.map(function (p) { return JSON.stringify(p); }).join('.');
    if (seenTables.has(key)) return false;
    seenTables.add(key);
  }
  const ranges = [{ start: 0, end: doc.preambleEnd }].concat(doc.tables.map(function (t) {
    return { start: t.start + 1, end: t.end };
  }));
  for (const range of ranges) {
    const seenKeys = new Set();
    for (const entry of tableEntries_(doc.lines, range.start, range.end)) {
      if (!entry.path) return false;               // 認不得的 key 形狀
      const key = entry.path.map(function (p) { return JSON.stringify(p); }).join('.');
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      if (!looksLikeValue_(doc.lines, entry)) return false;
    }
  }
  return true;
}

// 值的形狀檢查：字串 / 數字 / 布林 / 日期時間 / 陣列 / inline table 以外一律當成壞值。
function looksLikeValue_(lines, entry) {
  const parts = [];
  for (let i = entry.start; i <= entry.end && i < lines.length; i++) {
    parts.push(stripTrailingComment_(i === entry.start ? lines[i].slice(lines[i].indexOf('=') + 1) : lines[i]));
  }
  const raw = parts.join(' ').trim();
  if (raw === '') return false;
  const head = raw[0];
  if (head === '"' || head === "'" || head === '[' || head === '{') return true;
  if (/^(true|false)$/.test(raw)) return true;
  if (/^[+-]?(0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+)$/.test(raw)) return true;
  if (/^[+-]?(inf|nan)$/.test(raw)) return true;
  if (/^[+-]?[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9_]+)?$/.test(raw)) return true;
  if (/^\d{4}-\d{2}-\d{2}([T ][\d:.]+([Zz]|[+-]\d{2}:\d{2})?)?$/.test(raw)) return true;
  if (/^\d{2}:\d{2}(:[\d.]+)?$/.test(raw)) return true;
  return false;
}

function samePath_(a, b) {
  return a.length === b.length && a.every(function (part, i) { return part === b[i]; });
}

// 表身裡的「頂層 key = value」行：回傳 [{ key, start, end }]（end 為含括，處理跨行值）。
function tableEntries_(lines, start, end) {
  const entries = [];
  let state = { multi: null, depth: 0 };
  let open = null;
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (!open && !state.multi && state.depth === 0) {
      const m = line.match(/^\s*((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)\s*=/);
      if (m) {
        const path = parseKeyPath_(m[1]);
        open = { key: path ? path[0] : null, path: path, start: i, end: i };
      }
    }
    state = scanLine_(line, state);
    if (open) {
      open.end = i;
      if (!state.multi && state.depth === 0) { entries.push(open); open = null; }
    }
  }
  if (open) entries.push(open);
  return entries;
}

// 值解析：只認「單行 basic / literal 字串」。其他形狀回 undefined（呼叫端保守處理）。
function parseSimpleStringValue_(lines, entry) {
  if (entry.end !== entry.start) return undefined;
  const raw = lines[entry.start].slice(lines[entry.start].indexOf('=') + 1).trim();
  const withoutComment = stripTrailingComment_(raw);
  if (withoutComment.length >= 2 && withoutComment[0] === '"' && withoutComment[withoutComment.length - 1] === '"') {
    try { return JSON.parse(withoutComment); } catch (_) { return undefined; }
  }
  if (withoutComment.length >= 2 && withoutComment[0] === "'" && withoutComment[withoutComment.length - 1] === "'") {
    return withoutComment.slice(1, -1);
  }
  return undefined;
}

// 去掉行尾註解：字串內的 '#' 不算註解，所以得照 scanLine_ 同一套規則逐字走。
// 陣列值（args）：只認「字串元素」的陣列，跨行也吃得下。其他形狀回 undefined。
function parseStringArrayValue_(lines, entry) {
  const parts = [];
  for (let i = entry.start; i <= entry.end && i < lines.length; i++) {
    const line = i === entry.start ? lines[i].slice(lines[i].indexOf('=') + 1) : lines[i];
    parts.push(stripTrailingComment_(line));
  }
  const raw = parts.join(' ').trim();
  if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return undefined;
  const inner = raw.slice(1, -1).trim();
  if (inner === '') return [];
  const out = [];
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && /[\s,]/.test(inner[i])) i += 1;
    if (i >= inner.length) break;
    const quote = inner[i];
    if (quote !== '"' && quote !== "'") return undefined;
    let value = '';
    i += 1;
    while (i < inner.length && inner[i] !== quote) {
      if (quote === '"' && inner[i] === '\\') { value += inner[i] + inner[i + 1]; i += 2; continue; }
      value += inner[i];
      i += 1;
    }
    if (i >= inner.length) return undefined;
    i += 1;
    if (quote === '"') {
      try { value = JSON.parse('"' + value + '"'); } catch (_) { return undefined; }
    }
    out.push(value);
  }
  return out;
}

function stripTrailingComment_(raw) {
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '#') return raw.slice(0, i).trim();
    if (ch === '"') {
      i += 1;
      while (i < raw.length) {
        if (raw[i] === '\\') { i += 2; continue; }
        if (raw[i] === '"') { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === "'") {
      i += 1;
      while (i < raw.length && raw[i] !== "'") i += 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return raw.trim();
}

function escapeString(value) {
  return JSON.stringify(String(value));
}

// 產生我們要寫進去的那一段（含 env 子表）。
function renderServerTable(tablePath, entry) {
  const header = '[' + tablePath.map(renderKey_).join('.') + ']';
  const out = [header];
  out.push('command = ' + escapeString(entry.command));
  out.push('args = [' + (entry.args || []).map(escapeString).join(', ') + ']');
  const envKeys = Object.keys(entry.env || {});
  if (envKeys.length > 0) {
    out.push('');
    out.push('[' + tablePath.concat(['env']).map(renderKey_).join('.') + ']');
    for (const key of envKeys) out.push(renderKey_(key) + ' = ' + escapeString(entry.env[key]));
  }
  return out;
}

function renderKey_(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : escapeString(key);
}

// 讀出既有的 [mcp_servers.<alias>] 設定（含 env 子表與 inline table 形式）。
// 回傳 { found, entry, unsupported }。
function readServerEntry(text, alias) {
  const doc = parseDocument(text);
  if (!doc) return { found: false, unsupported: 'malformed', entry: null };
  const target = ['mcp_servers', alias];
  const result = { found: false, unsupported: null, entry: null };

  for (const table of doc.tables) {
    if (samePath_(table.path, target) && table.isArray) return { found: true, unsupported: 'array_of_tables', entry: null };
  }

  // 形式 A：[mcp_servers.<alias>] 表
  const main = doc.tables.find(function (t) { return samePath_(t.path, target) && !t.isArray; });
  if (main) {
    const entry = { command: undefined, args: undefined, env: {}, enabled: undefined };
    for (const item of tableEntries_(doc.lines, main.start + 1, main.end)) {
      if (item.key === 'command') entry.command = parseSimpleStringValue_(doc.lines, item);
      else if (item.key === 'args') entry.args = parseStringArrayValue_(doc.lines, item);
      else if (item.key === 'enabled' && item.path && item.path.length === 1) {
        const raw = stripTrailingComment_(doc.lines[item.start].slice(doc.lines[item.start].indexOf('=') + 1));
        if (raw === 'false') entry.enabled = false;
        else if (raw === 'true') entry.enabled = true;
      }
      else if (item.key === 'env' && item.path && item.path.length === 2) {
        const value = parseSimpleStringValue_(doc.lines, item);
        if (value === undefined) return { found: true, unsupported: 'complex_env', entry: null };
        entry.env[item.path[1]] = value;
      }
    }
    const envTable = doc.tables.find(function (t) { return samePath_(t.path, target.concat(['env'])) && !t.isArray; });
    if (envTable) {
      for (const item of tableEntries_(doc.lines, envTable.start + 1, envTable.end)) {
        const value = parseSimpleStringValue_(doc.lines, item);
        if (value === undefined) return { found: true, unsupported: 'complex_env', entry: null };
        entry.env[item.key] = value;
      }
    }
    result.found = true;
    result.entry = entry;
    return result;
  }

  // 形式 B：[mcp_servers] 裡的 inline table（<alias> = { command = "…" }）
  const parent = doc.tables.find(function (t) { return samePath_(t.path, ['mcp_servers']) && !t.isArray; });
  if (parent) {
    const item = tableEntries_(doc.lines, parent.start + 1, parent.end).find(function (e) { return e.key === alias; });
    if (item) {
      const inlineEnv = readInlineEnv_(doc.lines, item);
      if (inlineEnv === undefined) return { found: true, unsupported: 'inline_table', entry: null };
      return { found: true, unsupported: null, entry: { command: undefined, args: undefined, env: inlineEnv } };
    }
  }
  return result;
}

// inline table 只取得出 env 的簡單字串鍵；取不到就讓呼叫端保守處理。
function readInlineEnv_(lines, entry) {
  if (entry.end !== entry.start) return undefined;
  const raw = lines[entry.start];
  const envMatch = raw.match(/env\s*=\s*\{([^{}]*)\}/);
  if (!envMatch) return {};
  const env = {};
  for (const piece of envMatch[1].split(',')) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const kv = trimmed.match(/^([A-Za-z0-9_-]+|"[^"]*")\s*=\s*(".*"|'.*')$/);
    if (!kv) return undefined;
    const key = parseKeyPath_(kv[1]);
    if (!key) return undefined;
    let value;
    try { value = kv[2][0] === '"' ? JSON.parse(kv[2]) : kv[2].slice(1, -1); } catch (_) { return undefined; }
    env[key[0]] = value;
  }
  return env;
}

// 我們接手 stdio 啟動方式時，這些舊的傳輸欄位留著只會互相打架，所以要拿掉。
// 注意：清單只有「傳輸」欄位 —— enabled / enabled_tools / disabled_tools / startup_timeout_*
// 以及任何我們不認得的鍵，都屬於使用者或管理者的政策，一律原樣保留。
const TRANSPORT_KEYS = Object.freeze(['url', 'http_url', 'type', 'transport', 'headers', 'bearer_token_env_var']);

// 把 inline table 的內容切成 [{ key, valueRaw }]。認不得回 null（呼叫端保守處理）。
function splitInlineTable_(inner) {
  const pairs = [];
  let depth = 0;
  let i = 0;
  let start = 0;
  const flush = function (end) {
    const piece = inner.slice(start, end).trim();
    if (piece === '') return true;
    const eq = findTopLevelEq_(piece);
    if (eq === -1) return false;
    const path = parseKeyPath_(piece.slice(0, eq));
    if (!path || path.length !== 1) return false;
    pairs.push({ key: path[0], valueRaw: piece.slice(eq + 1).trim() });
    return true;
  };
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < inner.length) {
        if (quote === '"' && inner[i] === '\\') { i += 2; continue; }
        if (inner[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '{' || ch === '[') { depth += 1; i += 1; continue; }
    if (ch === '}' || ch === ']') { depth -= 1; i += 1; continue; }
    if (ch === ',' && depth === 0) {
      if (!flush(i)) return null;
      start = i + 1;
    }
    i += 1;
  }
  if (!flush(inner.length)) return null;
  return pairs;
}

function findTopLevelEq_(piece) {
  let i = 0;
  while (i < piece.length) {
    const ch = piece[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < piece.length) {
        if (quote === '"' && piece[i] === '\\') { i += 2; continue; }
        if (piece[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '=') return i;
    i += 1;
  }
  return -1;
}

// 過濾 inline env（{ A = "1", LTJ_API_TOKEN = "…" }）：拿掉 dropKeys，其餘原樣保留。
// 回傳新的 inline table 文字；全空回 null（呼叫端刪掉整行）；認不得回 undefined。
function filterInlineEnvText_(valueRaw, dropKeys) {
  if (valueRaw[0] !== '{' || valueRaw[valueRaw.length - 1] !== '}') return undefined;
  const pairs = splitInlineTable_(valueRaw.slice(1, -1));
  if (!pairs) return undefined;
  const kept = pairs.filter(function (p) { return dropKeys.indexOf(p.key) === -1; });
  if (kept.length === 0) return null;
  return '{ ' + kept.map(function (p) { return renderKey_(p.key) + ' = ' + p.valueRaw; }).join(', ') + ' }';
}

function renderArgsLine_(args) {
  return 'args = [' + (args || []).map(escapeString).join(', ') + ']';
}

// 就地替換（沒有就附加）。回傳 { ok, text, reason, changed }。
//
// 關鍵原則：只改「我們自己負責的欄位」——command / args、與 stdio 互斥的舊傳輸欄位、
// 以及呼叫端明講要清掉的 env 鍵（憑證與失效站台）。其餘每一行（政策鍵、子表、註解、
// 空白、我們不認得的任何東西）都留在原位，一個字都不動。
// entry = { command, args, env?, dropEnvKeys? }
function upsertServerEntry(text, alias, entry) {
  const doc = parseDocument(text);
  if (!doc) return { ok: false, reason: 'malformed', text: null, changed: false };
  const target = ['mcp_servers', alias];
  const dropEnv = entry.dropEnvKeys || [];

  if (doc.tables.some(function (t) { return samePath_(t.path, target) && t.isArray; })) {
    return { ok: false, reason: 'array_of_tables', text: null, changed: false };
  }

  // 頂層 mcp_servers = { … }（inline）我們不改：改它要重寫整個 inline table，風險過高。
  const preambleEntries = tableEntries_(doc.lines, 0, doc.preambleEnd);
  if (preambleEntries.some(function (e) { return e.key === 'mcp_servers'; })) {
    return { ok: false, reason: 'inline_root_table', text: null, changed: false };
  }

  const edits = [];                               // { start, end(exclusive), replacement: string[] }
  const main = doc.tables.find(function (t) { return samePath_(t.path, target) && !t.isArray; });
  if (main) {
    const seen = new Set();
    for (const item of tableEntries_(doc.lines, main.start + 1, main.end)) {
      const key = item.path ? item.path[0] : item.key;
      const range = { start: item.start, end: item.end + 1 };
      if (item.path && item.path.length === 1) seen.add(key);
      if (item.path && item.path.length === 1 && key === 'command') {
        edits.push({ start: range.start, end: range.end, replacement: ['command = ' + escapeString(entry.command)] });
      } else if (item.path && item.path.length === 1 && key === 'args') {
        edits.push({ start: range.start, end: range.end, replacement: [renderArgsLine_(entry.args)] });
      } else if (item.path && item.path.length === 1 && TRANSPORT_KEYS.indexOf(key) !== -1) {
        edits.push({ start: range.start, end: range.end, replacement: [] });
      } else if (item.path && item.path.length === 2 && key === 'env') {
        if (dropEnv.indexOf(item.path[1]) !== -1) edits.push({ start: range.start, end: range.end, replacement: [] });
      } else if (item.path && item.path.length === 1 && key === 'env') {
        const raw = stripTrailingComment_(doc.lines.slice(item.start, item.end + 1)
          .map(function (l, idx) { return idx === 0 ? l.slice(l.indexOf('=') + 1) : l; }).join(' ')).trim();
        const filtered = filterInlineEnvText_(raw, dropEnv);
        if (filtered === undefined) return { ok: false, reason: 'complex_env', text: null, changed: false };
        edits.push({ start: range.start, end: range.end, replacement: filtered === null ? [] : ['env = ' + filtered] });
      }
    }
    // 缺 command / args 就補在表頭後面（其餘既有內容照樣留著）。
    const missing = [];
    if (!seen.has('command')) missing.push('command = ' + escapeString(entry.command));
    if (!seen.has('args')) missing.push(renderArgsLine_(entry.args));
    if (missing.length > 0) edits.push({ start: main.start + 1, end: main.start + 1, replacement: missing });

    // env 子表：只刪掉指名要清的憑證 / 失效站台鍵，其他鍵與註解不動。
    const envTable = doc.tables.find(function (t) { return samePath_(t.path, target.concat(['env'])) && !t.isArray; });
    if (envTable) {
      for (const item of tableEntries_(doc.lines, envTable.start + 1, envTable.end)) {
        if (item.path && item.path.length === 1 && dropEnv.indexOf(item.path[0]) !== -1) {
          edits.push({ start: item.start, end: item.end + 1, replacement: [] });
        }
      }
    }
    return applyEdits_(doc.lines, edits, text);
  }

  // 形式 B：[mcp_servers] 裡的 inline table。轉成表形式，但每個非傳輸鍵都原樣搬過去。
  const parent = doc.tables.find(function (t) { return samePath_(t.path, ['mcp_servers']) && !t.isArray; });
  if (parent) {
    const item = tableEntries_(doc.lines, parent.start + 1, parent.end).find(function (e) { return e.key === alias; });
    if (item) {
      const raw = stripTrailingComment_(doc.lines.slice(item.start, item.end + 1)
        .map(function (l, idx) { return idx === 0 ? l.slice(l.indexOf('=') + 1) : l; }).join(' ')).trim();
      if (raw[0] !== '{' || raw[raw.length - 1] !== '}') return { ok: false, reason: 'inline_table', text: null, changed: false };
      const pairs = splitInlineTable_(raw.slice(1, -1));
      if (!pairs) return { ok: false, reason: 'inline_table', text: null, changed: false };
      const rendered = ['[' + target.map(renderKey_).join('.') + ']'];
      rendered.push('command = ' + escapeString(entry.command));
      rendered.push(renderArgsLine_(entry.args));
      for (const pair of pairs) {
        if (pair.key === 'command' || pair.key === 'args') continue;
        if (TRANSPORT_KEYS.indexOf(pair.key) !== -1) continue;
        if (pair.key === 'env') {
          const filtered = filterInlineEnvText_(pair.valueRaw, dropEnv);
          if (filtered === undefined) return { ok: false, reason: 'complex_env', text: null, changed: false };
          if (filtered !== null) rendered.push('env = ' + filtered);
          continue;
        }
        rendered.push(renderKey_(pair.key) + ' = ' + pair.valueRaw);
      }
      // inline 那一行刪掉，新表擺在整個 [mcp_servers] 表之後（不打斷既有排版）。
      const tail = [''].concat(rendered);
      const edited = [
        { start: item.start, end: item.end + 1, replacement: [] },
        { start: parent.end, end: parent.end, replacement: tail }
      ];
      return applyEdits_(doc.lines, edited, text);
    }
  }

  // 完全沒有：附加一段新的表。
  const lines = doc.lines.slice();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length > 0) lines.push('');
  lines.push.apply(lines, renderServerTable(target, entry));
  lines.push('');
  return finalize_(lines, text);
}

function applyEdits_(originalLines, edits, text) {
  const lines = originalLines.slice();
  edits.sort(function (a, b) { return b.start - a.start || b.end - a.end; });
  for (const edit of edits) {
    lines.splice.apply(lines, [edit.start, edit.end - edit.start].concat(edit.replacement));
  }
  return finalize_(lines, text);
}

function finalize_(lines, text) {
  let out = lines.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  return { ok: true, reason: null, text: out, changed: out !== text };
}

module.exports = {
  escapeString,
  parseDocument,
  readServerEntry,
  renderServerTable,
  upsertServerEntry
};
