#!/usr/bin/env node

function parseCommand(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const command = args.shift();
  const options = parseOptions_(args);
  const json = !!options.flags.json;
  const yes = !!options.flags.yes;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help', action: '', params: {}, json, yes, write: false };
  }

  if (command === 'search') {
    return {
      command,
      action: 'searchTickets',
      params: compactParams_({
        q: options.values.q,
        type: options.values.type,
        status: options.values.status,
        assignee: options.values.assignee,
        creator: options.values.creator,
        version: options.values.version,
        module: options.values.module,
        subtype: options.values.subtype,
        limit: toNumberOrUndefined_(options.values.limit),
        cursor: options.values.cursor,
        sort: options.values.sort,
        order: options.values.order
      }),
      json,
      yes,
      write: false
    };
  }

  if (command === 'comments') {
    return {
      command,
      action: 'listComments',
      params: compactParams_({
        ticketId: options.positionals[0],
        limit: toNumberOrUndefined_(options.values.limit),
        cursor: options.values.cursor,
        order: options.values.order
      }),
      json,
      yes,
      write: false
    };
  }

  if (command === 'activity') {
    return {
      command,
      action: 'getActivityLog',
      params: compactParams_({
        ticketId: options.positionals[0],
        limit: toNumberOrUndefined_(options.values.limit),
        cursor: options.values.cursor,
        includeComments: toBoolOrUndefined_(options.values.comments),
        includeSystemEvents: toBoolOrUndefined_(options.values.system)
      }),
      json,
      yes,
      write: false
    };
  }

  if (command === 'link') {
    return {
      command,
      action: 'linkTickets',
      params: compactParams_({
        childId: options.positionals[0],
        parentId: options.positionals[1] === 'null' ? null : options.positionals[1],
        expectedUpdatedAt: toNumberOrUndefined_(options.values['expected-updated-at'])
      }),
      json,
      yes,
      write: true
    };
  }

  if (command === 'reply') {
    const transition = options.values['to-status'] ? { toStatus: options.values['to-status'] } : undefined;
    return {
      command,
      action: 'replyFeedback',
      params: compactParams_({
        ticketId: options.positionals[0],
        content: options.values.content,
        transition,
        expectedUpdatedAt: toNumberOrUndefined_(options.values['expected-updated-at'])
      }),
      json,
      yes,
      write: true
    };
  }

  if (command === 'attach') {
    return {
      command,
      action: 'attachLink',
      params: compactParams_({
        ticketId: options.positionals[0],
        url: options.positionals[1],
        name: options.values.name,
        kind: options.values.kind
      }),
      json,
      yes,
      write: true
    };
  }

  throw new Error('未知指令：' + command);
}

async function runCli(argv, env, io, fetchImpl) {
  const output = io || {
    log: (line) => console.log(line),
    error: (line) => console.error(line)
  };

  let parsed;
  try {
    parsed = parseCommand(argv);
  } catch (err) {
    output.error(err.message || String(err));
    printUsage_(output.error);
    return 2;
  }

  if (parsed.command === 'help') {
    printUsage_(output.log);
    return 0;
  }

  if (parsed.write && !parsed.yes) {
    output.error('寫入指令需要 --yes 確認');
    return 2;
  }

  const runtimeEnv = env || process.env;
  const url = runtimeEnv.LTJ_API_URL;
  const token = runtimeEnv.LTJ_API_TOKEN || runtimeEnv.LTJ_API_PAT;
  if (!url || !token) {
    output.error('缺少 LTJ_API_URL 或 LTJ_API_TOKEN（亦接受舊名 LTJ_API_PAT）');
    return 2;
  }

  const fetchFn = fetchImpl || globalThis.fetch;
  if (!fetchFn) {
    output.error('目前 Node.js runtime 沒有 fetch；請使用 Node 18+');
    return 2;
  }

  let envelope;
  try {
    envelope = await postLiteJiraApi(fetchFn, url, token, parsed.action, parsed.params);
  } catch (err) {
    output.error(err.message || String(err));
    return 1;
  }

  if (!envelope.ok) {
    const error = envelope.error || {};
    output.error((error.code ? error.code + ': ' : '') + (error.message || 'API request failed'));
    return 1;
  }

  if (parsed.json) {
    output.log(JSON.stringify(envelope, null, 2));
  } else {
    output.log(formatHuman_(parsed.command, envelope.data));
  }
  return 0;
}

// LJ-116 批次 3: 錯誤訊息脫敏 — 截短 200 字 + 剝敏感 header 痕跡 + 遮罩 token 字串
function sanitizeErrorBody_(text) {
  if (!text) return '';
  // 1. 剝行首敏感 header 行
  const lines = String(text).split('\n').filter(function(line) {
    return !/^\s*(set-cookie|authorization|cookie|x-litejira-token|x-litejira-pat):/i.test(line);
  });
  let out = lines.join('\n');
  // 2. 遮罩 token 字串（Bearer xxx / ltj_pat_xxx / Authorization: ... 形態）
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***');
  out = out.replace(/ltj_pat_[A-Za-z0-9]+/gi, 'ltj_pat_***');
  out = out.replace(/Authorization\s*[:=]\s*[^,\s"]+/gi, 'Authorization: ***');
  out = out.replace(/Set-Cookie\s*[:=]\s*[^,\s"]+/gi, 'Set-Cookie: ***');
  // 3. 截短
  if (out.length > 200) out = out.slice(0, 200) + '...(截短)';
  return out;
}

async function postLiteJiraApi(fetchFn, url, token, action, params) {
  const response = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      action,
      params,
      requestId: 'ltj-' + Date.now()
    })
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    throw new Error('API 回傳非 JSON：HTTP ' + response.status);
  }
  if (!response.ok) {
    throw new Error('HTTP ' + response.status + ': ' + sanitizeErrorBody_(text));
  }
  return payload;
}

function parseOptions_(args) {
  const positionals = [];
  const values = {};
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg || arg.indexOf('--') !== 0) {
      positionals.push(arg);
      continue;
    }

    const raw = arg.slice(2);
    const eq = raw.indexOf('=');
    const key = eq === -1 ? raw : raw.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : raw.slice(eq + 1);
    if (key === 'json' || key === 'yes') {
      flags[key] = true;
      continue;
    }

    if (inlineValue !== undefined) {
      values[key] = inlineValue;
    } else if (i + 1 < args.length && String(args[i + 1]).indexOf('--') !== 0) {
      values[key] = args[++i];
    } else {
      values[key] = 'true';
    }
  }
  return { positionals, values, flags };
}

function compactParams_(params) {
  const out = {};
  Object.keys(params).forEach((key) => {
    if (params[key] !== undefined && params[key] !== '') out[key] = params[key];
  });
  return out;
}

function toNumberOrUndefined_(value) {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toBoolOrUndefined_(value) {
  if (value === undefined || value === '') return undefined;
  if (String(value).toLowerCase() === 'false') return false;
  if (String(value).toLowerCase() === 'true') return true;
  return undefined;
}

function formatHuman_(command, data) {
  if (!data) return '';
  if (Array.isArray(data.items)) {
    if (data.items.length === 0) return 'No results';
    return data.items.map(formatItem_).join('\n');
  }
  if (Array.isArray(data.rows)) {
    if (data.rows.length === 0) return 'No results';
    return data.rows.map(formatItem_).join('\n');
  }
  if (command === 'link') return 'Linked ' + (data.childId || '') + ' -> ' + (data.parentId || '');
  if (command === 'attach') return data.added ? 'Attached link' : 'Link already attached';
  if (command === 'reply') return 'Replied to ' + (data.ticketId || '');
  return JSON.stringify(data, null, 2);
}

function formatItem_(item) {
  if (!item || typeof item !== 'object') return String(item);
  return [
    item.id || item.ticketId || '',
    item.title || item.content || item.status || '',
    item.status || '',
    item.assignee || item.author || ''
  ].filter(Boolean).join('\t');
}

function printUsage_(writeLine) {
  writeLine('用法:');
  writeLine('  ltj search [--q text] [--type BUG] [--json]');
  writeLine('  ltj comments <ticketId> [--json]');
  writeLine('  ltj activity <ticketId> [--json]');
  writeLine('  ltj link <childId> <parentId|null> --yes');
  writeLine('  ltj reply <ticketId> --content text --yes');
  writeLine('  ltj attach <ticketId> <url> --yes');
}

module.exports = {
  parseCommand,
  runCli,
  postLiteJiraApi
};

if (require.main === module) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
