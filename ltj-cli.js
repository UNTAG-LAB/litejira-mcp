#!/usr/bin/env node

// GH-257 第一包：CLI 改走對外 API v1（litejira-v1-transport）。
// 預設就是 v1，沒有 legacy 自動 fallback（第四包起 MCP server 也全部走 v1，沒有舊通道可退）。
const {
  callV1,
  LiteJiraApiError,
  LiteJiraTransportError,
  TICKET_FILTER_MULTI_FIELDS,
  TICKET_ID_FILTER_MAX
} = require('./litejira-v1-transport');

// 本機拒絕（送出前就知道不合法 / 契約缺列）→ exit 2；真的打出去才失敗（網路、逾時、業務錯誤）→ exit 1。
const LOCAL_REJECT_CODES = [
  // composite_action＝該 action 在 v1 要拆成多發（updateField / replyFeedback），一樣是送出前就擋下。
  'unknown_action', 'unmapped_action', 'replaced_action', 'composite_action', 'invalid_argument',
  'invalid_base_url', 'missing_token', 'idempotency_key_required', 'fetch_unavailable',
  'aborted'
];

function parseCommand(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const command = args.shift();
  const options = parseOptions_(args);
  const json = !!options.flags.json;
  const yes = !!options.flags.yes;
  // v1 的 Idempotency-Key 走 header，不是 params，故獨立帶出。
  const idempotencyKey = options.values['idempotency-key'];
  // v1 的 expectedUpdatedAt 是 ISO 8601 微秒字串，必須原樣回填讀取端拿到的值；
  // 轉成 number 會掉精度而撞出假的 version_conflict，故刻意不做數值轉換。
  const expectedUpdatedAt = options.values['expected-updated-at'];
  // --project 對 path 端點沒有用途（工單參照本身就唯一）：本機留著給輸出/紀錄，不塞進無關的 body/query。
  const project = options.values.project;

  const base = { command, json, yes, project, idempotencyKey };

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help', action: '', params: {}, json, yes, write: false, idempotencyKey: undefined };
  }

  if (command === 'search') {
    return Object.assign({}, base, {
      action: 'searchTickets',
      // 篩選面（32 個運算子欄 ＋ id）由傳輸層的登錄表展開成旗標，不在本檔抄第二份清單：
      // 抄漏一欄的症狀是靜默的（旗標被當成未知選項丟掉，呼叫端以為有濾到）。
      params: compactParams_(Object.assign({
        project,
        mine: options.values.mine,
        q: options.values.q,
        // 布林旗標：只認 true / false，其他值原樣往下讓傳輸層當面拒絕（不把打錯字當成假）。
        overdue: toBooleanOrRaw_(options.values.overdue),
        // 成員 / 父工單一律 UUID；--assignee 之類的顯示名保留只為了給出明確指路錯誤，不在本層猜人。
        assignee: options.values.assignee,
        owner: options.values.owner,
        creator: options.values.creator,
        version: options.values.version,
        limit: toNumberOrUndefined_(options.values.limit),
        cursor: options.values.cursor,
        sort: options.values.sort,
        order: options.values.order
      }, filterFlags_(options))),
      write: false
    });
  }

  if (command === 'show') {
    return Object.assign({}, base, {
      action: 'getTicket',
      params: compactParams_({ ticket: options.positionals[0] }),
      write: false
    });
  }

  if (command === 'comments') {
    return Object.assign({}, base, {
      action: 'listComments',
      params: compactParams_({
        ticket: options.positionals[0],
        limit: toNumberOrUndefined_(options.values.limit),
        cursor: options.values.cursor,
        order: options.values.order
      }),
      write: false
    });
  }

  if (command === 'activity') {
    return Object.assign({}, base, {
      action: 'getActivityLog',
      params: compactParams_({
        ticket: options.positionals[0],
        limit: toNumberOrUndefined_(options.values.limit),
        cursor: options.values.cursor,
        order: options.values.order,
        // v1 是單選 kind（不帶 = 全部）；舊的兩個布林旗標語意不是一對一，
        // 原樣往下傳讓傳輸層明確拒絕並指路，不在這裡靜默丟掉。
        kind: options.values.kind,
        includeComments: options.values.comments,
        includeSystemEvents: options.values.system
      }),
      write: false
    });
  }

  if (command === 'link') {
    return Object.assign({}, base, {
      action: 'linkTickets',
      params: compactParams_({
        // childId 走路徑，可用 UUID / 舊 key / 數字 key；parentId 走 body，只收 UUID 或 null（解除父子）。
        childId: options.positionals[0],
        parentId: options.positionals[1] === 'null' ? null : options.positionals[1],
        expectedUpdatedAt
      }),
      write: true
    });
  }

  if (command === 'comment' || command === 'reply') {
    return Object.assign({}, base, {
      command: 'comment',
      action: 'addComment',
      params: compactParams_({
        ticketId: options.positionals[0],
        body: options.values.body !== undefined ? options.values.body : options.values.content,
        mentions: options.multi.mention,
        // 舊的流轉 / 樂觀鎖旗標在留言端點沒有對應欄位：原樣往下傳讓傳輸層明確拒絕，
        // 不能偷偷丟掉（丟掉會讓呼叫端誤以為狀態已跟著改）。
        transition: options.values['to-status'] !== undefined ? { toStatus: options.values['to-status'] } : undefined,
        expectedUpdatedAt
      }),
      write: true
    });
  }

  if (command === 'attach') {
    return Object.assign({}, base, {
      action: 'attachLink',
      params: compactParams_({
        ticketId: options.positionals[0],
        url: options.positionals[1],
        name: options.values.name,
        // v1 附件不分 kind：給了就讓傳輸層明講拒絕。
        kind: options.values.kind
      }),
      write: true
    });
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

  if (parsed.write && !parsed.idempotencyKey) {
    output.error('寫入指令需要 --idempotency-key（16-64 字元 [A-Za-z0-9_-]）；重試請沿用同一把 key');
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

  // 與 MCP 相同：我的跨專案查詢不偷偷套用預設專案。
  if (parsed.action === 'searchTickets' && !parsed.params.project && !parsed.params.mine && runtimeEnv.LTJ_PROJECT) {
    parsed.params.project = runtimeEnv.LTJ_PROJECT;
  }

  let result;
  try {
    result = await callV1({
      fetch: fetchFn,
      baseUrl: url,
      token,
      action: parsed.action,
      params: parsed.params,
      idempotencyKey: parsed.idempotencyKey
    });
  } catch (err) {
    if (err instanceof LiteJiraApiError) {
      // 後端裁決：code 原樣印出，呼叫端據此分支（403 有三種互斥語意，不看狀態碼）。
      output.error(err.code + ': ' + err.message);
      return 1;
    }
    if (err instanceof LiteJiraTransportError) {
      output.error(err.code + ': ' + err.message);
      return LOCAL_REJECT_CODES.indexOf(err.code) !== -1 ? 2 : 1;
    }
    output.error(err.message || String(err));
    return 1;
  }

  if (parsed.json) {
    output.log(JSON.stringify(result.data, null, 2));
  } else {
    output.log(formatHuman_(parsed.command, result.data));
  }
  return 0;
}

function parseOptions_(args) {
  const positionals = [];
  const values = {};
  const multi = {};
  const flags = {};
  const remember = (key, value) => {
    values[key] = value;
    // 同名旗標重複出現 = 多值條件；單值參數則由呼叫端只讀 values（取最後一次）。
    if (!multi[key]) multi[key] = [];
    multi[key].push(value);
  };
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
      remember(key, inlineValue);
    } else if (i + 1 < args.length && String(args[i + 1]).indexOf('--') !== 0) {
      remember(key, args[++i]);
    } else {
      remember(key, 'true');
    }
  }
  return { positionals, values, multi, flags };
}

// 查詢參數名 → 旗標名：camelCase 轉 kebab-case（statusGroupNot → --status-group-not、
// titleNotContains → --title-not-contains、assigneeIdNot → --assignee-id-not）。
function flagOf_(param) {
  return param.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

// 全部篩選欄都接受多值：同名旗標重複出現＝聯集（--status open --status doing）。
// 只給一次時仍送單一字串，讓「一個值」的查詢在解析結果裡看起來就是一個值。
function filterFlags_(options) {
  const out = {};
  TICKET_FILTER_MULTI_FIELDS.forEach((param) => {
    const values = options.multi[flagOf_(param)];
    if (!values || values.length === 0) return;
    out[param] = values.length === 1 ? values[0] : values;
  });
  return out;
}

// 布林旗標：只認 true / false 兩個字面。其他值**原樣傳下去**讓傳輸層當面拒絕 ——
// 在這裡靜默當成 false，會讓打錯字與明確指定分不出來（後端 parseBoolean 同一條判準）。
function toBooleanOrRaw_(value) {
  if (value === undefined || value === '') return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
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

function formatHuman_(command, data) {
  if (data === null || data === undefined) return '';
  if (Array.isArray(data)) {
    return data.length === 0 ? 'No results' : data.map(formatItem_).join('\n');
  }
  if (Array.isArray(data.items)) {
    if (data.items.length === 0) return 'No results';
    return data.items.map(formatItem_).join('\n');
  }
  if (command === 'link') return 'Linked ' + (data.key || data.id || '') + ' -> ' + (data.parentId || data.parent || '(none)');
  if (command === 'attach') return 'Attached ' + (data.url || data.name || data.id || '');
  if (command === 'comment') return 'Commented ' + (data.id || '');
  return JSON.stringify(data, null, 2);
}

function formatItem_(item) {
  if (!item || typeof item !== 'object') return String(item);
  return [
    // v1 一律回 { id: UUID, key: 人類編號 }；人眼看 key，看不到才退回 id。
    item.key || item.id || item.ticketId || '',
    item.title || item.content || item.status || '',
    item.status || '',
    formatMemberRef_(item.assignee) || formatMemberRef_(item.author) || ''
  ].filter(Boolean).join('\t');
}

// MemberRef = { id, name } | null（未指派時整個為 null，不是空字串成員）
function formatMemberRef_(member) {
  if (!member) return '';
  if (typeof member === 'string') return member;
  return member.name || member.id || '';
}

function printUsage_(writeLine) {
  writeLine('用法（API v1）:');
  writeLine('  ltj search [--project <project>] [--q <text>] [--limit 50] [--cursor <cursor>]');
  writeLine('             [--sort <排序欄位>] [--order asc|desc]');
  writeLine('             [--type/--status/--status-group/--priority/--module/--subtype <值>]（可重複 = 多值）');
  writeLine('             [--target-version <v>] [--found-version <v>]（可重複）');
  writeLine('             [--assignee-id <uuid>] [--owner-id <uuid>] [--creator-id <uuid>] [--parent-id <uuid>]（可重複）');
  writeLine('             每個上述條件都有「不是」版：加 -not（--status-not、--assignee-id-not、--type-not …）');
  writeLine('             [--title/--title-not/--title-contains/--title-not-contains <文字>]（可重複）');
  writeLine('             [--description/--description-not/--description-contains/--description-not-contains <文字>]');
  writeLine('             [--overdue true|false]（已逾期：有到期日、已過期且未進終態）');
  writeLine('             [--id <uuid>]（可重複，一次最多 ' + TICKET_ID_FILTER_MAX + ' 張；只收 UUID）');
  writeLine('             [--mine assignee|creator|watcher]（跨專案時不可搭配上述任何篩選）');
  writeLine('             專案省略時採用 LTJ_PROJECT；只帶 --mine 時不套用預設專案。');
  writeLine('             肯定條件匹配任一值，-not/-not-contains 排除整個集合；不同條件取交集。--q 跨欄搜尋，');
  writeLine('             只想比對單一欄請用 --title-contains / --description-contains。');
  writeLine('  ltj show <ticket>                       工單詳情（ticket 可用 UUID / 工單 key / 數字 key）');
  writeLine('  ltj comments <ticket> [--limit 50] [--cursor <c>] [--order asc|desc]');
  writeLine('  ltj activity <ticket> [--limit 50] [--cursor <c>] [--order asc|desc] [--kind user|system]');
  writeLine('  ltj link <childId> <parentId-uuid|null> --idempotency-key <key> --yes');
  writeLine('             [--expected-updated-at <ISO8601 微秒字串，原樣回填讀取端的值>]');
  writeLine('  ltj comment <ticketId> --body <text> [--mention <uuid>]（可重複） --idempotency-key <key> --yes');
  writeLine('  ltj attach <ticketId> <http(s) url> [--name <顯示名>] --idempotency-key <key> --yes');
  writeLine('');
  writeLine('注意：成員 / 父工單條件只收 UUID（--assignee-id、link 的 parentId 等），不從顯示名猜人；');
  writeLine('      activity 用 --kind 單選（不帶 = 全部），舊的 --comments/--system 會被明確拒絕；');
  writeLine('      comment 不夾帶狀態流轉，--to-status 會被拒絕，請走獨立的流轉流程；');
  writeLine('      寫入不自動重試；server 端會依 Idempotency-Key 去重，結果不確定時請用「同一把」');
  writeLine('      --idempotency-key 重送（換一把會真的再做一次）。');
}

module.exports = {
  parseCommand,
  runCli
};

if (require.main === module) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
