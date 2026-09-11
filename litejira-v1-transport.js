'use strict';

// GH-257 第一包：對外 API v1 傳輸層。
// 範圍限定：action → REST 映射（本包 7 條路由）、Bearer、Idempotency-Key、
// { data } 信封拆一層、整趟 deadline（fetch + 讀 body 合計）、Abort 清理、
// 禁止跟隨 redirect、URL 合法性。
// 不含：其餘 18 個 MCP tools 的 schema 改寫（下一包）、legacy fallback、寫入自動 retry。

const DEFAULT_TIMEOUT_MS = 20000;
const API_BASE_PATH = '/api/v1';
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

// 錯誤碼 → HTTP 狀態碼。事實源在後端 v2/contracts/src/api-v1.ts（API_ERROR_STATUS）。
// 這裡只當「已知碼」對照表：回應一律以 server 給的 code 為準，不依狀態碼反推語意。
// 特別是 403 底下有三個互斥語意（membership_required / permission_denied / admin_required）。
const API_ERROR_STATUS = Object.freeze({
  unauthenticated: 401,
  membership_required: 403,
  permission_denied: 403,
  admin_required: 403,
  not_found: 404,
  version_conflict: 409,
  state_conflict: 409,
  idempotency_key_reused: 409,
  invalid_argument: 422,
  rate_limited: 429,
  internal: 500
});

// ── 錯誤型別 ──
// LiteJiraApiError = server 回的業務錯誤，code/message/details 原樣保存，不重新編碼。
class LiteJiraApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code || 'LiteJira API error');
    this.name = 'LiteJiraApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// LiteJiraTransportError = 還沒到 server（或 server 回了非契約內容）的本機錯誤。
// code 刻意與 API 錯誤碼分開命名，避免呼叫端把本機拒絕誤判成後端裁決。
//
// 重要：凡是「外部來源」的字串（fetch 的 err.message、回應 body）一律不進 message。
// 脫敏靠黑名單截短無法保證不漏（token 可能被切成任意形狀、body 可能夾帶他人資料），
// 因此改成固定錯誤碼 + 固定文案；要看原文請自行在呼叫端開 debug 攔截。
class LiteJiraTransportError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LiteJiraTransportError';
    this.code = code;
    this.details = details;
  }
}

const SORT_VALUES = Object.freeze(['updatedAt', 'createdAt', 'key']);
const ORDER_VALUES = Object.freeze(['asc', 'desc']);
const ACTIVITY_KIND_VALUES = Object.freeze(['user', 'system']);
const STATS_SCOPE_VALUES = Object.freeze(['all', 'me']);

// 讀取類清單共用的分頁參數（limit / cursor / order）。
const LIST_QUERY_ALLOW = Object.freeze(['limit', 'cursor', 'order']);

// ── action → REST 映射表 ──
// 只收契約已確認的路由；沒查到的 action 一律缺席，呼叫時本機拒絕，
// 絕不用命名慣例推測端點（猜錯會打到別人的路由或靜默走空）。
//
// route 欄位：
//   method        HTTP 方法
//   pathTemplate  相對 /api/v1 的路徑，{name} 由 pathParams 取值
//   query.allow   契約確認過的 query 參數白名單
//   query.uuid    其中必須是 UUID 的參數（成員 / 父工單一律收 UUID，不收顯示名）
//   query.multi   可重複出現的多值參數（陣列 → 重複 query，不用逗號串接）
//   query.enums   固定值域
//   query.int     必須是正整數
//   query.bool    必須是布林（序列化為 true / false）
//   query.required 契約上必填的 query（缺了本機就擋，不送出半套查詢）
//   query.exclusive 互斥組：同一組內最多只能出現一個
//   body.allow / body.required / body.nullable / body.uuid / body.uuidArray / body.url
//   rejected      已知「不可直接沿用舊 MCP 參數名」的映射，附指路訊息
//   contractRef   契約出處
const ACTION_MAP = Object.freeze({
  searchTickets: Object.freeze({
    method: 'GET',
    pathTemplate: '/tickets',
    pathParams: Object.freeze([]),
    query: Object.freeze({
      allow: Object.freeze([
        'project', 'q', 'limit', 'cursor', 'sort', 'order',
        'type', 'status', 'statusGroup', 'priority', 'module', 'subtype',
        'targetVersion', 'foundVersion',
        'assigneeId', 'creatorId', 'ownerId', 'parentId'
      ]),
      uuid: Object.freeze(['assigneeId', 'creatorId', 'ownerId', 'parentId']),
      multi: Object.freeze([
        'type', 'status', 'statusGroup', 'priority', 'module', 'subtype',
        'targetVersion', 'foundVersion'
      ]),
      enums: Object.freeze({ sort: SORT_VALUES, order: ORDER_VALUES }),
      int: Object.freeze(['limit'])
    }),
    rejected: Object.freeze({
      assignee: '成員篩選改用 assigneeId（UUID）；v1 不收顯示名，本層不從姓名猜人',
      owner: '成員篩選改用 ownerId（UUID）',
      creator: '成員篩選改用 creatorId（UUID）',
      parent: '父工單篩選改用 parentId（UUID）',
      version: '版本篩選分成 targetVersion / foundVersion 兩個獨立條件，請明講是哪一個'
    }),
    contractRef: 'GET /api/v1/tickets'
  }),

  getTicket: Object.freeze({
    method: 'GET',
    pathTemplate: '/tickets/{ticket}',
    pathParams: Object.freeze(['ticket']),
    query: Object.freeze({ allow: Object.freeze([]) }),
    contractRef: 'GET /api/v1/tickets/{ticket}'
  }),

  listComments: Object.freeze({
    method: 'GET',
    pathTemplate: '/tickets/{ticket}/comments',
    pathParams: Object.freeze(['ticket']),
    query: Object.freeze({
      allow: LIST_QUERY_ALLOW,
      enums: Object.freeze({ order: ORDER_VALUES }),
      int: Object.freeze(['limit'])
    }),
    contractRef: 'GET /api/v1/tickets/{ticket}/comments'
  }),

  getActivityLog: Object.freeze({
    method: 'GET',
    pathTemplate: '/tickets/{ticket}/activity',
    pathParams: Object.freeze(['ticket']),
    query: Object.freeze({
      allow: Object.freeze(['limit', 'cursor', 'order', 'kind']),
      enums: Object.freeze({ order: ORDER_VALUES, kind: ACTIVITY_KIND_VALUES }),
      int: Object.freeze(['limit'])
    }),
    rejected: Object.freeze({
      // 舊參數是「兩個獨立布林」，v1 是「單一 kind 篩選」，語意不是一對一（兩者皆真 = 不帶 kind）。
      // 靜默丟掉會讓呼叫端以為有濾到，故本機拒絕並指路。
      includeComments: 'v1 改用 kind=user|system 單選；不帶 kind 才是全部。includeComments 無對應參數，請改帶 kind',
      includeSystemEvents: 'v1 改用 kind=user|system 單選；不帶 kind 才是全部。includeSystemEvents 無對應參數，請改帶 kind'
    }),
    contractRef: 'GET /api/v1/tickets/{ticket}/activity'
  }),

  // 可用流轉動作。無任何 query；回應 data 是物件（含 actions 等欄位），不是陣列。
  getAllowedTransitions: Object.freeze({
    method: 'GET',
    pathTemplate: '/tickets/{ticketId}/transitions',
    pathParams: Object.freeze(['ticketId']),
    query: Object.freeze({ allow: Object.freeze([]) }),
    contractRef: 'GET /api/v1/tickets/{ticketId}/transitions'
  }),

  // ── 工作區 / 專案層級的參考資料（resources 用）──
  getMeta: Object.freeze({
    method: 'GET',
    pathTemplate: '/meta',
    pathParams: Object.freeze([]),
    query: Object.freeze({
      allow: Object.freeze(['project']),
      required: Object.freeze(['project'])
    }),
    contractRef: 'GET /api/v1/meta?project=KEY'
  }),

  getWorkflow: Object.freeze({
    method: 'GET',
    pathTemplate: '/workflow',
    pathParams: Object.freeze([]),
    query: Object.freeze({
      allow: Object.freeze(['project', 'type', 'flowGroupCode']),
      required: Object.freeze(['project'])
    }),
    contractRef: 'GET /api/v1/workflow?project=KEY&type=TYPE&flowGroupCode=CODE'
  }),

  // 成員是「工作區名冊」，契約上不收 project：硬塞會打出不存在的查詢條件。
  getMembers: Object.freeze({
    method: 'GET',
    pathTemplate: '/members',
    pathParams: Object.freeze([]),
    query: Object.freeze({
      allow: Object.freeze(['activeOnly', 'jobRole']),
      bool: Object.freeze(['activeOnly'])
    }),
    rejected: Object.freeze({
      project: '成員清單是工作區層級名冊，v1 不收 project；請移除該條件'
    }),
    contractRef: 'GET /api/v1/members?activeOnly=true&jobRole=ROLE'
  }),

  getVersions: Object.freeze({
    method: 'GET',
    pathTemplate: '/versions',
    pathParams: Object.freeze([]),
    query: Object.freeze({
      allow: Object.freeze(['project']),
      required: Object.freeze(['project'])
    }),
    contractRef: 'GET /api/v1/versions?project=KEY'
  }),

  // scope / targetVersion / role 三者互斥（scope 省略時 server 端預設 all）。
  getDashboardStats: Object.freeze({
    method: 'GET',
    pathTemplate: '/stats',
    pathParams: Object.freeze([]),
    query: Object.freeze({
      allow: Object.freeze(['project', 'scope', 'targetVersion', 'role']),
      required: Object.freeze(['project']),
      enums: Object.freeze({ scope: STATS_SCOPE_VALUES }),
      exclusive: Object.freeze([Object.freeze(['scope', 'targetVersion', 'role'])])
    }),
    contractRef: 'GET /api/v1/stats?project=KEY&scope=all|me'
  }),

  linkTickets: Object.freeze({
    method: 'PUT',
    // childId 走路徑，可帶 UUID / 舊 key / 純數字 key；parentId 走 body，只收 UUID 或 null（解除）。
    pathTemplate: '/tickets/{childId}/parent',
    pathParams: Object.freeze(['childId']),
    query: Object.freeze({ allow: Object.freeze([]) }),
    body: Object.freeze({
      allow: Object.freeze(['parentId', 'expectedUpdatedAt']),
      required: Object.freeze(['parentId']),
      nullable: Object.freeze(['parentId']),
      uuid: Object.freeze(['parentId'])
    }),
    contractRef: 'PUT /api/v1/tickets/{childId}/parent'
  }),

  addComment: Object.freeze({
    method: 'POST',
    pathTemplate: '/tickets/{ticketId}/comments',
    pathParams: Object.freeze(['ticketId']),
    query: Object.freeze({ allow: Object.freeze([]) }),
    body: Object.freeze({
      allow: Object.freeze(['body', 'mentions']),
      required: Object.freeze(['body']),
      string: Object.freeze(['body']),
      uuidArray: Object.freeze(['mentions'])
    }),
    rejected: Object.freeze({
      // 留言端點不做樂觀鎖、也不順便流轉狀態；偷偷丟掉會讓呼叫端誤以為狀態已改。
      expectedUpdatedAt: '留言端點不收 expectedUpdatedAt（不做樂觀鎖）；請移除',
      transition: '留言不再夾帶狀態流轉，請改走獨立的流轉流程後再留言',
      toStatus: '留言不再夾帶狀態流轉，請改走獨立的流轉流程後再留言',
      content: '留言內文參數名是 body（string）'
    }),
    contractRef: 'POST /api/v1/tickets/{ticketId}/comments'
  }),

  attachLink: Object.freeze({
    method: 'POST',
    pathTemplate: '/tickets/{ticketId}/attachments',
    pathParams: Object.freeze(['ticketId']),
    query: Object.freeze({ allow: Object.freeze([]) }),
    body: Object.freeze({
      allow: Object.freeze(['url', 'name']),
      required: Object.freeze(['url']),
      string: Object.freeze(['url', 'name']),
      url: Object.freeze(['url'])
    }),
    rejected: Object.freeze({
      kind: 'v1 附件不分 kind，只收 { url, name? }'
    }),
    contractRef: 'POST /api/v1/tickets/{ticketId}/attachments'
  })
});

// v1 沒有對應端點、但舊 MCP / CLI 仍可能傳進來的 action：明講改走哪裡，不當成 unknown。
const REPLACED_ACTIONS = Object.freeze({
  replyFeedback: 'v1 沒有 replyFeedback；留言請用 addComment（POST /tickets/{ticketId}/comments），狀態流轉是另一條獨立流程'
});

// 尚未納入的舊 action（第三包處理）。第二包補齊了全部讀取路由，
// 剩下的清一色是寫入端點，契約未取得前一律本機拒絕，不會退回舊後端。
// 列在這裡是為了讓錯誤訊息能明講「缺哪一列契約」，而不是回一句籠統的 unknown。
const PENDING_CONTRACT_ACTIONS = Object.freeze([
  'removeAttachment', 'updateField', 'createTicket', 'reassignTicket',
  'convertTicketType', 'toggleWatchTicket', 'transitionTicket',
  'batchTransition', 'batchReassign', 'batchSetField'
]);

function isWriteMethod(method) {
  return WRITE_METHODS.indexOf(String(method).toUpperCase()) !== -1;
}

function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.indexOf(String(hostname).toLowerCase()) !== -1;
}

function has_(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// 正式站一律 https；http 只放行明確 loopback 本機。其餘協定、帶帳密、帶 query/hash 的 base 一概拒絕。
function normalizeBaseUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw new LiteJiraTransportError('invalid_base_url', 'API base URL 未設定（LTJ_API_URL）');
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch (err) {
    throw new LiteJiraTransportError('invalid_base_url', 'API base URL 不是合法 URL');
  }
  if (parsed.username || parsed.password) {
    throw new LiteJiraTransportError('invalid_base_url', 'API base URL 不可內嵌帳密（會與 Bearer 一起外洩）');
  }
  if (parsed.search || parsed.hash) {
    throw new LiteJiraTransportError('invalid_base_url', 'API base URL 不可帶 query 或 fragment');
  }
  if (parsed.protocol === 'http:') {
    if (!isLoopbackHost(parsed.hostname)) {
      throw new LiteJiraTransportError('invalid_base_url',
        'http 只允許明確本機 loopback（localhost / 127.0.0.1 / ::1）；對外站台必須 https');
    }
  } else if (parsed.protocol !== 'https:') {
    throw new LiteJiraTransportError('invalid_base_url', '只接受 https（或本機 loopback http）');
  }
  let path = parsed.pathname.replace(/\/+$/, '');
  if (path.slice(-API_BASE_PATH.length) !== API_BASE_PATH) path += API_BASE_PATH;
  return parsed.origin + path;
}

function resolveRoute(action) {
  const route = has_(ACTION_MAP, action) ? ACTION_MAP[action] : null;
  if (route) return route;
  if (has_(REPLACED_ACTIONS, action)) {
    throw new LiteJiraTransportError('replaced_action',
      'action「' + action + '」在 v1 已被取代：' + REPLACED_ACTIONS[action],
      { action: action, mapped: Object.keys(ACTION_MAP) });
  }
  if (PENDING_CONTRACT_ACTIONS.indexOf(action) !== -1) {
    throw new LiteJiraTransportError('unmapped_action',
      'action「' + action + '」的 v1 端點契約尚未納入本包，本機拒絕送出（不編造路由）。' +
      '請補上該 action 的 method/path/query/body 契約列後再啟用。',
      { action: action, mapped: Object.keys(ACTION_MAP) });
  }
  throw new LiteJiraTransportError('unknown_action',
    '未知 action：' + action + '（本機拒絕，不送出請求）',
    { action: action, mapped: Object.keys(ACTION_MAP) });
}

function invalidArg_(message, details) {
  return new LiteJiraTransportError('invalid_argument', message, details);
}

function assertRejected_(route, key) {
  const rejected = route.rejected || {};
  if (has_(rejected, key)) {
    throw invalidArg_('參數「' + key + '」不適用 v1：' + rejected[key], { param: key });
  }
}

function serializeQueryValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function buildQuery(route, params) {
  const spec = route.query || {};
  const allow = spec.allow || [];
  const uuidKeys = spec.uuid || [];
  const multiKeys = spec.multi || [];
  const intKeys = spec.int || [];
  const boolKeys = spec.bool || [];
  const enums = spec.enums || {};
  const search = new URLSearchParams();
  const present = [];

  Object.keys(params || {}).forEach((key) => {
    const value = params[key];
    if (value === undefined || value === null || value === '') return;
    assertRejected_(route, key);
    if (allow.indexOf(key) === -1) {
      throw invalidArg_(
        '參數「' + key + '」尚未在 v1 契約中確認（' + route.contractRef + '），本機拒絕送出以免打出不存在的查詢。',
        { param: key, allowed: allow.slice() });
    }

    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0) return;
    if (values.length > 1 && multiKeys.indexOf(key) === -1) {
      throw invalidArg_('參數「' + key + '」不接受多值（v1 只允許單一值）', { param: key });
    }

    values.forEach((one) => {
      if (one === undefined || one === null || one === '') {
        throw invalidArg_('參數「' + key + '」的多值清單不可含空值', { param: key });
      }
      if (uuidKeys.indexOf(key) !== -1 && !UUID_PATTERN.test(String(one))) {
        throw invalidArg_('參數「' + key + '」必須是 UUID（v1 成員 / 父工單身分不收顯示名或工單編號）', { param: key });
      }
      if (intKeys.indexOf(key) !== -1 && !isPositiveInt_(one)) {
        throw invalidArg_('參數「' + key + '」必須是正整數', { param: key });
      }
      if (boolKeys.indexOf(key) !== -1 && typeof one !== 'boolean') {
        throw invalidArg_('參數「' + key + '」必須是布林值（true / false）', { param: key });
      }
      if (enums[key] && enums[key].indexOf(String(one)) === -1) {
        throw invalidArg_('參數「' + key + '」只接受 ' + enums[key].join(' | '),
          { param: key, allowed: enums[key].slice() });
      }
      // 多值一律用重複 query（?status=a&status=b），不做逗號串接。
      search.append(key, serializeQueryValue(one));
    });
    present.push(key);
  });

  // 必填 query 缺席 → 本機擋下。不自動代入任何猜來的值（例如「第一個專案」）。
  (spec.required || []).forEach((key) => {
    if (present.indexOf(key) === -1) {
      throw invalidArg_('缺少必填查詢參數：' + key + '（' + route.contractRef + '）', { param: key });
    }
  });

  // 互斥組：同組內給超過一個等於語意衝突，靜默取一個會回錯資料。
  (spec.exclusive || []).forEach((group) => {
    const given = group.filter((key) => present.indexOf(key) !== -1);
    if (given.length > 1) {
      throw invalidArg_('參數 ' + group.join(' / ') + ' 互斥，一次只能帶一個（收到：' + given.join('、') + '）',
        { params: given, exclusive: group.slice() });
    }
  });

  return search;
}

function isPositiveInt_(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n > 0;
}

function buildPath(route, params) {
  let path = route.pathTemplate;
  (route.pathParams || []).forEach((name) => {
    const value = params ? params[name] : undefined;
    if (value === undefined || value === null || value === '') {
      throw invalidArg_('缺少路徑參數：' + name, { param: name });
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw invalidArg_('路徑參數「' + name + '」必須是字串或數字（UUID / 工單 key / 數字 key）', { param: name });
    }
    // 工單參照可以是 UUID、舊字母 key（BUG-481）或純數字 key，路徑一律 encode 後帶出。
    path = path.replace('{' + name + '}', encodeURIComponent(String(value)));
  });
  return path;
}

function buildBody(route, params) {
  const spec = route.body;
  if (!spec) return undefined;
  const allow = spec.allow || [];
  const required = spec.required || [];
  const nullable = spec.nullable || [];
  const uuidKeys = spec.uuid || [];
  const uuidArrayKeys = spec.uuidArray || [];
  const stringKeys = spec.string || [];
  const urlKeys = spec.url || [];
  const out = {};

  Object.keys(params || {}).forEach((key) => {
    const value = params[key];
    if (value === undefined) return;
    assertRejected_(route, key);
    if (allow.indexOf(key) === -1) {
      throw invalidArg_('參數「' + key + '」不在 v1 body 契約內（' + route.contractRef + '）',
        { param: key, allowed: allow.slice() });
    }
    if (value === null) {
      if (nullable.indexOf(key) === -1) {
        throw invalidArg_('參數「' + key + '」不可為 null', { param: key });
      }
      out[key] = null;
      return;
    }
    if (stringKeys.indexOf(key) !== -1) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw invalidArg_('參數「' + key + '」必須是非空字串', { param: key });
      }
    }
    if (uuidKeys.indexOf(key) !== -1 && !UUID_PATTERN.test(String(value))) {
      throw invalidArg_('參數「' + key + '」必須是 UUID（要解除關聯請明確傳 null）', { param: key });
    }
    if (uuidArrayKeys.indexOf(key) !== -1) {
      if (!Array.isArray(value)) {
        throw invalidArg_('參數「' + key + '」必須是 UUID 陣列', { param: key });
      }
      value.forEach((one) => {
        if (!UUID_PATTERN.test(String(one))) {
          throw invalidArg_('參數「' + key + '」只收 UUID（不收顯示名）', { param: key });
        }
      });
    }
    if (urlKeys.indexOf(key) !== -1) {
      assertHttpUrl_(key, value);
    }
    out[key] = value;
  });

  required.forEach((key) => {
    if (!has_(out, key)) {
      throw invalidArg_('缺少必填 body 參數：' + key + '（' + route.contractRef + '）', { param: key });
    }
  });
  return out;
}

function assertHttpUrl_(key, value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch (err) {
    throw invalidArg_('參數「' + key + '」不是合法 URL', { param: key });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalidArg_('參數「' + key + '」只接受 http / https URL', { param: key });
  }
}

// 組出完整請求（不送）。測試以此驗 method / path / query / body / headers。
function buildRequest(options) {
  const opts = options || {};
  const route = resolveRoute(opts.action);
  const base = normalizeBaseUrl(opts.baseUrl);
  const params = opts.params || {};

  const pathParamNames = route.pathParams || [];
  const rest = {};
  Object.keys(params).forEach((key) => {
    if (pathParamNames.indexOf(key) === -1) rest[key] = params[key];
  });

  const path = buildPath(route, params);
  const write = isWriteMethod(route.method);
  // 寫入路由的非路徑參數走 body，不再另外拼 query（本包 3 條寫入路由都沒有 query）。
  const search = write ? buildQuery(route, {}) : buildQuery(route, rest);
  const queryString = search.toString();
  const url = base + path + (queryString ? '?' + queryString : '');

  const token = opts.token;
  if (typeof token !== 'string' || token === '') {
    throw new LiteJiraTransportError('missing_token', '缺少 API token（LTJ_API_TOKEN）');
  }

  const headers = {
    Accept: 'application/json',
    Authorization: 'Bearer ' + token
  };

  let body;
  if (write) {
    const payload = buildBody(route, rest);
    if (payload !== undefined) {
      body = JSON.stringify(payload);
      headers['Content-Type'] = 'application/json';
    }
    // Idempotency-Key 只走 header，永遠不進 body / query。
    const key = opts.idempotencyKey;
    if (key === undefined || key === null || key === '') {
      throw new LiteJiraTransportError('idempotency_key_required',
        '寫入必須帶 Idempotency-Key（16-64 字元 [A-Za-z0-9_-]）；重試請沿用同一把 key', { action: opts.action });
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(String(key))) {
      throw invalidArg_('Idempotency-Key 格式錯誤（需 ^[A-Za-z0-9_-]{16,64}$）', { param: 'idempotencyKey' });
    }
    headers['Idempotency-Key'] = String(key);
  }
  // 讀取路由沒有 body 契約，buildQuery 已把未確認參數擋掉，這裡不會誤帶 body。
  // GET 不去重：即使呼叫端塞了 key 也不掛上去（掛了是雜訊，server 也不看）。

  return { method: route.method, url: url, headers: headers, body: body, write: write, route: route };
}

function isErrorEnvelope_(payload) {
  return !!payload && typeof payload === 'object' && !!payload.error &&
    typeof payload.error === 'object' && typeof payload.error.code === 'string';
}

// 成功信封：本包所有路由的 2xx 都是 { data: ... }。
// 缺 data / 回 null / 回 HTML（解析失敗）一律當 invalid_response，不放行讓上層吃到 undefined。
function isDataEnvelope_(payload) {
  return !!payload && typeof payload === 'object' && !Array.isArray(payload) &&
    has_(payload, 'data') && payload.data !== undefined;
}

function normalizeTimeoutMs_(value) {
  if (value === undefined || value === null) return DEFAULT_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw invalidArg_('timeoutMs 必須是有限正整數毫秒', { param: 'timeoutMs' });
  }
  return value;
}

// 整趟 deadline：一支 timer 同時覆蓋 fetch 與讀 body。
// 只 abort 是不夠的 —— 注入的 fetch / text 可能忽略 signal 而永遠不 settle，
// 所以 deadline 本身是一個會 reject 的 promise，用 race 保證整趟一定收斂。
function createDeadline_(timeoutMs, controller) {
  const state = { expired: false, timer: null, promise: null };
  state.promise = new Promise((resolve, reject) => {
    state.timer = setTimeout(() => {
      state.expired = true;
      try { controller.abort(); } catch (err) { /* abort 失敗不影響 deadline 收斂 */ }
      reject(new LiteJiraTransportError('timeout',
        '請求逾時（' + timeoutMs + 'ms，含讀取回應內容）', { timeoutMs: timeoutMs }));
    }, timeoutMs);
  });
  // deadline 有可能沒人 race 到（正常路徑先完成），先掛一個 no-op 避免 unhandled rejection。
  state.promise.catch(() => {});
  state.clear = function () {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  };
  return state;
}

// 逾時後才姍姍來遲的 response：把 body 收掉，別留著懸空的 stream / unhandled rejection。
function consumeLate_(value) {
  if (!value || typeof value !== 'object') return;
  try {
    const stream = value.body;
    if (stream && typeof stream.cancel === 'function') {
      swallow_(stream.cancel());
      return;
    }
    if (typeof value.text === 'function') {
      swallow_(value.text());
    }
  } catch (err) { /* 收尾失敗就算了，不能反過來影響已經回傳的逾時錯誤 */ }
}

function swallow_(maybePromise) {
  if (maybePromise && typeof maybePromise.catch === 'function') maybePromise.catch(() => {});
}

// 讓 promise 與 deadline 賽跑；deadline 贏時把遲到的結果安全消化掉。
function raceDeadline_(promise, deadline, onLate) {
  const wrapped = Promise.resolve(promise);
  wrapped.then(
    (value) => { if (deadline.expired && onLate) onLate(value); },
    () => { /* 遲到的失敗不需要再被處理，但必須有人接手避免 unhandled rejection */ }
  );
  return Promise.race([wrapped, deadline.promise]);
}

// 單發呼叫。不做 legacy fallback、不做寫入重試：不確定的寫入結果交由呼叫端以同一把 key 重試。
async function callV1(options) {
  const opts = options || {};
  const fetchFn = opts.fetch || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new LiteJiraTransportError('fetch_unavailable', '目前 runtime 沒有 fetch；請使用 Node 18+ 或注入 fetch');
  }

  const timeoutMs = normalizeTimeoutMs_(opts.timeoutMs);
  const external = opts.signal;
  // 外部 signal 已經 aborted：一次 fetch 都不要發。
  if (external && external.aborted) {
    throw new LiteJiraTransportError('aborted', '呼叫端已取消請求（未送出）');
  }

  const request = buildRequest(opts);

  const controller = new AbortController();
  const deadline = createDeadline_(timeoutMs, controller);
  let externallyAborted = false;
  const onExternalAbort = () => {
    externallyAborted = true;
    try { controller.abort(); } catch (err) { /* noop */ }
  };
  if (external) external.addEventListener('abort', onExternalAbort);

  const classify_ = (err) => {
    if (err instanceof LiteJiraTransportError) return err;
    if (err instanceof LiteJiraApiError) return err;
    if (deadline.expired) {
      return new LiteJiraTransportError('timeout',
        '請求逾時（' + timeoutMs + 'ms，含讀取回應內容）', { timeoutMs: timeoutMs });
    }
    if (externallyAborted) return new LiteJiraTransportError('aborted', '呼叫端已取消請求');
    // 原始 err.message 可能夾帶 URL、header、body 片段；一律不轉述。
    return new LiteJiraTransportError('network_error',
      '連線失敗（原始錯誤訊息不轉述，以免夾帶憑證或他人資料）');
  };

  try {
    let response;
    try {
      response = await raceDeadline_(
        fetchFn(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          // 不跟隨 redirect：跟了會把 Authorization 帶去未經驗證的目的地。
          redirect: 'manual',
          signal: controller.signal
        }),
        deadline,
        consumeLate_
      );
    } catch (err) {
      throw classify_(err);
    }

    if (!response || typeof response.status !== 'number' || typeof response.text !== 'function') {
      throw new LiteJiraTransportError('invalid_response', 'fetch 回傳的不是 Response');
    }

    const status = response.status;
    if (status >= 300 && status < 400) {
      throw new LiteJiraTransportError('redirect_blocked',
        'API 回了 HTTP ' + status + ' redirect；為避免 Bearer 外洩不跟隨，請改設正確的 base URL',
        { status: status });
    }

    let text;
    try {
      text = await raceDeadline_(response.text(), deadline, null);
    } catch (err) {
      throw classify_(err);
    }

    let payload = null;
    let parsed = false;
    if (typeof text === 'string' && text.trim() !== '') {
      try {
        payload = JSON.parse(text);
        parsed = true;
      } catch (err) {
        // 不附 body 片段：HTML 錯誤頁可能夾帶 session / 他人資料，脫敏無法保證乾淨。
        throw new LiteJiraTransportError('invalid_response',
          'API 回傳非 JSON（HTTP ' + status + '；內容不轉述）', { status: status });
      }
    }

    if (status >= 200 && status < 300) {
      if (!parsed || !isDataEnvelope_(payload)) {
        throw new LiteJiraTransportError('invalid_response',
          'HTTP ' + status + ' 但回應不是 { data } 契約形狀（內容不轉述）', { status: status });
      }
      // 拆掉唯一一層信封：回傳的 data 就是契約裡的 data，呼叫端不會再看到 data.data。
      return { ok: true, status: status, data: payload.data };
    }

    if (isErrorEnvelope_(payload)) {
      // error.code / message / details 原樣保存，狀態碼另外附上供記錄，不用來反推語意。
      throw new LiteJiraApiError(status, payload.error.code, payload.error.message, payload.error.details);
    }

    throw new LiteJiraTransportError('invalid_response',
      'HTTP ' + status + ' 但回應不是 { error: { code, message } } 契約形狀（內容不轉述）',
      { status: status });
  } finally {
    deadline.clear();
    if (external) external.removeEventListener('abort', onExternalAbort);
  }
}

module.exports = {
  ACTION_MAP,
  ACTIVITY_KIND_VALUES,
  API_BASE_PATH,
  API_ERROR_STATUS,
  DEFAULT_TIMEOUT_MS,
  IDEMPOTENCY_KEY_PATTERN,
  LiteJiraApiError,
  LiteJiraTransportError,
  ORDER_VALUES,
  PENDING_CONTRACT_ACTIONS,
  REPLACED_ACTIONS,
  SORT_VALUES,
  STATS_SCOPE_VALUES,
  UUID_PATTERN,
  buildRequest,
  callV1,
  normalizeBaseUrl,
  resolveRoute
};
