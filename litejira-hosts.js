'use strict';

// AI 主機（Codex CLI / Claude Code / Gemini CLI）的 MCP 設定檔讀寫。
//
// 這個模組的責任只有一件事：把「litejira 這個 MCP server 該怎麼啟動」寫進各家主機
// 官方文件指定的設定檔，而且**不碰其他任何東西**。
//
// 官方契約（2026-09 查核）：
//   Codex CLI   ~/.codex/config.toml（CODEX_HOME 可覆寫）→ [mcp_servers.litejira] command/args
//   Claude Code ~/.claude.json 頂層 mcpServers；projects["<cwd>"].mcpServers 為專案覆寫；
//               專案內 .mcp.json 亦可定義（會遮蔽 user 層）
//   Gemini CLI  ~/.gemini/settings.json 的 mcpServers；專案 .gemini/settings.json 覆寫；
//               mcp.allowed / mcp.excluded 屬管理者限制，不得繞過
//
// 安全底線：
//   * 憑證不進設定檔（token 只在 ~/.litejira/credentials*.env，0600）。
//   * 寫入前先備份（0600），寫入用 tmp + rename 原子替換。
//   * 檔案壞掉 / 形狀不認得 → 一律零變更，回報可行動的原因。

const fs = require('fs');
const path = require('path');
const os = require('os');

const toml = require('./litejira-toml-edit');
const { isLegacyOfficialUrl, OFFICIAL_API_URL } = require('./litejira-config');

const ALIAS = 'litejira';

// 這些鍵放在主機設定檔的 env 裡會反過來壓過使用者剛設定好的憑證 / 站台，
// 所以我們接手 litejira 這個項目時要清掉（其他鍵一律保留）。
const SECRET_ENV_KEYS = Object.freeze(['LTJ_API_TOKEN', 'LTJ_API_PAT']);

// home 一律由 ctx 帶進來：測試必須能指向暫存目錄，不可以碰到真的使用者家目錄。
function makeContext(options) {
  const opts = options || {};
  return {
    env: opts.env || process.env,
    cwd: opts.cwd || process.cwd(),
    home: opts.home || os.homedir()
  };
}

function envPath_(ctx, name) {
  const runtimeEnv = (ctx && ctx.env) || process.env;
  const value = runtimeEnv[name];
  return value && String(value).trim() ? String(value).trim() : null;
}

function codexHome(ctx) {
  return envPath_(ctx, 'CODEX_HOME') || path.join(ctx.home, '.codex');
}

// Claude Code：CLAUDE_CONFIG_DIR 指的是「放 .claude.json 的那個目錄」（不是 HOME）。
function claudeConfigDir(ctx) {
  return envPath_(ctx, 'CLAUDE_CONFIG_DIR') || ctx.home;
}

// Gemini CLI：GEMINI_CLI_HOME 是 HOME 的替身，設定檔仍在它底下的 .gemini/settings.json。
function geminiHome(ctx) {
  return envPath_(ctx, 'GEMINI_CLI_HOME') || ctx.home;
}

function geminiUserFile(ctx) {
  return path.join(geminiHome(ctx), '.gemini', 'settings.json');
}

// 啟動指令：一律用「目前這個 node 的絕對路徑 + 本套件 launcher 的絕對路徑」。
// 理由：AI 主機不一定繼承使用者 shell 的 PATH（Windows / macOS GUI 尤其明顯），
// 只寫 "litejira-mcp" 很容易變成「在終端機能跑、在主機裡起不來」。
function launchCommand(options) {
  const opts = options || {};
  const execPath = opts.execPath || process.execPath;
  const launcher = opts.launcher || path.join(__dirname, 'litejira-mcp-launch.cjs');
  const args = [path.resolve(launcher)];
  if (opts.target === 'prod' || opts.target === 'dev') args.push(opts.target);
  return { command: execPath, args: args };
}

// 既有 env 的清理：拿掉憑證、拿掉會讓新設定失效的舊站台網址，其他原樣保留。
function sanitizeEnv(existingEnv) {
  const source = existingEnv && typeof existingEnv === 'object' ? existingEnv : {};
  const env = {};
  const cleared = [];
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (typeof value !== 'string') { env[key] = value; continue; }
    if (SECRET_ENV_KEYS.indexOf(key) !== -1) { cleared.push(key); continue; }
    if (key === 'LTJ_API_URL' && isLegacyOfficialUrl(value)) { cleared.push(key); continue; }
    env[key] = value;
  }
  return { env: env, cleared: cleared };
}

function backupAndWrite(file, text, results) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  let backup = null;
  if (fs.existsSync(file)) {
    backup = file + '.litejira-backup-' + new Date().toISOString().replace(/[:.]/g, '');
    fs.copyFileSync(file, backup);
    try { fs.chmodSync(backup, 0o600); } catch (_) { /* 非 POSIX 平台略過 */ }
  }
  const tmp = file + '.litejira-tmp-' + process.pid;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) { /* 非 POSIX 平台略過 */ }
  if (results) results.backup = backup;
  return backup;
}

function readJsonFile(file) {
  if (!fs.existsSync(file)) return { exists: false, data: {}, raw: '' };
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.trim() === '') return { exists: true, data: {}, raw: raw };
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { exists: true, data: null, raw: raw, error: 'not_object' };
    }
    return { exists: true, data: data, raw: raw };
  } catch (_) {
    // 帶註解的 JSONC 我們讀得懂，但重寫會把註解洗掉，所以一律拒絕而不是硬改。
    return { exists: true, data: null, raw: raw, error: 'malformed' };
  }
}

function writeJsonFile(file, data, results) {
  return backupAndWrite(file, JSON.stringify(data, null, 2) + '\n', results);
}

// JSON 主機裡與 stdio 互斥的傳輸欄位：接手時要拿掉，否則主機會照舊的 http/sse 去連。
// 其餘每一個鍵（includeTools / excludeTools / trust / disabled / timeout / 任何我們不認得的）
// 都是使用者或管理者的設定，一律原樣保留。
const JSON_TRANSPORT_KEYS = Object.freeze(['url', 'httpUrl', 'headers', 'type', 'transport', 'tcp']);

// 既有項目 + 我們負責的欄位 = 新項目。沒有既有項目時就是乾淨的一份。
function mergeJsonEntry_(existing, desired) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const env = desired.env || {};
  const hasEnv = Object.keys(env).length > 0;
  const merged = {};
  // 逐鍵照原順序搬過去，這樣沒有語意變化時輸出也逐位元組相同（不會製造假的「已變更」）。
  for (const key of Object.keys(base)) {
    if (JSON_TRANSPORT_KEYS.indexOf(key) !== -1) continue;
    if (key === 'command') { merged.command = desired.command; continue; }
    if (key === 'args') { merged.args = desired.args.slice(); continue; }
    if (key === 'env') { if (hasEnv) merged.env = env; continue; }
    merged[key] = base[key];
  }
  if (merged.command === undefined) merged.command = desired.command;
  if (merged.args === undefined) merged.args = desired.args.slice();
  if (hasEnv && merged.env === undefined) merged.env = env;
  return merged;
}

function entryMatches(existing, desired) {
  if (!existing || typeof existing !== 'object') return false;
  return JSON.stringify(existing) === JSON.stringify(mergeJsonEntry_(existing, desired));
}

// ---------------------------------------------------------------- Codex ----

function codexTargets(ctx) {
  const targets = [{ scope: 'user', file: path.join(codexHome(ctx), 'config.toml') }];
  // Codex 也讀專案目錄下的 .codex/config.toml（專案覆寫）。只在已存在時處理，不新建。
  const projectFile = path.join(ctx.cwd, '.codex', 'config.toml');
  if (fs.existsSync(projectFile)) targets.push({ scope: 'project', file: projectFile, onlyIfPresent: true });
  return targets;
}

function codexApply(ctx, desired, dryRun) {
  const out = [];
  for (const target of codexTargets(ctx)) {
    const exists = fs.existsSync(target.file);
    const text = exists ? fs.readFileSync(target.file, 'utf8') : '';
    const current = toml.readServerEntry(text, ALIAS);
    if (current.unsupported) {
      out.push({
        scope: target.scope,
        file: target.file,
        status: 'blocked',
        reason: current.unsupported,
        message: codexReasonMessage_(current.unsupported, target.file)
      });
      continue;
    }
    if (target.onlyIfPresent && !current.found) continue;   // 專案檔沒定義 litejira 就別插手
    const sanitized = sanitizeEnv(current.entry && current.entry.env);
    const entry = {
      command: desired.command,
      args: desired.args,
      env: sanitized.env,
      dropEnvKeys: sanitized.cleared
    };
    const result = toml.upsertServerEntry(text, ALIAS, entry);
    if (!result.ok) {
      out.push({
        scope: target.scope,
        file: target.file,
        status: 'blocked',
        reason: result.reason,
        message: codexReasonMessage_(result.reason, target.file)
      });
      continue;
    }
    if (!dryRun && result.changed) backupAndWrite(target.file, result.text);
    out.push({
      scope: target.scope,
      file: target.file,
      status: result.changed ? (current.found ? 'replaced' : 'added') : 'unchanged',
      clearedEnv: sanitized.cleared,
      replacedExisting: current.found
    });
    // enabled = false 是使用者/管理者明講的停用。我們寫得進去，但主機不會起它 ——
    // 這種情況不能算「設定成功」，也不該由我們擅自改成 true。
    if (current.entry && current.entry.enabled === false) {
      out.push({
        scope: 'policy',
        file: target.file,
        status: 'warning',
        reason: 'disabled',
        policyDisabled: true,
        message: target.file + ' 裡的 [mcp_servers.' + ALIAS + '] 有 enabled = false（使用者/管理者明講的停用）。'
          + '啟動指令已更新，但本工具不會把它改成 true，Codex 也不會載入它；請自行確認要不要啟用後重跑驗證。'
      });
    }
  }
  return out;
}

function codexReasonMessage_(reason, file) {
  if (reason === 'malformed') {
    return file + ' 無法由本工具安全解析：可能是格式問題，也可能是尚未支援的合法 TOML 寫法。未做任何變更；'
      + '這不是完整的 TOML 驗證器。請 AI 檢查並保留原設定含義，處理後重跑 setup，不要直接要求使用者手改。';
  }
  if (reason === 'array_of_tables') {
    return file + ' 裡的 litejira 是以 [[mcp_servers.litejira]] 陣列表定義，本工具不改這種形狀。'
      + '未做任何變更；請改成單一的 [mcp_servers.litejira] 表後重跑 setup。';
  }
  if (reason === 'inline_root_table') {
    return file + ' 把整個 mcp_servers 寫成頂層 inline table（mcp_servers = { … }），重寫它風險過高。'
      + '未做任何變更；請改成 [mcp_servers.<name>] 表形式後重跑 setup。';
  }
  if (reason === 'inline_table') {
    return file + ' 裡的 litejira 是 inline table 且含本工具無法安全解析的值。未做任何變更；'
      + '請把它改成 [mcp_servers.litejira] 表後重跑 setup。';
  }
  if (reason === 'complex_env') {
    return file + ' 裡 litejira 的 env 含非單行字串的值，本工具不重寫它以免改壞。未做任何變更。';
  }
  return file + ' 形狀無法安全處理（' + reason + '），未做任何變更。';
}

// --------------------------------------------------------------- Claude ----

function claudeUserFile(ctx) {
  return path.join(claudeConfigDir(ctx), '.claude.json');
}

function claudeApply(ctx, desired, dryRun) {
  const out = [];
  const file = claudeUserFile(ctx);
  const read = readJsonFile(file);
  if (read.error) {
    out.push({ scope: 'user', file: file, status: 'blocked', reason: read.error, message: jsonReasonMessage_(read.error, file) });
    return out;
  }
  const data = read.data;
  if (!data.mcpServers || typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers)) {
    if (data.mcpServers !== undefined) {
      out.push({ scope: 'user', file: file, status: 'blocked', reason: 'not_object', message: jsonReasonMessage_('not_object', file) });
      return out;
    }
    data.mcpServers = {};
  }
  const sanitized = sanitizeEnv(data.mcpServers[ALIAS] && data.mcpServers[ALIAS].env);
  const entry = { command: desired.command, args: desired.args, env: sanitized.env };
  const replaced = Object.prototype.hasOwnProperty.call(data.mcpServers, ALIAS);
  const same = entryMatches(data.mcpServers[ALIAS], entry);
  data.mcpServers[ALIAS] = mergeJsonEntry_(data.mcpServers[ALIAS], entry);
  if (!dryRun && !same) writeJsonFile(file, data);
  out.push({
    scope: 'user',
    file: file,
    status: same ? 'unchanged' : (replaced ? 'replaced' : 'added'),
    clearedEnv: sanitized.cleared,
    replacedExisting: replaced
  });

  // 專案覆寫：projects["<cwd>"].mcpServers.litejira 與專案內 .mcp.json。
  // 只處理「已經定義了 litejira」的地方 —— 不新建覆寫，但也不能讓舊的覆寫遮蔽 user 設定。
  const projects = data.projects;
  if (projects && typeof projects === 'object') {
    for (const key of Object.keys(projects)) {
      if (path.resolve(key) !== path.resolve(ctx.cwd)) continue;
      const scoped = projects[key];
      if (!scoped || typeof scoped !== 'object') continue;
      if (!scoped.mcpServers || typeof scoped.mcpServers !== 'object') continue;
      if (!Object.prototype.hasOwnProperty.call(scoped.mcpServers, ALIAS)) continue;
      const localSan = sanitizeEnv(scoped.mcpServers[ALIAS] && scoped.mcpServers[ALIAS].env);
      const localEntry = { command: desired.command, args: desired.args, env: localSan.env };
      const localSame = entryMatches(scoped.mcpServers[ALIAS], localEntry);
      scoped.mcpServers[ALIAS] = mergeJsonEntry_(scoped.mcpServers[ALIAS], localEntry);
      if (!dryRun && !localSame) writeJsonFile(file, data);
      out.push({
        scope: 'project-local',
        file: file,
        status: localSame ? 'unchanged' : 'replaced',
        clearedEnv: localSan.cleared,
        replacedExisting: true
      });
    }
  }

  // 停用清單可能在頂層，也可能在 projects["<cwd>"] 底下（專案層）。兩邊都要看。
  const disabledLists = [data.disabledMcpjsonServers];
  if (data.projects && typeof data.projects === 'object') {
    for (const key of Object.keys(data.projects)) {
      if (path.resolve(key) !== path.resolve(ctx.cwd)) continue;
      const scoped = data.projects[key];
      if (scoped && typeof scoped === 'object') disabledLists.push(scoped.disabledMcpjsonServers);
    }
  }
  const disabled = disabledLists.some(function (list) {
    return Array.isArray(list) && list.indexOf(ALIAS) !== -1;
  });
  if (disabled) {
    out.push({
      scope: 'policy',
      file: file,
      status: 'warning',
      reason: 'disabled',
      policyDisabled: true,
      message: 'Claude Code 的 disabledMcpjsonServers 含 litejira：設定已寫入，但主機會停用它。'
        + '這是使用者/管理者的信任設定，本工具不擅自更動；請在 Claude Code 內重新核准後再連線。'
    });
  }

  // 專案根的 .mcp.json（會遮蔽 user 設定）：只在已有 litejira 項目時就地更新。
  const projectFile = path.join(ctx.cwd, '.mcp.json');
  if (fs.existsSync(projectFile)) {
    const pr = readJsonFile(projectFile);
    if (pr.error) {
      out.push({ scope: 'project', file: projectFile, status: 'blocked', reason: pr.error, message: jsonReasonMessage_(pr.error, projectFile) });
    } else if (pr.data.mcpServers && typeof pr.data.mcpServers === 'object'
      && Object.prototype.hasOwnProperty.call(pr.data.mcpServers, ALIAS)) {
      const pSan = sanitizeEnv(pr.data.mcpServers[ALIAS] && pr.data.mcpServers[ALIAS].env);
      const pEntry = { command: desired.command, args: desired.args, env: pSan.env };
      const pSame = entryMatches(pr.data.mcpServers[ALIAS], pEntry);
      pr.data.mcpServers[ALIAS] = mergeJsonEntry_(pr.data.mcpServers[ALIAS], pEntry);
      if (!dryRun && !pSame) writeJsonFile(projectFile, pr.data);
      out.push({
        scope: 'project',
        file: projectFile,
        status: pSame ? 'unchanged' : 'replaced',
        clearedEnv: pSan.cleared,
        replacedExisting: true
      });
    }
  }
  return out;
}

function jsonReasonMessage_(reason, file) {
  if (reason === 'malformed') {
    return file + ' 不是合法 JSON（或含註解 / 尾逗號）。未做任何變更；'
      + '重寫它會洗掉無法保留的內容，所以請先讓它成為合法 JSON 再重跑 setup。';
  }
  if (reason === 'not_object') {
    return file + ' 的頂層（或 mcpServers）不是物件，形狀不符官方契約。未做任何變更。';
  }
  return file + ' 無法安全處理（' + reason + '），未做任何變更。';
}

// --------------------------------------------------------------- Gemini ----

function geminiApply(ctx, desired, dryRun) {
  const out = [];
  const files = [
    { scope: 'user', file: geminiUserFile(ctx), create: true },
    { scope: 'project', file: path.join(ctx.cwd, '.gemini', 'settings.json'), create: false }
  ];
  for (const target of files) {
    if (!target.create && !fs.existsSync(target.file)) continue;
    const read = readJsonFile(target.file);
    if (read.error) {
      out.push({ scope: target.scope, file: target.file, status: 'blocked', reason: read.error, message: jsonReasonMessage_(read.error, target.file) });
      continue;
    }
    const data = read.data;
    const policy = geminiPolicy_(data);
    if (policy.blocked) {
      out.push({ scope: target.scope, file: target.file, status: 'blocked', reason: policy.reason, message: policy.message(target.file) });
      continue;
    }
    if (data.mcpServers !== undefined
      && (!data.mcpServers || typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers))) {
      out.push({ scope: target.scope, file: target.file, status: 'blocked', reason: 'not_object', message: jsonReasonMessage_('not_object', target.file) });
      continue;
    }
    const existingServers = data.mcpServers || {};
    const hasEntry = Object.prototype.hasOwnProperty.call(existingServers, ALIAS);
    if (!target.create && !hasEntry) continue;      // 專案設定沒定義 litejira 就別插手
    if (!data.mcpServers) data.mcpServers = {};
    const sanitized = sanitizeEnv(data.mcpServers[ALIAS] && data.mcpServers[ALIAS].env);
    const entry = { command: desired.command, args: desired.args, env: sanitized.env };
    const same = entryMatches(data.mcpServers[ALIAS], entry);
    data.mcpServers[ALIAS] = mergeJsonEntry_(data.mcpServers[ALIAS], entry);
    if (!dryRun && !same) writeJsonFile(target.file, data);
    out.push({
      scope: target.scope,
      file: target.file,
      status: same ? 'unchanged' : (hasEntry ? 'replaced' : 'added'),
      clearedEnv: sanitized.cleared,
      replacedExisting: hasEntry
    });
  }
  return out;
}

// Gemini 的 mcp.allowed / mcp.excluded 是管理者限制：我們回報，不繞過。
function geminiPolicy_(data) {
  const mcp = data && data.mcp && typeof data.mcp === 'object' ? data.mcp : {};
  const excluded = Array.isArray(mcp.excluded) ? mcp.excluded : [];
  const allowed = Array.isArray(mcp.allowed) ? mcp.allowed : null;
  if (excluded.indexOf(ALIAS) !== -1) {
    return {
      blocked: true,
      reason: 'policy_excluded',
      message: function (file) {
        return file + ' 的 mcp.excluded 含 litejira（管理者限制）。未做任何變更 —— '
          + '繞過它不是本工具該做的事；請先與該設定的管理者確認是否放行。';
      }
    };
  }
  if (allowed && allowed.indexOf(ALIAS) === -1) {
    return {
      blocked: true,
      reason: 'policy_not_allowed',
      message: function (file) {
        return file + ' 的 mcp.allowed 清單未含 litejira（管理者限制）。未做任何變更；'
          + '請先與該設定的管理者確認是否加入白名單。';
      }
    };
  }
  return { blocked: false };
}

// ------------------------------------------------------------- registry ----

const HOSTS = Object.freeze({
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    detect: function (ctx) {
      return fs.existsSync(codexHome(ctx)) || !!(ctx.env && ctx.env.CODEX_HOME);
    },
    apply: codexApply,
    read: function (ctx) {
      const projectFile = path.join(ctx.cwd, '.codex', 'config.toml');
      if (fs.existsSync(projectFile)) {
        const parsed = toml.readServerEntry(fs.readFileSync(projectFile, 'utf8'), ALIAS);
        if (parsed.found) {
          return {
            found: !parsed.unsupported, file: projectFile, scope: 'project',
            entry: parsed.entry, unsupported: parsed.unsupported
          };
        }
      }
      const file = path.join(codexHome(ctx), 'config.toml');
      if (!fs.existsSync(file)) return { found: false, file: file, entry: null };
      const parsed = toml.readServerEntry(fs.readFileSync(file, 'utf8'), ALIAS);
      return {
        found: parsed.found && !parsed.unsupported, file: file, scope: 'user',
        entry: parsed.entry, unsupported: parsed.unsupported
      };
    }
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    detect: function (ctx) {
      return fs.existsSync(claudeUserFile(ctx)) || fs.existsSync(path.join(claudeConfigDir(ctx), '.claude'));
    },
    apply: claudeApply,
    // 讀回來要用主機真正的優先序，否則我們驗證的是一份「主機根本不會用」的設定：
    // local（.claude.json 的 projects["<cwd>"]）> project（專案根 .mcp.json）> user（.claude.json 頂層）。
    read: function (ctx) {
      const file = claudeUserFile(ctx);
      const read = readJsonFile(file);
      if (read.error) return { found: false, file: file, entry: null, unsupported: read.error };

      if (read.exists && read.data.projects && typeof read.data.projects === 'object') {
        for (const key of Object.keys(read.data.projects)) {
          if (path.resolve(key) !== path.resolve(ctx.cwd)) continue;
          const scoped = read.data.projects[key];
          const local = scoped && scoped.mcpServers && scoped.mcpServers[ALIAS];
          if (local) return { found: true, file: file, scope: 'local', entry: local };
        }
      }

      const projectFile = path.join(ctx.cwd, '.mcp.json');
      if (fs.existsSync(projectFile)) {
        const pr = readJsonFile(projectFile);
        if (pr.error) return { found: false, file: projectFile, entry: null, unsupported: pr.error };
        const projectEntry = pr.data.mcpServers && pr.data.mcpServers[ALIAS];
        if (projectEntry) return { found: true, file: projectFile, scope: 'project', entry: projectEntry };
      }

      if (!read.exists) return { found: false, file: file, entry: null, unsupported: null };
      const entry = read.data.mcpServers && read.data.mcpServers[ALIAS];
      return { found: !!entry, file: file, scope: 'user', entry: entry || null };
    }
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    detect: function (ctx) {
      return fs.existsSync(path.join(geminiHome(ctx), '.gemini'));
    },
    apply: geminiApply,
    // 專案設定覆寫使用者設定，所以讀回來也要照這個順序。
    read: function (ctx) {
      const projectFile = path.join(ctx.cwd, '.gemini', 'settings.json');
      if (fs.existsSync(projectFile)) {
        const pr = readJsonFile(projectFile);
        if (pr.error) return { found: false, file: projectFile, entry: null, unsupported: pr.error };
        const projectEntry = pr.data.mcpServers && pr.data.mcpServers[ALIAS];
        if (projectEntry) return { found: true, file: projectFile, scope: 'project', entry: projectEntry };
      }
      const file = geminiUserFile(ctx);
      const read = readJsonFile(file);
      if (read.error || !read.exists) return { found: false, file: file, entry: null, unsupported: read.error || null };
      const entry = read.data.mcpServers && read.data.mcpServers[ALIAS];
      return { found: !!entry, file: file, scope: 'user', entry: entry || null };
    }
  }
});

function knownClients() {
  return Object.keys(HOSTS);
}

function detectClients(options) {
  const ctx = makeContext(options);
  return knownClients().filter(function (id) { return HOSTS[id].detect(ctx); });
}

// 主要入口：把 litejira 註冊到指定主機。dryRun=true 只做 preflight（不寫檔）。
function registerClients(clients, options) {
  const opts = options || {};
  const ctx = makeContext(opts);
  const desired = launchCommand({ execPath: opts.execPath, launcher: opts.launcher, target: opts.target });
  const results = [];
  for (const id of clients) {
    const host = HOSTS[id];
    if (!host) {
      results.push({ client: id, label: id, status: 'blocked', reason: 'unknown_client', message: '不認得的主機：' + id });
      continue;
    }
    const files = host.apply(ctx, desired, !!opts.dryRun);
    results.push({ client: id, label: host.label, files: files });
  }
  return { command: desired.command, args: desired.args, results: results };
}

module.exports = {
  ALIAS,
  HOSTS,
  SECRET_ENV_KEYS,
  OFFICIAL_API_URL,
  backupAndWrite,
  claudeConfigDir,
  claudeUserFile,
  codexHome,
  detectClients,
  geminiHome,
  geminiUserFile,
  makeContext,
  entryMatches,
  knownClients,
  launchCommand,
  readJsonFile,
  registerClients,
  sanitizeEnv
};
