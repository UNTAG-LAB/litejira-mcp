'use strict';

// GH-257：對外 API v1 傳輸層。
// 範圍：action → REST 映射、Bearer、Idempotency-Key、{ data } 信封拆一層、
// 整趟 deadline（fetch + 讀 body 合計）、Abort 清理、禁止跟隨 redirect、URL 合法性。
// 第三包補上 9 條基本寫入路由（建單 / 留言 / 附件 / 父子 / 轉派 / 轉型 / 關注 / 流轉）。
// 仍不含：replyFeedback（流轉＋留言複合）、updateField 與三個 batch 的 v1 契約、
// legacy fallback、寫入自動 retry。

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

// 工單參照三形狀：UUID 主鍵 / 公開 key（BUG-481）/ 純數字 key。
// 路徑參數本來就通用這三種；批次的 tickets[] 也是同一組形狀，故抽成常數共用。
const TICKET_REF_PATTERN = /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[A-Za-z]+-\d+|\d+)$/;
// 批次端點的上限：一發最多 100 張（契約值，不是客戶端自訂的保守值）。
const BATCH_MAX_TICKETS = 100;

// ── 第四包：可直接 PATCH 的「一般欄位」全集 ──
// 這些欄位走 PATCH /tickets/{ticket}，body 是平攤的 { [欄位]: 值 }。
// 不在這裡的四類各有專屬端點（狀態 / 父子 / 處理人 / 版本），硬塞進 PATCH 只會被伺服器丟掉。
const NORMAL_FIELDS = Object.freeze([
  'title', 'priority', 'description', 'module', 'subtype', 'releaseMethod',
  'stdLevel2', 'stdLevel3', 'startDate', 'dueDate', 'tags', 'mrUrl',
  'reproSteps', 'expectedResult', 'fixMethod', 'validationMethod',
  'verifiableVersionAlpha', 'verifiableVersionRelease', 'ownerId'
]);
const NORMAL_TEXT_FIELDS = Object.freeze([
  'title', 'priority', 'description', 'module', 'subtype', 'releaseMethod',
  'stdLevel2', 'stdLevel3', 'mrUrl',
  'reproSteps', 'expectedResult', 'fixMethod', 'validationMethod',
  'verifiableVersionAlpha', 'verifiableVersionRelease'
]);
// 空字串是合法值（＝寫入空值）的文字欄位。
// title 例外（後端要求非空）；priority / releaseMethod 是受控值，空字串不在值域內。
const NORMAL_EMPTY_OK_FIELDS = Object.freeze(NORMAL_TEXT_FIELDS.filter(function (key) {
  return key !== 'title' && key !== 'priority' && key !== 'releaseMethod';
}));
// null ＝ 明確清空。title 不列入：後端連空字串都不收，清掉標題不是合法操作。
const NORMAL_NULLABLE_FIELDS = Object.freeze(NORMAL_FIELDS.filter(function (key) {
  return key !== 'title';
}));
// 一般欄位的值形狀（PATCH 與批次 fields 共用同一份，避免兩邊漂移）。
const NORMAL_FIELD_SHAPE = Object.freeze({
  nullable: NORMAL_NULLABLE_FIELDS,
  string: NORMAL_TEXT_FIELDS,
  allowEmptyString: NORMAL_EMPTY_OK_FIELDS,
  uuid: Object.freeze(['ownerId']),
  date: Object.freeze(['startDate', 'dueDate']),
  stringArray: Object.freeze(['tags'])
});
// 批次 fields 物件可放的鍵：一般欄位 + parentId。
// parentId 在批次是「工單參照」（可用公開 key），與單張的 PUT /parent 只收 UUID 不同 —— 這是契約差異，不是筆誤。
const BATCH_FIELD_KEYS = Object.freeze(NORMAL_FIELDS.concat(['parentId']));
const BATCH_FIELD_SHAPE = Object.freeze({
  nullable: Object.freeze(NORMAL_NULLABLE_FIELDS.concat(['parentId'])),
  string: NORMAL_TEXT_FIELDS,
  allowEmptyString: NORMAL_EMPTY_OK_FIELDS,
  uuid: NORMAL_FIELD_SHAPE.uuid,
  date: NORMAL_FIELD_SHAPE.date,
  stringArray: NORMAL_FIELD_SHAPE.stringArray,
  ticketRef: Object.freeze(['parentId'])
});

// GH-313：可排序欄位的事實源是後端 contracts 的工單欄位登錄表（`TICKET_FIELDS` 的 `sortable` 旗標，
// v2/contracts/src/ticket-fields.ts:29-67），推導出 15 欄。
// 舊版只列 updatedAt / createdAt / key —— 那不是契約值，是漏抄：後果是合法的
// `sort=priority`、`sort=dueDate` 在本機就被擋掉，呼叫端拿到「客戶端說不行」而伺服器其實收。
const SORT_VALUES = Object.freeze([
  'updatedAt', 'createdAt', 'key', 'type', 'title', 'status', 'priority',
  'assignee', 'owner', 'creator', 'module', 'targetVersion', 'foundVersion',
  'startDate', 'dueDate'
]);
const ORDER_VALUES = Object.freeze(['asc', 'desc']);
// GH-313：唯一天然跨專案的篩選維度（後端 read-queries.ts 的 `MINE_DIMS`，R-A15 三）。
const MINE_VALUES = Object.freeze(['assignee', 'creator', 'watcher']);

// ── 工單篩選維度登錄表（後端 P4.2d／P5.6 的完整查詢面）──────────────────────
//
// 事實源逐項對照：
//   `ENUM_FILTER_DIMS` / `TEXT_FILTER_DIMS`  → v2/server/src/api/v1/read-queries.ts
//   四個運算子欄的展開與 `overdue` 的布林解析 → v2/server/src/api/v1/routes/ticket-filter.ts
//   `id` 的 UUID 形狀與上限             → 同檔 `TICKET_ID_FILTER_MAX`
//
// 🔴 **這裡放維度、不放展開後的欄位名**：展開由 `expandFilterFields_` 做，
// 白名單、多值表、UUID 表全部從同兩張清單推導 —— 手抄一份三十幾列的欄位名，
// 漏掉其中一列的症狀是靜默的（參數被本機丟掉、呼叫端以為有濾到）。
const ENUM_FILTER_DIMS = Object.freeze([
  'type', 'status', 'statusGroup', 'priority', 'module', 'subtype',
  'targetVersion', 'foundVersion', 'assigneeId', 'creatorId', 'ownerId', 'parentId'
]);
// 列舉維度各兩個運算子欄：`X`（是）與 `XNot`（不是）。
const ENUM_FILTER_OPS = Object.freeze(['', 'Not']);
// 文字維度四個運算子欄。與 `q` 不是同一件事：`q` 是跨欄合併搜尋，這兩個維度各只看一欄。
const TEXT_FILTER_DIMS = Object.freeze(['title', 'description']);
const TEXT_FILTER_OPS = Object.freeze(['', 'Not', 'Contains', 'NotContains']);
// 值是識別碼（UUID）的列舉維度：本機先擋形狀，讓「傳了姓名」拿到看得懂的錯誤而不是空清單。
const UUID_FILTER_DIMS = Object.freeze(['assigneeId', 'creatorId', 'ownerId', 'parentId']);
// `?id=` 一次最多指名幾張（後端 `TICKET_ID_FILTER_MAX`）。有界是守門不是禮貌：
// 沒有上界時 `?id=` 可以拿來一次探測幾千個 UUID 的存在性。
const TICKET_ID_FILTER_MAX = 50;

function expandFilterFields_(dims, ops) {
  const out = [];
  dims.forEach((dim) => { ops.forEach((op) => { out.push(dim + op); }); });
  return out;
}

// 三十二個運算子欄（12 × 2 ＋ 2 × 4）。順序＝維度順序 × 運算子順序，兩層都由上面的清單決定。
const TICKET_FILTER_FIELDS = Object.freeze(
  expandFilterFields_(ENUM_FILTER_DIMS, ENUM_FILTER_OPS)
    .concat(expandFilterFields_(TEXT_FILTER_DIMS, TEXT_FILTER_OPS)));
// 其中值必須是 UUID 的（四個成員／母單維度 × 兩個運算子）＋ 指名清單 `id`。
const TICKET_FILTER_UUID_FIELDS = Object.freeze(
  expandFilterFields_(UUID_FILTER_DIMS, ENUM_FILTER_OPS).concat(['id']));
// 全部篩選欄都是多值（後端 `multiParam`：同名參數重複出現＝聯集）；`id` 同樣是多值。
const TICKET_FILTER_MULTI_FIELDS = Object.freeze(TICKET_FILTER_FIELDS.concat(['id']));
// 範圍 / 排序 / 分頁以外的完整查詢面。`overdue` 是布林（後端只認 true／false 兩個字面）。
const TICKET_QUERY_FIELDS = Object.freeze(TICKET_FILTER_MULTI_FIELDS.concat(['q', 'overdue']));
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
//   methodSwitch  由某個布林參數決定 method（例：關注 = PUT / 取消關注 = DELETE）。
//                 與 method 二擇一；該參數只決定動詞，不進 body / query。
//   pathTemplate  相對 /api/v1 的路徑，{name} 由 pathParams 取值
//   pathUuid      路徑參數中必須是 UUID 的（例：attachmentId —— 不是 url、不是序號）
//   emptyBody     契約上明講「204 無 body」的路由才可設；沒設的路由收到空 body 一律視為違約
//   query.allow   契約確認過的 query 參數白名單
//   query.uuid    其中必須是 UUID 的參數（成員 / 父工單一律收 UUID，不收顯示名）
//   query.multi   可重複出現的多值參數（陣列 → 重複 query，不用逗號串接）
//   query.enums   固定值域
//   query.int     必須是正整數
//   query.bool    必須是布林（序列化為 true / false）
//   query.maxValues 多值參數的值數上限（超過一律本機擋下，不截斷成前 N 個）
//   query.required 契約上必填的 query（缺了本機就擋，不送出半套查詢）
//   query.exclusive 互斥組：同一組內最多只能出現一個
//   body.allow / body.required / body.nullable / body.uuid / body.uuidArray / body.url
//   body.isoString 樂觀鎖時間戳等「原始 ISO 字串」欄位：只收讀取端拿到的原字串，
//                  不接受 number（Date → ms 會掉微秒精度，撞出假的 version_conflict）
//   body.object   必須是 plain object 的欄位（例：流轉的 fields）
//   body.date     純日期欄位：YYYY-MM-DD（不含時間 / 時區，避免換算後落到前後一天）
//   body.stringArray 字串陣列欄位（例：tags）；要清空請傳 null，不是空字串
//   rejected      已知「不可直接沿用舊 MCP 參數名」的映射，附指路訊息
//   contractRef   契約出處
const ACTION_MAP = Object.freeze({
  // GH-313：**專案是必填的**（後端 queries/tickets.ts 的 `applyScope`，R-A15 一逐字：
  // 「都沒帶 → 422」，不是回全部也不是回空）。唯一的跨專案入口是 `mine`（R-A15 三），
  // 而跨專案時**一般篩選一律被拒**（R-A15 四），不是被忽略。
  // 這三條在本機重述一次的理由與本檔一貫：送出去會拿到 422，當面擋下才講得出「該怎麼改」。
  searchTickets: Object.freeze({
    method: 'GET',
    pathTemplate: '/tickets',
    pathParams: Object.freeze([]),
    query: Object.freeze({
      // 範圍（project / mine）＋ 排序分頁 ＋ 完整篩選面（32 個運算子欄 ＋ q ＋ overdue ＋ id）。
      // 篩選那一段由維度登錄表展開，不逐欄手抄 —— 見 `TICKET_FILTER_FIELDS` 檔頭。
      allow: Object.freeze(
        ['project', 'mine', 'limit', 'cursor', 'sort', 'order'].concat(TICKET_QUERY_FIELDS)),
      uuid: TICKET_FILTER_UUID_FIELDS,
      multi: TICKET_FILTER_MULTI_FIELDS,
      enums: Object.freeze({ sort: SORT_VALUES, order: ORDER_VALUES, mine: MINE_VALUES }),
      int: Object.freeze(['limit']),
      bool: Object.freeze(['overdue']),
      // `id` 的上限與後端同一個數字：超過就是本機擋下，不送出一發必定 422 的查詢。
      maxValues: Object.freeze({ id: TICKET_ID_FILTER_MAX }),
      // 範圍守門：沒有 project 就必須有 mine，且此時只剩排序與分頁能帶
      //（排序與分頁不改變「框到哪些單」，故不算一般篩選——同後端 `generalFilterKeys` 的判準）。
      scope: Object.freeze({
        key: 'project',
        crossProject: 'mine',
        crossProjectAllow: Object.freeze(['mine', 'limit', 'cursor', 'sort', 'order'])
      })
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
      uuid: Object.freeze(['parentId']),
      isoString: Object.freeze(['expectedUpdatedAt'])
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
  }),

  // 刪附件是「按 attachmentId 刪」，不是「按 url 比對刪」。
  // 舊版用 url 當識別，同一個 url 附兩次就無法指名刪哪一筆；v1 的 id 才是唯一鍵。
  // 回 204 且無 body —— 這是契約明講的，故設 emptyBody。
  removeAttachment: Object.freeze({
    method: 'DELETE',
    pathTemplate: '/tickets/{ticketId}/attachments/{attachmentId}',
    pathParams: Object.freeze(['ticketId', 'attachmentId']),
    pathUuid: Object.freeze(['attachmentId']),
    query: Object.freeze({ allow: Object.freeze([]) }),
    emptyBody: true,
    rejected: Object.freeze({
      url: 'v1 依 attachmentId（UUID）刪除附件；url 不是 id，也不會拿 url 去反查。' +
        '請先讀 litejira://ticket/{id} 的附件清單取該筆的 id'
    }),
    contractRef: 'DELETE /api/v1/tickets/{ticketId}/attachments/{attachmentId}'
  }),

  // 建單。body 是平攤欄位（沒有巢狀 fields）。project 必填：v1 不會替你挑專案。
  // 白名單＝後端已核對過的建單欄位全集：核心 6 欄 + 18 個選填欄位。
  // 選填欄位一律可傳 null（明確清空 / 明確不設），不必為了「沒有值」而繞路寫進 description。
  // 值域受控的 priority / releaseMethod 在這一層只驗形狀（非空字串），實際值交後端裁決 ——
  // 本層不自創 enum，猜錯值域會把合法輸入擋在門外。
  createTicket: Object.freeze({
    method: 'POST',
    pathTemplate: '/tickets',
    pathParams: Object.freeze([]),
    query: Object.freeze({ allow: Object.freeze([]) }),
    body: Object.freeze({
      allow: Object.freeze([
        'project', 'type', 'title', 'priority', 'description', 'assigneeId',
        'module', 'subtype', 'releaseMethod', 'stdLevel2', 'stdLevel3',
        'startDate', 'dueDate', 'tags', 'mrUrl',
        'reproSteps', 'expectedResult', 'fixMethod', 'validationMethod',
        'verifiableVersionAlpha', 'verifiableVersionRelease',
        'ownerId', 'targetVersion', 'foundVersion'
      ]),
      required: Object.freeze(['project', 'type', 'title']),
      // 18 個附加資料欄可 null；核心 priority / description / assigneeId 可省略但不可 null。
      nullable: Object.freeze([
        'module', 'subtype', 'releaseMethod', 'stdLevel2', 'stdLevel3',
        'startDate', 'dueDate', 'tags', 'mrUrl',
        'reproSteps', 'expectedResult', 'fixMethod', 'validationMethod',
        'verifiableVersionAlpha', 'verifiableVersionRelease',
        'ownerId', 'targetVersion', 'foundVersion'
      ]),
      string: Object.freeze([
        'project', 'type', 'title', 'priority', 'description',
        'module', 'subtype', 'releaseMethod', 'stdLevel2', 'stdLevel3', 'mrUrl',
        'reproSteps', 'expectedResult', 'fixMethod', 'validationMethod',
        'verifiableVersionAlpha', 'verifiableVersionRelease',
        'targetVersion', 'foundVersion'
      ]),
      // 後端 validateFieldValue 對選填 TEXT_FIELDS 只驗 typeof string，空字串照收
      // （title 例外，必須非空）。這裡如果一律要求非空，合法的建單輸入會被前置擋掉。
      // priority / releaseMethod 不列入：它們是後端裁決的受控值，空字串不在值域內。
      allowEmptyString: Object.freeze([
        'description', 'module', 'subtype', 'stdLevel2', 'stdLevel3', 'mrUrl',
        'reproSteps', 'expectedResult', 'fixMethod', 'validationMethod',
        'verifiableVersionAlpha', 'verifiableVersionRelease',
        'targetVersion', 'foundVersion'
      ]),
      uuid: Object.freeze(['assigneeId', 'ownerId']),
      date: Object.freeze(['startDate', 'dueDate']),
      stringArray: Object.freeze(['tags'])
    }),
    rejected: Object.freeze({
      assignee: '處理人改用 assigneeId（UUID）；v1 不從顯示名反查成員，請先讀 litejira://members 取 id',
      owner: '負責人改用 ownerId（UUID）；v1 不從顯示名反查成員，請先讀 litejira://members 取 id',
      version: '版本欄位在 v1 分成 targetVersion（目標版本）與 foundVersion（發現版本），請明講是哪一個',
      verifyMethod: '驗證方式在 v1 的欄位名是 validationMethod',
      notes: 'v1 建單沒有 notes 欄位；補充說明請併入 description',
      // 建單端點不處理狀態與父子：它們各自有專屬端點，硬塞進建單只會被伺服器丟掉。
      parentId: '建單端點不掛父子；請先建單，再用 linkTickets（PUT /tickets/{childId}/parent，parentId 收 UUID）掛上',
      status: '建單不指定狀態（一律由工作流的起始狀態開始）；要改狀態請用 transitionTicket 的動作標籤',
      expectedUpdatedAt: '建單沒有「既有版本」可鎖，不收 expectedUpdatedAt（樂觀鎖只用於更新既有工單）'
    }),
    contractRef: 'POST /api/v1/tickets'
  }),

  // 轉派。reason 必填（會記進工單歷程），不是可選的客套話。
  reassignTicket: Object.freeze({
    method: 'PUT',
    pathTemplate: '/tickets/{ticketId}/assignee',
    pathParams: Object.freeze(['ticketId']),
    query: Object.freeze({ allow: Object.freeze([]) }),
    body: Object.freeze({
      allow: Object.freeze(['assigneeId', 'reason', 'expectedUpdatedAt']),
      required: Object.freeze(['assigneeId', 'reason']),
      string: Object.freeze(['reason']),
      uuid: Object.freeze(['assigneeId']),
      isoString: Object.freeze(['expectedUpdatedAt'])
    }),
    rejected: Object.freeze({
      newAssignee: '改用 assigneeId（UUID）；v1 不收顯示名，請先讀 litejira://members 取 id'
    }),
    contractRef: 'PUT /api/v1/tickets/{ticketId}/assignee'
  }),

  // 轉換工單類型。目標類型走 type（不是 newType）；subtype 可一併帶上。
  convertTicketType: Object.freeze({
    method: 'POST',
    pathTemplate: '/tickets/{ticketId}/type',
    pathParams: Object.freeze(['ticketId']),
    query: Object.freeze({ allow: Object.freeze([]) }),
    body: Object.freeze({
      allow: Object.freeze(['type', 'subtype', 'expectedUpdatedAt']),
      required: Object.freeze(['type']),
      string: Object.freeze(['type', 'subtype']),
      isoString: Object.freeze(['expectedUpdatedAt'])
    }),
    rejected: Object.freeze({
      newType: '目標類型的參數名是 type'
    }),
    contractRef: 'POST /api/v1/tickets/{ticketId}/type'
  }),

  // 關注 / 取消關注。v1 是「設定期望狀態」而不是 toggle：
  // toggle 不冪等（重送一次就翻回去），在會重試的通道上是錯的語意。
  // watching=true → PUT、false → DELETE；該參數只決定動詞，不進 body。
  // 兩個動詞都回 { data } 信封（不是 204）——本包唯一的 204 端點是刪附件，
  // 所以這裡不設 emptyBody：真的收到 204 就是違約，不讓空回應偷偷當成功。
  setWatchState: Object.freeze({
    methodSwitch: Object.freeze({ param: 'watching', whenTrue: 'PUT', whenFalse: 'DELETE' }),
    pathTemplate: '/tickets/{ticketId}/watchers/me',
    pathParams: Object.freeze(['ticketId']),
    query: Object.freeze({ allow: Object.freeze([]) }),
    contractRef: 'PUT | DELETE /api/v1/tickets/{ticketId}/watchers/me'
  }),

  // 狀態流轉。action 是動作標籤（getTransitions 回應的 data.actions[].label）。
  // v1 不收目標狀態：UI 的 toStatus 是後端驗證用的白名單值，對外送出只會撞 invalid_argument。
  transitionTicket: Object.freeze({
    method: 'POST',
    pathTemplate: '/tickets/{ticketId}/transitions',
    pathParams: Object.freeze(['ticketId']),
    query: Object.freeze({ allow: Object.freeze([]) }),
    body: Object.freeze({
      allow: Object.freeze(['action', 'reason', 'fields', 'expectedUpdatedAt']),
      required: Object.freeze(['action']),
      string: Object.freeze(['action', 'reason']),
      object: Object.freeze(['fields']),
      isoString: Object.freeze(['expectedUpdatedAt'])
    }),
    rejected: Object.freeze({
      toStatus: 'v1 的流轉只收動作標籤 action；目標狀態名是後端內部白名單，不對外接受',
      status: 'v1 的流轉只收動作標籤 action（見 getTransitions 的 data.actions[].label）',
      extraFields: '連帶欄位的參數名是 fields（物件）',
      force: 'v1 的流轉端點不收 force；繞過工作流的管理者途徑在 PUT /tickets/{ticketId}/status（forceSetStatus）'
    }),
    contractRef: 'POST /api/v1/tickets/{ticketId}/transitions'
  }),

  // ── 第四包：單一欄位更新的四條分流 + 三個批次端點 ──
  //
  // MCP 的 updateField 是「一個工具、五條路」：一般欄位走這條 PATCH，
  // 父子 / 處理人 / 版本 / 狀態各自有專屬端點（各有必填的 reason 或 force 閘門）。
  // 這裡刻意不做「一個萬用 update 端點」的假象 —— 那會讓呼叫端以為 reason 到處都能帶。
  updateTicketField: Object.freeze({
    method: 'PATCH',
    pathTemplate: '/tickets/{ticket}',
    pathParams: Object.freeze(['ticket']),
    query: Object.freeze({ allow: Object.freeze([]) }),
    body: Object.freeze({
      allow: Object.freeze(NORMAL_FIELDS.concat(['expectedUpdatedAt'])),
      // 只帶 expectedUpdatedAt 而不帶任何欄位＝一次什麼都不改的寫入；當面擋下比送出去好。
      atLeastOne: Object.freeze([NORMAL_FIELDS]),
      nullable: NORMAL_FIELD_SHAPE.nullable,
      string: NORMAL_FIELD_SHAPE.string,
      allowEmptyString: NORMAL_FIELD_SHAPE.allowEmptyString,
      uuid: NORMAL_FIELD_SHAPE.uuid,
      date: NORMAL_FIELD_SHAPE.date,
      stringArray: NORMAL_FIELD_SHAPE.stringArray,
      isoString: Object.freeze(['expectedUpdatedAt'])
    }),
    rejected: Object.freeze({
      // 收了卻沒地方放的參數：靜默丟掉會讓呼叫端以為「原因已記進歷程」。
      reason: '一般欄位的 PATCH 不收 reason（此端點不記異動原因）。' +
        '需要附原因的是轉派（reassignTicket，必填）、版本（setTicketVersions）與管理者改狀態（forceSetStatus）',
      force: '一般欄位不需要也不接受 force；force 只是 field=status 的本機閘門，且不進任何 body',
      status: '狀態不是一般欄位：正常流轉走 transitionTicket（動作標籤），管理者強制走 PUT /tickets/{ticketId}/status',
      parentId: '父子關聯走 PUT /tickets/{childId}/parent（linkTickets），parentId 只收 UUID 或 null',
      assigneeId: '處理人走 PUT /tickets/{ticketId}/assignee（reassignTicket），且 reason 必填',
      assignee: '處理人改用 assigneeId，並走 PUT /tickets/{ticketId}/assignee（reason 必填）',
      targetVersion: '目標版本走 PUT /tickets/{ticketId}/versions，參數名是 targetVersionId（UUID 或 null）',
      foundVersion: '發現版本走 PUT /tickets/{ticketId}/versions，參數名是 foundVersionId（UUID 或 null）',
      version: '版本在 v1 分成 targetVersionId / foundVersionId，且走 PUT /tickets/{ticketId}/versions，請明講是哪一個',
      verifyMethod: '驗證方式在 v1 的欄位名是 validationMethod',
      owner: '負責人的欄位名是 ownerId（UUID 或 null）',
      // 舊白名單有 notes，v1 沒有等價欄位。悄悄丟掉＝使用者寫的字整段消失。
      notes: 'v1 沒有 notes 欄位，也沒有等價欄位；補充說明請寫進 description（本層不代為搬運，以免蓋掉既有內容）'
    }),
    contractRef: 'PATCH /api/v1/tickets/{ticket}'
  }),

  // 版本設定。targetVersionId / foundVersionId 至少要帶一個；
  // 省略 ＝ 保持原值，null ＝ 清空（兩者語意不同，不可互相代替）。
  // reason 在「值真的有變」時是必要的，由後端裁決（本層不預判，免得擋掉合法的無變更呼叫）。
  setTicketVersions: Object.freeze({
    method: 'PUT',
    pathTemplate: '/tickets/{ticketId}/versions',
    pathParams: Object.freeze(['ticketId']),
    query: Object.freeze({ allow: Object.freeze([]) }),
    body: Object.freeze({
      allow: Object.freeze(['targetVersionId', 'foundVersionId', 'reason', 'expectedUpdatedAt']),
      atLeastOne: Object.freeze([Object.freeze(['targetVersionId', 'foundVersionId'])]),
      nullable: Object.freeze(['targetVersionId', 'foundVersionId']),
      uuid: Object.freeze(['targetVersionId', 'foundVersionId']),
      string: Object.freeze(['reason']),
      isoString: Object.freeze(['expectedUpdatedAt'])
    }),
    rejected: Object.freeze({
      targetVersion: '此端點收版本 UUID：參數名是 targetVersionId（建單時的 targetVersion 是版本「名稱」，兩者不同）',
      foundVersion: '此端點收版本 UUID：參數名是 foundVersionId（建單時的 foundVersion 是版本「名稱」，兩者不同）',
      version: '版本分成 targetVersionId / foundVersionId 兩個獨立欄位，請明講是哪一個'
    }),
    contractRef: 'PUT /api/v1/tickets/{ticketId}/versions'
  }),

  // 管理者強制改狀態。這條的閘門在呼叫端（MCP 的 force=true）與伺服器（真的是 admin 才放行），
  // force 本身不進 body —— body 只有目標狀態名。
  // 繞過的是「工作流路徑」驗證，不是「欄位必填」：送測三欄該填的還是要填，由伺服器裁決。
  forceSetStatus: Object.freeze({
    method: 'PUT',
    pathTemplate: '/tickets/{ticketId}/status',
    pathParams: Object.freeze(['ticketId']),
    query: Object.freeze({ allow: Object.freeze([]) }),
    body: Object.freeze({
      allow: Object.freeze(['status', 'reason', 'expectedUpdatedAt']),
      required: Object.freeze(['status']),
      string: Object.freeze(['status', 'reason']),
      isoString: Object.freeze(['expectedUpdatedAt'])
    }),
    rejected: Object.freeze({
      force: 'force 不是 body 欄位：它只是「要走這條管理者端點」的本機閘門，送進 body 不會有任何效果',
      action: '此端點收的是目標狀態名 status，不是動作標籤；一般流轉請改走 transitionTicket',
      toStatus: '目標狀態的參數名是 status',
      fields: '此端點不收 fields；連帶欄位請走 transitionTicket，或先用 PATCH 改好一般欄位'
    }),
    contractRef: 'PUT /api/v1/tickets/{ticketId}/status'
  }),

  // 批次流轉。tickets 是 1-100 個工單參照（UUID / 公開 key / 數字 key 皆可）。
  // 批次一律不做樂觀鎖：N 張各自有自己的 updatedAt，一個 expectedUpdatedAt 對不上任何一張。
  batchTransition: Object.freeze({
    method: 'POST',
    pathTemplate: '/tickets/batch/transitions',
    pathParams: Object.freeze([]),
    query: Object.freeze({ allow: Object.freeze([]) }),
    body: Object.freeze({
      allow: Object.freeze(['tickets', 'action', 'reason', 'fields']),
      required: Object.freeze(['tickets', 'action']),
      refArray: Object.freeze(['tickets']),
      string: Object.freeze(['action', 'reason']),
      object: Object.freeze(['fields'])
    }),
    rejected: Object.freeze({
      ids: '工單清單的參數名是 tickets（1-100 個工單參照）',
      extraFields: '連帶欄位的參數名是 fields（物件）',
      toStatus: '批次流轉一樣只收動作標籤 action；目標狀態名不對外接受',
      status: '批次流轉只收動作標籤 action（見 getAllowedTransitions 的 data.actions[].label）',
      force: '批次沒有管理者強制途徑；要強制改狀態請逐張走 PUT /tickets/{ticketId}/status',
      expectedUpdatedAt: '批次端點不做樂觀鎖（每張工單的 updatedAt 各不相同，單一值對不上）；請移除'
    }),
    contractRef: 'POST /api/v1/tickets/batch/transitions'
  }),

  batchReassign: Object.freeze({
    method: 'POST',
    pathTemplate: '/tickets/batch/assignee',
    pathParams: Object.freeze([]),
    query: Object.freeze({ allow: Object.freeze([]) }),
    body: Object.freeze({
      allow: Object.freeze(['tickets', 'assigneeId', 'reason']),
      required: Object.freeze(['tickets', 'assigneeId', 'reason']),
      refArray: Object.freeze(['tickets']),
      uuid: Object.freeze(['assigneeId']),
      string: Object.freeze(['reason'])
    }),
    rejected: Object.freeze({
      ids: '工單清單的參數名是 tickets（1-100 個工單參照）',
      newAssignee: '改用 assigneeId（UUID）；v1 不收顯示名，請先讀 litejira://members 取 id',
      assignee: '改用 assigneeId（UUID）；請先讀 litejira://members 取 id',
      expectedUpdatedAt: '批次端點不做樂觀鎖；請移除'
    }),
    contractRef: 'POST /api/v1/tickets/batch/assignee'
  }),

  // 批次改欄位。fields 是物件，一次可帶多個一般欄位；
  // parentId 是例外：只能單獨成批（與其他欄位同批會被伺服器拒），且收的是工單參照而非 UUID。
  batchSetField: Object.freeze({
    method: 'POST',
    pathTemplate: '/tickets/batch/fields',
    pathParams: Object.freeze([]),
    query: Object.freeze({ allow: Object.freeze([]) }),
    body: Object.freeze({
      allow: Object.freeze(['tickets', 'fields']),
      required: Object.freeze(['tickets', 'fields']),
      refArray: Object.freeze(['tickets']),
      object: Object.freeze(['fields']),
      fieldsObject: Object.freeze({
        key: 'fields',
        allow: BATCH_FIELD_KEYS,
        alone: Object.freeze(['parentId']),
        shape: BATCH_FIELD_SHAPE
      })
    }),
    rejected: Object.freeze({
      ids: '工單清單的參數名是 tickets（1-100 個工單參照）',
      field: '批次改欄位收的是 fields 物件：請改傳 fields: { 欄位名: 新值 }',
      value: '批次改欄位收的是 fields 物件：請改傳 fields: { 欄位名: 新值 }',
      status: '狀態不是批次欄位；請改用批次流轉（POST /tickets/batch/transitions）的動作標籤',
      assigneeId: '處理人有專屬批次端點：POST /tickets/batch/assignee（reason 必填）',
      targetVersion: '版本有專屬批次端點：POST /tickets/batch/versions，參數名是 targetVersionId（UUID）',
      foundVersion: '版本有專屬批次端點：POST /tickets/batch/versions，參數名是 foundVersionId（UUID）',
      version: '版本走 POST /tickets/batch/versions，並分成 targetVersionId / foundVersionId',
      expectedUpdatedAt: '批次端點不做樂觀鎖；請移除'
    }),
    contractRef: 'POST /api/v1/tickets/batch/fields'
  }),

  batchSetVersions: Object.freeze({
    method: 'POST',
    pathTemplate: '/tickets/batch/versions',
    pathParams: Object.freeze([]),
    query: Object.freeze({ allow: Object.freeze([]) }),
    body: Object.freeze({
      allow: Object.freeze(['tickets', 'targetVersionId', 'foundVersionId', 'reason']),
      required: Object.freeze(['tickets']),
      atLeastOne: Object.freeze([Object.freeze(['targetVersionId', 'foundVersionId'])]),
      refArray: Object.freeze(['tickets']),
      nullable: Object.freeze(['targetVersionId', 'foundVersionId']),
      uuid: Object.freeze(['targetVersionId', 'foundVersionId']),
      string: Object.freeze(['reason'])
    }),
    rejected: Object.freeze({
      ids: '工單清單的參數名是 tickets（1-100 個工單參照）',
      targetVersion: '此端點收版本 UUID：參數名是 targetVersionId',
      foundVersion: '此端點收版本 UUID：參數名是 foundVersionId',
      version: '版本分成 targetVersionId / foundVersionId 兩個獨立欄位，請明講是哪一個',
      expectedUpdatedAt: '批次端點不做樂觀鎖；請移除'
    }),
    contractRef: 'POST /api/v1/tickets/batch/versions'
  })
});

// v1 沒有對應端點、但舊 MCP / CLI 仍可能傳進來的 action：明講改走哪裡，不當成 unknown。
const REPLACED_ACTIONS = Object.freeze({
  // toggle 是「翻面」，重送一次就翻回去 —— 在會重試的通道上語意是錯的。
  toggleWatchTicket: 'v1 改成設定期望狀態：action=setWatchState + watching=true|false（PUT / DELETE watchers/me），不再 toggle'
});

// 第四包起沒有「契約未取得」的 action —— 這份清單留空是事實陳述，不是佔位。
const PENDING_CONTRACT_ACTIONS = Object.freeze([]);

// 在 v1 沒有單一端點、必須由呼叫端拆成多發的舊 action。
// 它們不是「未取得契約」，也不是「被取代」：拆法是確定的，只是拆點在 client 端。
// 傳輸層本身只送單發，所以這裡明確拒絕並指出該拆成哪幾條路由 —— 不假裝有一個萬用端點。
const COMPOSITE_ACTIONS = Object.freeze({
  updateField: '「改一個欄位」在 v1 依欄位分五條路：一般欄位 PATCH /tickets/{ticket}（updateTicketField）、' +
    '父子 PUT /tickets/{childId}/parent（linkTickets）、處理人 PUT /tickets/{ticketId}/assignee（reassignTicket，reason 必填）、' +
    '版本 PUT /tickets/{ticketId}/versions（setTicketVersions）、管理者改狀態 PUT /tickets/{ticketId}/status（forceSetStatus）。' +
    '請直接指定該欄位對應的 action',
  replyFeedback: '「留言＋可選流轉」在 v1 沒有複合端點，也從來不是原子操作：' +
    '請先送 transitionTicket（若有流轉），成功後再送 addComment，兩步各用一把互不相同的穩定冪等鍵，' +
    '並如實回報部分成功（MCP 的 litejira.replyFeedback 已內建這個拆法）'
});

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
  if (has_(COMPOSITE_ACTIONS, action)) {
    throw new LiteJiraTransportError('composite_action',
      'action「' + action + '」在 v1 不是單一端點：' + COMPOSITE_ACTIONS[action],
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
  const maxValues = spec.maxValues || {};
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
    // 有上界的多值參數（目前只有 `id`）：超過就當面擋下並講出上限，
    // 不截斷成前 N 個 —— 截斷會讓呼叫端拿到一份比要求更窄的清單而看不出少了什麼。
    if (typeof maxValues[key] === 'number' && values.length > maxValues[key]) {
      throw invalidArg_('參數「' + key + '」一次最多 ' + maxValues[key] + ' 個值（收到 ' + values.length + ' 個）',
        { param: key, count: values.length, max: maxValues[key] });
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

  // GH-313 範圍守門（工單清單）：專案必填，唯一例外是「我的」那一類的跨專案查詢，
  // 而跨專案時不接受任何一般篩選。兩條都拒絕而不是忽略 —— 忽略會讓呼叫端拿到
  // 「篩選沒生效」而沒有任何錯誤（本檔對靜默丟棄一貫的立場）。
  const scope = spec.scope;
  if (scope && present.indexOf(scope.key) === -1) {
    if (present.indexOf(scope.crossProject) === -1) {
      throw invalidArg_('工單查詢必須指定專案（' + scope.key + '）；要跨專案請改帶 ' + scope.crossProject +
        '=' + MINE_VALUES.join(' | ') + '（唯一天然跨專案的維度）。本層不會替你挑一個專案。',
        { param: scope.key, crossProject: scope.crossProject, crossProjectValues: MINE_VALUES.slice() });
    }
    const general = present.filter((key) => scope.crossProjectAllow.indexOf(key) === -1);
    if (general.length > 0) {
      throw invalidArg_('跨專案查詢（只帶 ' + scope.crossProject + '）不接受一般篩選；' +
        '要篩選請一併指定 ' + scope.key + '（收到：' + general.join('、') + '）',
        { param: scope.key, conflicting: general });
    }
  }

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
  const pathUuid = route.pathUuid || [];
  (route.pathParams || []).forEach((name) => {
    const value = params ? params[name] : undefined;
    if (value === undefined || value === null || value === '') {
      throw invalidArg_('缺少路徑參數：' + name, { param: name });
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw invalidArg_('路徑參數「' + name + '」必須是字串或數字（UUID / 工單 key / 數字 key）', { param: name });
    }
    // 只有明列為 UUID 的路徑參數（如 attachmentId）才強制 UUID：
    // 工單參照三形狀通用，但子資源 id 是純 UUID，收到 url / 序號就是叫錯端點。
    if (pathUuid.indexOf(name) !== -1 && !UUID_PATTERN.test(String(value))) {
      throw invalidArg_('路徑參數「' + name + '」必須是 UUID（子資源以 id 定位，不以 url 或序號定位）', { param: name });
    }
    // 工單參照可以是 UUID、舊字母 key（BUG-481）或純數字 key，路徑一律 encode 後帶出。
    path = path.replace('{' + name + '}', encodeURIComponent(String(value)));
  });
  return path;
}

function buildBody(route, params) {
  const spec = route.body;
  // 契約上沒有 body 的寫入路由（DELETE 附件、關注切換）：多餘參數一樣要當面拒絕。
  // 直接 return undefined 會把呼叫端傳的東西靜默吞掉，看起來像成功卻什麼都沒帶。
  if (!spec) {
    Object.keys(params || {}).forEach((key) => {
      if (params[key] === undefined) return;
      assertRejected_(route, key);
      throw invalidArg_('端點「' + route.contractRef + '」不收 body；參數「' + key + '」無處可放',
        { param: key, allowed: [] });
    });
    return undefined;
  }
  const allow = spec.allow || [];
  const required = spec.required || [];
  const out = {};

  Object.keys(params || {}).forEach((key) => {
    const value = params[key];
    if (value === undefined) return;
    assertRejected_(route, key);
    if (allow.indexOf(key) === -1) {
      throw invalidArg_('參數「' + key + '」不在 v1 body 契約內（' + route.contractRef + '）',
        { param: key, allowed: allow.slice() });
    }
    checkBodyValue_(spec, key, value);
    out[key] = value;
  });

  required.forEach((key) => {
    if (!has_(out, key)) {
      throw invalidArg_('缺少必填 body 參數：' + key + '（' + route.contractRef + '）', { param: key });
    }
  });

  // 「至少要帶一個」的群組（例：版本端點的 targetVersionId / foundVersionId）。
  // 一個都不帶＝這發請求什麼也不會改；送出去只會浪費一次寫入並回一個難解的錯。
  (spec.atLeastOne || []).forEach((group) => {
    const given = group.filter((key) => has_(out, key));
    if (given.length === 0) {
      throw invalidArg_('至少要帶一個：' + group.join(' / ') +
        '（省略＝保持原值、null＝清空，兩者語意不同）（' + route.contractRef + '）',
        { params: group.slice() });
    }
  });

  // 巢狀 fields 物件（批次改欄位）：鍵要在白名單內、值形狀比照單張的一般欄位。
  const fieldsSpec = spec.fieldsObject;
  if (fieldsSpec && has_(out, fieldsSpec.key)) {
    checkFieldsObject_(route, fieldsSpec, out[fieldsSpec.key]);
  }
  return out;
}

// 單一 body 值的形狀檢查。主迴圈與巢狀 fields 物件共用同一份規則，避免兩邊漂移。
function checkBodyValue_(spec, key, value) {
  if (value === null) {
    if ((spec.nullable || []).indexOf(key) === -1) {
      throw invalidArg_('參數「' + key + '」不可為 null', { param: key });
    }
    return;
  }
  if ((spec.string || []).indexOf(key) !== -1) {
    if (typeof value !== 'string') {
      throw invalidArg_('參數「' + key + '」必須是字串', { param: key });
    }
    // 少數欄位後端只驗型別不驗長度，空字串是合法值；其餘字串欄位維持「非空」。
    if (value.trim() === '' && (spec.allowEmptyString || []).indexOf(key) === -1) {
      throw invalidArg_('參數「' + key + '」必須是非空字串', { param: key });
    }
  }
  if ((spec.uuid || []).indexOf(key) !== -1 && !UUID_PATTERN.test(String(value))) {
    throw invalidArg_('參數「' + key + '」必須是 UUID（要解除關聯請明確傳 null）', { param: key });
  }
  // 工單參照：UUID / 公開 key（BUG-481）/ 純數字 key 三選一。
  // 與「只收 UUID」的欄位刻意分開 —— 哪一邊放寬是契約差異，不是本層自由心證。
  if ((spec.ticketRef || []).indexOf(key) !== -1) {
    if (typeof value !== 'string' || !TICKET_REF_PATTERN.test(value)) {
      throw invalidArg_('參數「' + key + '」必須是工單參照（UUID、公開 key 如 BUG-481，或純數字 key）', { param: key });
    }
  }
  if ((spec.uuidArray || []).indexOf(key) !== -1) {
    if (!Array.isArray(value)) {
      throw invalidArg_('參數「' + key + '」必須是 UUID 陣列', { param: key });
    }
    value.forEach((one) => {
      if (!UUID_PATTERN.test(String(one))) {
        throw invalidArg_('參數「' + key + '」只收 UUID（不收顯示名）', { param: key });
      }
    });
  }
  // 批次的工單清單：1-100 個工單參照。上限是契約值，超過就整批被伺服器拒，不如當面擋下。
  if ((spec.refArray || []).indexOf(key) !== -1) {
    if (!Array.isArray(value)) {
      throw invalidArg_('參數「' + key + '」必須是工單參照陣列', { param: key });
    }
    if (value.length === 0) {
      throw invalidArg_('參數「' + key + '」至少要有 1 個工單', { param: key });
    }
    if (value.length > BATCH_MAX_TICKETS) {
      throw invalidArg_('參數「' + key + '」一次最多 ' + BATCH_MAX_TICKETS + ' 個工單（收到 ' + value.length + ' 個）',
        { param: key, max: BATCH_MAX_TICKETS, got: value.length });
    }
    value.forEach((one) => {
      if (typeof one !== 'string' || !TICKET_REF_PATTERN.test(one)) {
        throw invalidArg_('參數「' + key + '」的每個元素都必須是工單參照（UUID、公開 key 如 BUG-481，或純數字 key）',
          { param: key });
      }
    });
  }
  if ((spec.url || []).indexOf(key) !== -1) {
    assertHttpUrl_(key, value);
  }
  // 樂觀鎖時間戳：原樣回填讀取端拿到的 ISO 字串。
  // 收 number 就代表呼叫端已經做過 Date → ms 轉換（掉微秒），那個值送出去只會撞假衝突。
  if ((spec.isoString || []).indexOf(key) !== -1) {
    if (typeof value === 'number') {
      throw invalidArg_('參數「' + key + '」必須是讀取端回傳的原始 ISO 字串；' +
        '轉成毫秒數字會掉精度並撞出假的 version_conflict', { param: key });
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw invalidArg_('參數「' + key + '」必須是非空的 ISO 8601 字串（原樣回填讀取端的值）', { param: key });
    }
  }
  if ((spec.object || []).indexOf(key) !== -1) {
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw invalidArg_('參數「' + key + '」必須是物件', { param: key });
    }
  }
  // 日期欄位：只收 YYYY-MM-DD（純日期，沒有時區）。
  // 不接受 Date / ISO 時間戳 —— 帶時區的值換算後可能落到前後一天。
  if ((spec.date || []).indexOf(key) !== -1 && !isCalendarDate_(value)) {
    throw invalidArg_('參數「' + key + '」必須是 YYYY-MM-DD 格式的日期（不含時間與時區）', { param: key });
  }
  if ((spec.stringArray || []).indexOf(key) !== -1) {
    if (!Array.isArray(value)) {
      throw invalidArg_('參數「' + key + '」必須是字串陣列（要清空請傳 null）', { param: key });
    }
    value.forEach((one) => {
      if (typeof one !== 'string' || one.trim() === '') {
        throw invalidArg_('參數「' + key + '」的每個元素都必須是非空字串', { param: key });
      }
    });
  }
}

function checkFieldsObject_(route, fieldsSpec, value) {
  const keys = Object.keys(value).filter((key) => value[key] !== undefined);
  if (keys.length === 0) {
    throw invalidArg_('參數「' + fieldsSpec.key + '」至少要帶一個欄位（空物件不會改到任何東西）',
      { param: fieldsSpec.key, allowed: fieldsSpec.allow.slice() });
  }
  keys.forEach((key) => {
    if (fieldsSpec.allow.indexOf(key) === -1) {
      const hint = has_(route.rejected || {}, key) ? '：' + route.rejected[key] : '';
      throw invalidArg_('欄位「' + key + '」不在批次可改欄位內（' + route.contractRef + '）' + hint,
        { param: fieldsSpec.key + '.' + key, allowed: fieldsSpec.allow.slice() });
    }
    checkBodyValue_(fieldsSpec.shape, key, value[key]);
  });
  // 只能單獨成批的欄位（parentId）：與其他欄位混批會被伺服器整批拒，先在本機講清楚。
  (fieldsSpec.alone || []).forEach((key) => {
    if (keys.indexOf(key) !== -1 && keys.length > 1) {
      throw invalidArg_('欄位「' + key + '」必須單獨成批，不能與其他欄位同批（收到：' + keys.join('、') + '）',
        { param: fieldsSpec.key, alone: key });
    }
  });
}

// YYYY-MM-DD，且必須是真的存在的日期（擋掉 2026-02-30 這種格式對、日子不存在的值）。
function isCalendarDate_(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parts = value.split('-');
  const d = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  return d.getUTCFullYear() === Number(parts[0]) &&
    d.getUTCMonth() === Number(parts[1]) - 1 &&
    d.getUTCDate() === Number(parts[2]);
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
  // methodSwitch：動詞由布林參數決定（關注 = PUT / 取消 = DELETE）。
  // 取完就從 rest 拿掉——它是動詞本身，不是 body 欄位。
  const method = resolveMethod_(route, rest);
  const write = isWriteMethod(method);
  // 寫入路由的非路徑參數走 body，不再另外拼 query（目前 9 條寫入路由都沒有 query）。
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
    // server 端真的會去重，但有效期是 24 小時的冪等保留期、且要求輸入完全相同：
    // 保留期內同一把 key 重送 = 回同一個結果；過期或換 key 重送 = 真的做第二次。
    // 反過來，同一把 key 配不同 body 會拿到 idempotency_key_reused（409）。
    const key = opts.idempotencyKey;
    if (key === undefined || key === null || key === '') {
      throw new LiteJiraTransportError('idempotency_key_required',
        '寫入必須帶 Idempotency-Key（16-64 字元 [A-Za-z0-9_-]）；重試請沿用同一把 key（server 端會去重）',
        { action: opts.action });
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(String(key))) {
      throw invalidArg_('Idempotency-Key 格式錯誤（需 ^[A-Za-z0-9_-]{16,64}$）', { param: 'idempotencyKey' });
    }
    headers['Idempotency-Key'] = String(key);
  }
  // 讀取路由沒有 body 契約，buildQuery 已把未確認參數擋掉，這裡不會誤帶 body。
  // GET 不去重：即使呼叫端塞了 key 也不掛上去（掛了是雜訊，server 也不看）。

  return { method: method, url: url, headers: headers, body: body, write: write, route: route };
}

function resolveMethod_(route, rest) {
  const sw = route.methodSwitch;
  if (!sw) return route.method;
  const value = rest[sw.param];
  if (typeof value !== 'boolean') {
    throw invalidArg_('參數「' + sw.param + '」必須是布林值：明講要的結果狀態（true / false）。' +
      'v1 不做 toggle —— toggle 重送一次就翻回去，不是冪等操作。', { param: sw.param });
  }
  delete rest[sw.param];
  return value ? sw.whenTrue : sw.whenFalse;
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
      // 204 無 body：只有契約明講如此的路由（emptyBody）才放行。
      // 不放寬到「任何 2xx 空 body」——那會讓其他端點的空回應偷偷當成功過關。
      const empty = !parsed;
      if (status === 204 && request.route.emptyBody && empty) {
        return { ok: true, status: status, data: null, noContent: true };
      }
      if (status === 204) {
        throw new LiteJiraTransportError('invalid_response',
          request.route.emptyBody
            ? 'HTTP 204 卻帶了 body，與契約不符（' + request.route.contractRef + '；內容不轉述）'
            : 'HTTP 204 不在此端點的契約內（' + request.route.contractRef + '）',
          { status: status });
      }
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
  BATCH_FIELD_KEYS,
  BATCH_MAX_TICKETS,
  COMPOSITE_ACTIONS,
  DEFAULT_TIMEOUT_MS,
  ENUM_FILTER_DIMS,
  ENUM_FILTER_OPS,
  NORMAL_FIELDS,
  IDEMPOTENCY_KEY_PATTERN,
  LiteJiraApiError,
  LiteJiraTransportError,
  MINE_VALUES,
  ORDER_VALUES,
  PENDING_CONTRACT_ACTIONS,
  REPLACED_ACTIONS,
  SORT_VALUES,
  STATS_SCOPE_VALUES,
  TEXT_FILTER_DIMS,
  TEXT_FILTER_OPS,
  TICKET_FILTER_FIELDS,
  TICKET_FILTER_MULTI_FIELDS,
  TICKET_FILTER_UUID_FIELDS,
  TICKET_ID_FILTER_MAX,
  TICKET_QUERY_FIELDS,
  TICKET_REF_PATTERN,
  UUID_FILTER_DIMS,
  UUID_PATTERN,
  buildRequest,
  callV1,
  normalizeBaseUrl,
  resolveRoute
};
