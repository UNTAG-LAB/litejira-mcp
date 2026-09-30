#!/usr/bin/env node

const readline = require('readline');
const crypto = require('crypto');

// GH-257：MCP 改走對外 API v1。
// 第二包＝讀取面（4 tools + 6 resources + 4 prompts）；第三包＝9 個基本寫入工具
//（建單 / 留言 / 附件 ±/ 父子 / 轉派 / 轉型 / 關注 / 流轉）；
// 第四包＝updateField / replyFeedback / 三個 batch，全部 18 個工具接線完畢。
// 舊的 postLiteJiraApi（單一 POST + body token）在本檔案已完全不再使用，也沒有 legacy fallback。
const path = require('path');

const {
  callV1,
  uploadAttachment,
  attachmentContentUrls,
  normalizeBaseUrl,
  ATTACHMENT_DOWNLOAD_CONTRACT,
  ATTACHMENT_UPLOAD_CONTRACT,
  DEFAULT_MAX_UPLOAD_BYTES,
  UPLOAD_BYTES_CEILING,
  UPLOAD_UNKNOWN_OUTCOME,
  ACTIVITY_KIND_VALUES,
  BATCH_MAX_TICKETS,
  ENUM_FILTER_DIMS,
  ENUM_FILTER_OPS,
  LiteJiraApiError,
  LiteJiraTransportError,
  MINE_VALUES,
  NORMAL_FIELDS,
  ORDER_VALUES,
  SORT_VALUES,
  TEXT_FILTER_DIMS,
  TEXT_FILTER_OPS,
  TICKET_ID_FILTER_MAX,
  UUID_FILTER_DIMS
} = require('./litejira-v1-transport');

// LJ-160 #2：版本號單一事實源 = package.json，避免手寫在多處漂移。
const PKG_VERSION = require('./package.json').version;        // 例 "2.3.0"
const { OFFICIAL_API_URL, resolveSettings } = require('./litejira-config');

// 站台與專案都有內建預設，所以唯一可能缺的就是 token：訊息直接指向設定指令。
const MISSING_TOKEN_MESSAGE =
  'LTJ_API_TOKEN is required（亦接受舊名 LTJ_API_PAT）。請在終端機執行 `litejira-mcp setup` 輸入你的 PAT。';

// GH-257：v1 的工單參照可以是 UUID、字母 key（BUG-481）或純數字 key，三者都直接進路徑。
// 舊版只認固定前綴的 PREFIX-NNN，會把 v1 主鍵 UUID 擋在門外，故放寬。
// 前綴不再寫死白名單：v1 的 key 命名空間由 server 決定，客戶端硬編前綴只會在新增類型時誤擋。
// 這裡只擋「三種形狀都不是」的自由字串，不讓它送出去碰運氣；不存在的 key 由後端回 not_found。
const TICKET_REF_PATTERN =
  '^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[A-Za-z]+-\\d+|\\d+)$';

// LJ-116 批次 2: enum 常數（基於 webapp/Code.js:38-40 + UPDATE_FIELD_WHITELIST 2289-2299 事實依據）
const ENUM_TYPES = ['EPIC', 'REQ', 'BUG', 'IDEA', 'TASK', 'STD'];
const ENUM_CREATE_TYPES = ['EPIC', 'REQ', 'BUG', 'TASK', 'STD']; // API v1 CREATABLE_TICKET_TYPES
// GH-257：v1 的轉型「目標類型」值域 —— IDEA 與 STD 都不能當 target。
// （舊版只排除 STD，會讓助手以為可以轉成 IDEA，實際會被伺服器擋下。）
const ENUM_CONVERT_TARGET_TYPES = ['EPIC', 'REQ', 'BUG', 'TASK'];
const ENUM_PRIORITIES = ['P0-緊急', 'P1-高', 'P2-中', 'P3-低']; // 含中文後綴
// GH-257：order / sort 值域改以傳輸層契約表為單一事實源，避免兩處漂移。
// GH-313：sort 是後端欄位登錄表推導的 15 欄（舊註解說「只有三個」是漏抄，不是契約）。
const ENUM_ORDER = ORDER_VALUES.slice();
const ENUM_SORT = SORT_VALUES.slice();
// GH-313：跨專案查詢唯一的入口（後端 MINE_DIMS）。
const ENUM_MINE = MINE_VALUES.slice();
// GH-257 第三包：releaseMethod 是 v1 的建單欄位，但值域由伺服器裁決 ——
// 客戶端不寫死 enum（寫死會在後端新增值時把合法輸入擋在門外），只驗「非空字串」，受控值讀 litejira://meta。
//
// GH-257 第四包：updateField 的白名單改以 v1 契約為單一事實源。
// 一般欄位（NORMAL_FIELDS）走 PATCH；另外四個是「有專屬端點」的欄位，各有自己的必填條件：
//   parentId（PUT /parent，只收 UUID）/ assigneeId（PUT /assignee，reason 必填）
//   targetVersion / foundVersion（PUT /versions，收版本 UUID）/ status（PUT /status，需 force=true）
const ENUM_UPDATE_FIELDS = NORMAL_FIELDS.concat([
  'parentId', 'assigneeId', 'targetVersion', 'foundVersion', 'status'
]);
// 舊白名單裡在 v1 已改名或已不存在的欄位名。落在這裡就明確指路，不回一句籠統的 invalid。
// notes 是「沒有等價欄位」：本層不代為搬進 description（那會蓋掉既有內容），直接要求呼叫端改寫。
const UPDATE_FIELD_LEGACY = {
  verifyMethod: '驗證方式在 v1 的欄位名是 validationMethod',
  owner: '負責人在 v1 的欄位名是 ownerId，值是成員 UUID（null = 清空）；請先讀 litejira://members 取 id',
  assignee: '處理人在 v1 的欄位名是 assigneeId，值是成員 UUID，且 reason 必填（會記入工單歷程）',
  version: '版本在 v1 分成 targetVersion（目標版本）與 foundVersion（發現版本），' +
    '且 value 收的是版本「UUID」（不是版本名稱）；請先讀 litejira://versions 取 id，並明講是哪一個',
  notes: 'v1 沒有 notes 欄位，也沒有等價欄位。補充說明請改寫進 description（field=description）——' +
    '本工具不會替你把內容搬到別的欄位，以免覆蓋既有描述'
};
// 批次版的指路表：多了「這個欄位有專屬批次工具」兩條（處理人 / 狀態）。
const BATCH_FIELD_LEGACY = Object.assign({}, UPDATE_FIELD_LEGACY, {
  assignee: '批量轉派請改用 litejira.batchReassign（assigneeId 收 UUID，reason 必填）',
  assigneeId: '批量轉派請改用 litejira.batchReassign（assigneeId 收 UUID，reason 必填）',
  status: '狀態不是批次欄位：請改用 litejira.batchTransition 的動作標籤（批次沒有管理者強制途徑）'
});

// LJ-116: 常用參數 schema（給多個工具引用，集中維護）
// GH-257：v1 讀取端點的工單參照 — UUID（主鍵）/ 公開 key（BUG-481）/ 純數字 key 三選一。
const P_TICKET_REF = {
  type: 'string',
  description: '工單參照：UUID 主鍵、公開 key（如 BUG-481）或純數字 key 皆可。',
  pattern: TICKET_REF_PATTERN
};
// GH-257：成員 / 父工單身分一律 UUID。v1 不收顯示名，伺服器端也不做姓名推測。
// JSON Schema 的 pattern 不帶旗標，所以大小寫要寫進字元集（傳輸層的 UUID_PATTERN 是靠 /i）。
// 真正的守門人仍是傳輸層；這裡只是讓格式錯誤在送出前就有清楚的訊息。
const UUID_SCHEMA_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const P_MEMBER_UUID = (label) => ({
  type: 'string',
  description: label + '（UUID）。顯示名無法查詢，請先讀 litejira://members 取 id。',
  pattern: UUID_SCHEMA_PATTERN
});
// 建單的成員欄位：同樣只收 UUID，但可傳 null（= 不指派）。
const P_CREATE_MEMBER_UUID = (label) => ({
  type: ['string', 'null'],
  description: label + '（UUID）。顯示名無法查詢，請先讀 litejira://members 取 id；null = 不指派。',
  pattern: UUID_SCHEMA_PATTERN
});
// GH-257 第三包：建單的選填欄位一律可傳 null（= 明確不設 / 清空），
// 所以型別是 ['string','null']；日期欄位只收純日期 YYYY-MM-DD（帶時區的時間戳換算後會落到前後一天）。
const CREATE_DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';
// GH-257：後端 validateFieldValue 對選填 TEXT_FIELDS 只驗 typeof string —— 空字串是合法輸入
// （會原樣寫入，等同清空該欄），所以這層不能加 minLength 把它擋掉。
// 例外是受控值欄位（releaseMethod）：值域由後端裁決，空字串不在值域內，仍要求非空。
const P_CREATE_TEXT = (label, allowEmpty) => {
  const schema = {
    type: ['string', 'null'],
    description: label + '。null = 不設' +
      (allowEmpty === false ? '（受控值，不收空字串）' : '；空字串 = 寫入空值（後端照收）') + '。'
  };
  if (allowEmpty === false) schema.minLength = 1;
  return schema;
};
const P_CREATE_DATE = (label) => ({
  type: ['string', 'null'],
  description: label + '：YYYY-MM-DD（純日期，不含時間與時區）。null = 不設。',
  pattern: CREATE_DATE_PATTERN
});
const P_LIMIT = { type: 'integer', description: 'Max results (1-100，客戶端上限). 超過上限請改用 cursor 分頁。', minimum: 1, maximum: 100 };
const P_CURSOR = { type: 'string', description: '分頁 cursor（從前一次回應的 nextCursor 帶入）' };
const P_ORDER = { type: 'string', description: 'Sort order：asc 或 desc', enum: ENUM_ORDER };
const P_IDEMPOTENCY = {
  type: 'string',
  description: 'Idempotency key（16-64 字元 alphanumeric / _ / -），以 Idempotency-Key header 送出。' +
    'API v1 的 server 端會去重，但只在 24 小時保留期內、且輸入完全相同時成立：' +
    '結果不確定時，在保留期內用「同一把 key ＋一模一樣的輸入」重送會回同一個結果、不會做第二次；' +
    '保留期過後同一把 key 會被當成全新請求真的再做一次（不存在「無限期可安全重放」這回事）。' +
    '換一把 key 重送一定會再做一次。同一把 key 配不同內容會被拒（idempotency_key_reused，' +
    'details.reason=request_mismatch）；前一次同 key 請求還在跑時也會拒（details.reason=in_progress，' +
    '此時該操作是否已生效未知，應稍後用相同輸入＋同一把 key 重送，不要換新 key）。',
  minLength: 16,
  maxLength: 64,
  pattern: '^[a-zA-Z0-9_-]{16,64}$'
};
// GH-257：v1 的 updatedAt 是 ISO 8601 字串（含微秒）。必須原樣回填讀取端拿到的字串 ——
// 轉成 ms timestamp 會掉精度，比對不上就會撞出假的 version_conflict。
const P_EXPECTED_UPDATED_AT = {
  type: 'string',
  description: '樂觀鎖：把讀取時拿到的 updatedAt「原始 ISO 字串」原樣帶回（例 2026-09-11T03:22:10.123456Z）。' +
    '不要轉成毫秒數字或重新格式化，會掉精度而撞出假的衝突。省略 = 不做樂觀鎖。'
};
// LJ-178 + GH-257 第四包：批量工具共用 — 工單清單（1-100 張）。
// 參數名對齊 v1 契約的 tickets；元素是工單參照三形狀（UUID / 公開 key / 數字 key）。
const P_TICKETS = {
  type: 'array',
  description: '工單清單（1-' + BATCH_MAX_TICKETS + ' 張）。每個元素是工單參照：UUID、公開 key（BUG-481）或純數字 key。' +
    '一發呼叫處理整批，逐張的成敗分別回在 succeeded[] / failed[]。',
  items: { type: 'string', pattern: TICKET_REF_PATTERN },
  minItems: 1,
  maxItems: BATCH_MAX_TICKETS
};
// GH-257 第四包：批量可改的欄位 = 一般欄位 + parentId（走 batch/fields）
// + targetVersion / foundVersion（走 batch/versions）。status 不是批次欄位，請用 batchTransition。
const ENUM_BATCH_FIELDS = NORMAL_FIELDS.concat(['parentId', 'targetVersion', 'foundVersion']);
// 版本欄位名 → 版本端點的參數名（單張與批次同名；差別只在單張多支援樂觀鎖）。
const VERSION_FIELD_PARAM = { targetVersion: 'targetVersionId', foundVersion: 'foundVersionId' };

// ── 工單篩選的完整運算子面（後端 P4.2d／P5.6）────────────────────────────
//
// 維度清單與運算子清單都由傳輸層匯入（它才是對照後端 `read-queries.ts` 的那一份），
// 這裡只負責把每一欄變成一個有說明的 schema。**不在本檔重抄欄位名**：
// 抄第二份的漏抄症狀是靜默的 —— 少掉的那一欄在工具 schema 裡不存在，
// 呼叫端只會看到「unknown parameter」而不知道後端其實收。
const FILTER_DIM_LABELS = {
  type: '工單類型（動態值，請先讀 litejira://meta）',
  status: '狀態（動態值依工單 type 而定，請先讀 litejira://workflow/{type}）',
  statusGroup: '狀態分組（動態值，請先讀 litejira://meta）',
  priority: '優先級（動態值，請先讀 litejira://meta）',
  module: '模塊（動態值，請先讀 litejira://meta）',
  subtype: '子類型（動態值依 type 而定，請先讀 litejira://meta）',
  targetVersion: '目標版本（動態值，請先讀 litejira://versions）',
  foundVersion: '發現版本（動態值，請先讀 litejira://versions）',
  assigneeId: '處理人',
  creatorId: '建立者',
  ownerId: '負責人（最終負責人）',
  parentId: '父工單',
  title: '標題',
  description: '內文描述'
};
// 四個運算子的語意。`Not` 那一格的但書是後端 `addNotInFilter` 的行為，
// 講出來的理由：「處理人不是張三」撈不撈得到未指派的單，是呼叫端一定會問的問題。
const FILTER_OP_NOTES = {
  '': '＝這些值之一',
  Not: '「不是」這些值（含該欄為空的工單，例如「處理人不是張三」也會撈到未指派的單）',
  Contains: '「包含」這段文字（子字串比對，只看這一欄；跨欄搜尋請用 q）',
  NotContains: '「不包含」這段文字（子字串比對，只看這一欄）'
};
const MULTI_VALUE_NOTE = '。單值傳字串，多值傳字串陣列（肯定條件匹配任一值，Not／NotContains 排除整個值集合；不同參數之間＝交集）';

function filterParamSchema_(dim, op) {
  const label = FILTER_DIM_LABELS[dim] + FILTER_OP_NOTES[op];
  const isUuid = UUID_FILTER_DIMS.indexOf(dim) !== -1;
  const item = isUuid
    ? { type: 'string', pattern: UUID_SCHEMA_PATTERN }
    // 空字串在後端等同「沒有指定」（會被靜默剔除）；本層當面擋下，不讓呼叫端以為有濾到。
    : { type: 'string', minLength: 1 };
  const schema = {
    type: ['string', 'array'],
    description: 'Filter：' + label + MULTI_VALUE_NOTE +
      (isUuid ? '。只收 UUID，顯示名無法查詢，請先讀 litejira://members 取 id' : '') + '。',
    items: item
  };
  if (isUuid) schema.pattern = UUID_SCHEMA_PATTERN;
  else schema.minLength = 1;
  return schema;
}

// 32 個運算子欄（12 個列舉維度 × 2 ＋ 2 個文字維度 × 4），鍵名與查詢參數逐字相同。
const SEARCH_FILTER_PARAMS = (function () {
  const out = {};
  ENUM_FILTER_DIMS.forEach((dim) => {
    ENUM_FILTER_OPS.forEach((op) => { out[dim + op] = filterParamSchema_(dim, op); });
  });
  TEXT_FILTER_DIMS.forEach((dim) => {
    TEXT_FILTER_OPS.forEach((op) => { out[dim + op] = filterParamSchema_(dim, op); });
  });
  return out;
})();

// ── LJ-095 v2 + LJ-116：Tool 定義（12 個）+ LJ-178 批量（3 個）──
const TOOL_DEFS = [
  // 既有保留（7 個）
  tool('litejira.searchTickets',
    'Search and filter tickets via API v1 (GET /tickets). PROJECT IS MANDATORY: pass project=<KEY>, or rely on the LTJ_PROJECT startup setting; with neither the server returns invalid_argument and this tool rejects the call locally. There is NO "omit project to search everything" mode. The ONLY cross-project query is mine=assignee|creator|watcher ("my tickets"), and when you go cross-project the server accepts NO other filter (no q, no type/status/priority/…, no member ids) — add project if you need to filter. Returns { items, nextCursor } — each item carries a UUID "id" plus a human-readable public "key"; member fields are { id, name } objects (null when unset). Pass nextCursor back as "cursor" to page. Member/parent filters take UUIDs only (assigneeId / ownerId / creatorId / parentId) — read litejira://members for ids; display names are NOT accepted. EVERY filter dimension accepts a string or an array of strings (positive conditions match any listed value; Not and NotContains exclude the entire listed set; different parameters are AND-ed) and EVERY dimension has a negated twin: append "Not" (statusNot, assigneeIdNot, typeNot, …) — a negated filter also matches tickets where that field is empty. The two text dimensions (title / description) additionally take Contains / NotContains for substring matching on that single column (q searches across columns instead). Also available: overdue=true|false (has a due date, past due, not final) and id=<uuid>[] to name up to ' + TICKET_ID_FILTER_MAX + ' specific tickets. All of these are general filters, so none of them may be combined with a bare cross-project mine query. Use litejira://ticket/{id} for one complete ticket.',
    'searchTickets', false, Object.assign({
      project: { type: 'string', description: '專案 key（必填）。省略時採用啟動環境的 LTJ_PROJECT；' +
        '連正式站（litejira.untaglab.com）時就算憑證檔沒有 LTJ_PROJECT 這一行也有內建預設主專案 MAIN，' +
        '所以「憑證檔只有 token」是完整的設定，不要因此判定使用者尚未設定完成。' +
        '兩者皆無時本機直接擋下 —— v1 的工單查詢一定要有專案範圍，不存在「不帶就是全部」。' +
        '真的要跨專案請改帶 mine（此時不能再帶任何其他篩選條件）。' },
      mine: {
        type: 'string',
        description: '「我的」那一類：assignee=我處理的、creator=我建的、watcher=我關注的。' +
          '這是唯一能跨專案的條件（不帶 project 時必填）。跨專案時伺服器不接受任何其他篩選；' +
          '與 project 併用則是「那個專案裡我的那些」（縮小範圍，不放寬）。' +
          '注意：只帶 mine 時**不會**套用 LTJ_PROJECT 預設（那會偷偷把「我的全部」收斂成一個專案）；' +
          '要限定專案請明確帶 project。此條件需要權杖有歸屬人，bot 權杖會被伺服器拒。',
        enum: ENUM_MINE
      },
      q: { type: 'string', description: 'Keyword search across title + description（跨欄合併搜尋；' +
        '只想比對單一欄請改用 titleContains / descriptionContains）', minLength: 1 },
      overdue: {
        type: 'boolean',
        description: '已逾期篩選：true = 有到期日、已過期且尚未進終態；false = 其餘（含沒填到期日的單）。' +
          '省略 = 不過濾。只收布林，不收 "yes" / 0 這類值。'
      },
      id: {
        type: ['string', 'array'],
        description: '指名工單 UUID（一次最多 ' + TICKET_ID_FILTER_MAX + ' 個；單值傳字串，多值傳陣列）。' +
          '只收 UUID，不收公開 key / 數字 key（那兩種請用 litejira://ticket/{ref} 逐張讀）。' +
          '這是一般篩選：跨專案（只帶 mine）時不可使用。',
        items: { type: 'string', pattern: UUID_SCHEMA_PATTERN },
        pattern: UUID_SCHEMA_PATTERN,
        maxItems: TICKET_ID_FILTER_MAX
      },
      limit: P_LIMIT,
      cursor: P_CURSOR,
      sort: { type: 'string', description: 'Sort field（v1 契約值域，15 欄；預設 updatedAt）', enum: ENUM_SORT },
      order: P_ORDER
    }, SEARCH_FILTER_PARAMS), [], {
      readOnlyHint: true,
      openWorldHint: true,
      title: '搜尋工單'
    }, {
      v1: { action: 'searchTickets', defaultProject: true, projectAlternative: 'mine' },
      // 舊參數在 v1 沒有等價語意：靜默丟掉會讓呼叫端以為有濾到，故明確拒絕並指路。
      removedParams: {
        assignee: '改用 assigneeId（UUID）；v1 不收顯示名，請先讀 litejira://members 取 id',
        owner: '改用 ownerId（UUID）；請先讀 litejira://members 取 id',
        creator: '改用 creatorId（UUID）；請先讀 litejira://members 取 id',
        version: '版本條件分成 targetVersion（目標版本）與 foundVersion（發現版本）兩個獨立參數，請明講是哪一個',
        responseMode: 'v1 的 GET /tickets 沒有 responseMode；清單一律回契約定義的欄位集合。' +
          '只要數量請自行讀回應長度，單張完整內容請讀 litejira://ticket/{id}'
      }
    }),
  tool('litejira.listComments',
    'List comments for a ticket via API v1 (GET /tickets/{ticket}/comments). Paginated with limit / cursor / order; returns { items, nextCursor } where each item carries a UUID id and an author { id, name }. The ticket argument accepts a UUID, a public key (BUG-481) or a numeric key.',
    'listComments', false, {
      ticketId: P_TICKET_REF,
      limit: P_LIMIT,
      cursor: P_CURSOR,
      order: P_ORDER
    }, ['ticketId'], {
      readOnlyHint: true,
      openWorldHint: true,
      title: '列出工單留言'
    }, {
      v1: { action: 'listComments', ticketParam: 'ticket' }
    }),
  tool('litejira.getActivityLog',
    'Get the activity timeline for a ticket via API v1 (GET /tickets/{ticket}/activity). Paginated with limit / cursor / order. Filter with kind=user (human actions incl. comments) or kind=system (status changes, reassignments); OMIT kind to get everything. Returns { items, nextCursor }.',
    'getActivityLog', false, {
      ticketId: P_TICKET_REF,
      limit: P_LIMIT,
      cursor: P_CURSOR,
      order: P_ORDER,
      kind: {
        type: 'string',
        description: '事件種類單選：user=使用者操作（含留言）、system=系統事件。不帶此參數 = 全部。',
        enum: ACTIVITY_KIND_VALUES.slice()
      }
    }, ['ticketId'], {
      readOnlyHint: true,
      openWorldHint: true,
      title: '取工單時間軸'
    }, {
      v1: { action: 'getActivityLog', ticketParam: 'ticket' },
      removedParams: {
        // 舊參數是兩個獨立布林，v1 是單選 kind，語意不是一對一（兩者皆真 = 不帶 kind）。
        includeComments: 'v1 改用 kind=user|system 單選，不帶 kind 才是全部；請改帶 kind（留言屬 user）',
        includeSystemEvents: 'v1 改用 kind=user|system 單選，不帶 kind 才是全部；請改帶 kind'
      }
    }),
  tool('litejira.linkTickets',
    'Set or remove the parent of a ticket via API v1 (PUT /tickets/{childId}/parent). The child is identified by a UUID, a public key (BUG-481) or a numeric key; the parent MUST be a UUID (display names and public keys are NOT accepted — read the parent with litejira.searchTickets / litejira://ticket/{id} and use its "id"). Pass parentId=null to unlink. Optionally pass expectedUpdatedAt (the raw ISO string you read) for optimistic locking.',
    'linkTickets', true, {
      childId: P_TICKET_REF,
      parentId: {
        type: ['string', 'null'],
        description: '父工單 UUID（不是公開 key、不是顯示名）；傳 null 解除父子關聯。',
        pattern: UUID_SCHEMA_PATTERN
      },
      expectedUpdatedAt: P_EXPECTED_UPDATED_AT,
      idempotencyKey: P_IDEMPOTENCY
    }, ['childId', 'parentId', 'idempotencyKey'], {
      destructiveHint: true,
      openWorldHint: true,
      title: '關聯/解除工單父子'
    }, {
      v1: { action: 'linkTickets' },
      removedParams: {
        parent: '父工單改用 parentId（UUID）',
        ticketId: '子工單參數名是 childId'
      }
    }),
  // GH-257 第四包：replyFeedback 是 CLIENT 端複合，不是單一端點。
  // 舊 GAS 後端（Code.js:3153）就是「先做可選流轉，再 addComment」兩個獨立操作 —— 從來不是原子的。
  // 這裡沿用同樣的步驟順序，另外做三件舊版沒做的事：每步一把穩定且互不相同的冪等鍵、
  // 流轉失敗就不送留言、留言失敗時如實回報「流轉已生效、留言沒送成」。
  tool('litejira.replyFeedback',
    'Post a comment on a ticket, optionally preceded by a status transition. NOT ATOMIC and never was: this is a CLIENT-SIDE COMPOSITE of two v1 calls in a fixed order — (1) POST /transitions if "transition" is given, then (2) POST /comments. There is no rollback. If the transition fails the comment is NOT sent (you get the transition error). If the comment fails AFTER a successful transition you get an explicit partial-success error naming the completed step. Each step uses its own stable idempotency key derived from your idempotencyKey. Dedupe is NOT unlimited: it holds only inside the server\'s 24h idempotency retention window AND only for a byte-identical retry, so a same-key retry of the whole call re-uses the already-applied step only within that window — after it expires, or with a new key, the step really runs a second time. On an unknown outcome (5xx / network / idempotency_key_reused with details.reason=in_progress) do NOT auto-retry and do NOT mint a new key: read the current ticket state first. On details.reason=request_mismatch the payload you just sent was rejected, but the outcome of the EARLIER request under that key is not proven — inspect state and resume only the step that is genuinely missing. The transition takes an ACTION LABEL (call litejira.getTransitions first) — v1 does NOT accept a target status name. For comment-only, prefer litejira.addComment; expectedUpdatedAt is accepted ONLY together with a transition (the comment endpoint has no optimistic lock).',
    'replyFeedback', true, {
      ticketId: P_TICKET_REF,
      content: { type: 'string', description: '留言內容（Markdown 支援）；會以 POST /tickets/{id}/comments 的 body 送出。' },
      transition: {
        type: 'object',
        description: '可選的狀態流轉，會在留言「之前」執行。Shape: { action: string, reason?: string, fields?: object }。' +
          'action 是動作標籤（先呼叫 litejira.getTransitions 取 data.actions[] 的 label）；' +
          'v1 不收目標狀態名（toStatus / status）。reason 必填＝以下三條命中任一：' +
          'direction=back／label=「main不受影響」／該動作 requiresReason=true' +
          '（後者為 false 不代表前兩條也不成立）。送測類動作的連帶欄位放 fields。'
      },
      expectedUpdatedAt: P_EXPECTED_UPDATED_AT,
      idempotencyKey: P_IDEMPOTENCY
    }, ['ticketId', 'content', 'idempotencyKey'], {
      idempotentHint: true,
      openWorldHint: true,
      title: '回覆反饋（可選狀態流轉＋留言，非原子）'
    }, {
      dispatch: 'replyFeedback',
      removedParams: {
        toStatus: '流轉只收動作標籤：請改帶 transition: { action: "…" }（見 litejira.getTransitions 的 data.actions[]）',
        status: '流轉只收動作標籤：請改帶 transition: { action: "…" }',
        body: '留言內文在本工具的參數名是 content（addComment 才是 body）'
      }
    }),
  tool('litejira.listTicketLinks',
    'List ALL external links in the ticket UI Add link section (MR/PR, design, doc, sheet, video, other), via GET /tickets/{ticketId}/links. Returns {items:[{id,url,label,kind,createdAt,createdBy}]}, unpaginated. These are ticket_links, NOT attachments and NOT the legacy mrUrl field. Use addTicketLink with kind=mr for MR/PR; removeTicketLink takes the returned link id.',
    'listTicketLinks', false, { ticketId: P_TICKET_REF }, ['ticketId'],
    { title: '列出工單連結（含 MR／PR）' }, { v1: { action: 'listTicketLinks' } }),
  tool('litejira.addTicketLink',
    'Add an external link to the SAME Add link section shown in the ticket UI, via POST /tickets/{ticketId}/links. Set kind=mr for MR/PR (not attachLink, which creates an attachment). Body {url,label?,kind?}; default kind=other. Returns the created {id,url,label,kind,createdAt,createdBy}. Same URL may be added twice. Requires idempotencyKey. On an uncertain response, first listTicketLinks; any retry must use the same key and identical request within the 24-hour retention window. Does not change status or the legacy mrUrl field.',
    'addTicketLink', true, {
      ticketId: P_TICKET_REF,
      url: { type: 'string', description: '外部網址（最多2048字元）；可省略https://，不得內嵌帳密。伺服器驗證並正規化。' },
      label: { type: 'string', description: '選填顯示名稱，最多100字元，空字串顯示網址。' },
      idempotencyKey: P_IDEMPOTENCY,
      kind: { type: 'string', enum: ['mr', 'design', 'doc', 'sheet', 'video', 'other'], description: 'MR／PR使用mr；省略為other。' }
    }, ['ticketId', 'url', 'idempotencyKey'], { title: '加入工單連結（含 MR／PR）', idempotentHint: true },
    { v1: { action: 'addTicketLink' } }),
  tool('litejira.removeTicketLink',
    'Remove one external ticket link from the UI Add link section via DELETE /tickets/{ticketId}/links/{linkId}. Use the UUID from listTicketLinks, NOT an attachment id or URL. Returns {items:[remaining links]}, HTTP 200 (not 204). A missing or cross-ticket id returns not_found. Requires idempotencyKey; after an uncertain response, listTicketLinks first, then retry only with the same key and identical request within 24 hours. Does not delete the external document.',
    'removeTicketLink', true, {
      ticketId: P_TICKET_REF, linkId: { type: 'string', description: 'listTicketLinks回傳的連結UUID。' }, idempotencyKey: P_IDEMPOTENCY
    }, ['ticketId', 'linkId', 'idempotencyKey'], { title: '移除工單連結', destructiveHint: true, idempotentHint: true },
    { v1: { action: 'removeTicketLink' } }),
  tool('litejira.attachLink',
    'Attach a reference URL (doc, design, external page) to a ticket via API v1 (POST /tickets/{ticketId}/attachments). For the UI Add link section and MR/PR use addTicketLink instead. Body is exactly { url, name? } — v1 attachments have no "kind" classification. Returns the created attachment; keep its "id" — that id (NOT the url) is what litejira.removeAttachment needs.',
    'attachLink', true, {
      ticketId: P_TICKET_REF,
      url: { type: 'string', description: '參考連結 URL，必須 http:// 或 https:// 開頭' },
      name: { type: 'string', description: '顯示名稱（省略則由伺服器決定，通常顯示 url 本身）' },
      idempotencyKey: P_IDEMPOTENCY
    }, ['ticketId', 'url', 'idempotencyKey'], {
      idempotentHint: true,
      openWorldHint: true,
      title: '附加 URL 連結'
    }, {
      v1: { action: 'attachLink' },
      removedParams: {
        kind: 'v1附件不分kind；要寫入網站加連結區的MR／PR等分類請改用litejira.addTicketLink。'
      }
    }),
  tool('litejira.removeAttachment',
    'Remove an attachment from a ticket via API v1 (DELETE /tickets/{ticketId}/attachments/{attachmentId}). Identified by the attachment UUID, NOT by url — read litejira://ticket/{id} (or the attachLink response) to get the attachment id first. Same url attached twice = two distinct ids. Returns 204 with no body on success; a non-existent id returns not_found (it does NOT silently report removed:false).',
    'removeAttachment', true, {
      ticketId: P_TICKET_REF,
      attachmentId: {
        type: 'string',
        description: '附件 UUID（讀 litejira://ticket/{id} 的附件清單，或沿用 attachLink 回傳的 id）。',
        pattern: UUID_SCHEMA_PATTERN
      },
      idempotencyKey: P_IDEMPOTENCY
    }, ['ticketId', 'attachmentId', 'idempotencyKey'], {
      destructiveHint: true,
      openWorldHint: true,
      title: '移除附件'
    }, {
      v1: { action: 'removeAttachment' },
      removedParams: {
        url: 'v1 依 attachmentId（UUID）刪除；url 不是 id，也不會拿 url 反查。' +
          '請先讀 litejira://ticket/{id} 的附件清單取該筆的 id'
      }
    }),
  // ── GH-317：附件的「拿得到檔」與「放得上檔」──────────────────────────────
  //
  // 這兩個工具補的是舊版沒有的兩件事：既有附件的**實際取檔 URL**，以及**二進位上傳**。
  // 舊版只有 attachLink（貼一條外部 URL）——助手拿到附件清單後沒有任何辦法把檔案看到，
  // 也沒有辦法把本機產出的檔案放上去，只能回一句「請你自己去網頁開」。
  tool('litejira.getAttachments',
    'List a ticket\'s attachments WITH working download entry points (read-only; reads GET /tickets/{ticket}/attachments — the ticket detail itself carries NO attachments field, this dedicated route is the only source). The route returns the COMPLETE set, unpaginated (no limit/cursor/order), as data.items[]; ordering is deterministic but is NOT "the user\'s order". Each item keeps every original field verbatim (id, storage, name, url, uploadedBy, createdAt) — including the legacy "url" of link-type attachments, which is echoed as links.legacy. Each item additionally gets links.web (' +
      'GET /api/web/attachments/{id}/content — open in a logged-in BROWSER, this is the one to hand to a human) and links.api (' +
      ATTACHMENT_DOWNLOAD_CONTRACT + ' — requires an "Authorization: Bearer <PAT>" header; it returns raw bytes, or a 302 to legacy storage). NO URL EVER CONTAINS THE PAT, so links.web is safe to paste into chat; links.api is not a "click here" link. There is no download tool: this server never fetches attachment bytes and never follows a redirect with your Bearer attached — use the returned URLs with your own HTTP client. The response also carries an "upload" descriptor (method / url template / required headers, PAT value NOT included) for callers that want to upload over raw HTTP instead of litejira.uploadAttachment.',
    'listAttachments', false, {
      ticketId: P_TICKET_REF
    }, ['ticketId'], {
      readOnlyHint: true,
      openWorldHint: true,
      title: '列出工單附件（含取檔 URL）'
    }, {
      dispatch: 'getAttachments',
      removedParams: {
        download: '本工具不下載內容，只回 URL：伺服器不代抓檔案（會把 Bearer 帶去跟隨 redirect），' +
          '也不會把二進位內容塞進 JSON 回應。請自行用回傳的 links.api / links.web 取檔。',
        url: '本工具不接受 URL：它只讀工單自己的附件清單，不會去抓任意外部網址的檔案'
      }
    }),
  tool('litejira.uploadAttachment',
    'Upload a LOCAL FILE as a ticket attachment (' + ATTACHMENT_UPLOAD_CONTRACT + '). The request body is the RAW BYTES of the file — there is no multipart form and no JSON/base64 envelope, the filename travels in the URL-encoded "name" query and the real MIME type in Content-Type. Pass filePath (a path on the machine running this MCP server); the file is streamed in chunks under a hard size cap (default ' +
      DEFAULT_MAX_UPLOAD_BYTES + ' bytes, ceiling ' + UPLOAD_BYTES_CEILING + ', see LTJ_MCP_MAX_UPLOAD_BYTES) and its bytes are NEVER echoed into the response. Only regular files are accepted: directories, FIFOs, sockets, device nodes, 0-byte files and oversized files are rejected locally before anything is sent. A URL is NOT a filePath — this tool will not fetch remote content; to attach an external link use litejira.attachLink instead. ' +
      'THIS ENDPOINT TAKES NO Idempotency-Key (the server answers 422 — a streamed body cannot be fingerprinted before it is sent), so an unknown outcome CANNOT be deduped: do NOT auto-retry, call litejira.getAttachments first and check whether the file is already there. Requires LTJ_MCP_ENABLE_WRITES=true like every other write tool.',
    'uploadAttachment', true, {
      ticketId: P_TICKET_REF,
      filePath: {
        type: 'string',
        description: '本機檔案路徑（執行本 MCP server 那台機器上的路徑）。相對路徑以 server 的工作目錄解析。' +
          '只收普通檔案；不收 http(s):// 或 file:// 等 URL —— 本工具不會去下載任何遠端內容。',
        minLength: 1
      },
      name: {
        type: 'string',
        description: '附件顯示名 / 下載檔名（省略 = 取 filePath 的檔名）。會以 URL-encode 後放進 ?name=；' +
          '不可含路徑分隔符或控制字元。',
        minLength: 1,
        maxLength: 255
      },
      contentType: {
        type: 'string',
        description: '檔案實際 MIME（type/subtype，例 image/png、application/pdf）。' +
          '省略 = 由副檔名推斷，推不出來則 application/octet-stream。不接受參數（; charset=…）。',
        minLength: 3
      },
      timeoutMs: {
        type: 'integer',
        description: '整次上傳期限，預設 300000 毫秒（5 分鐘），可依檔案大小與網速調整，最多 10 分鐘。',
        minimum: 1,
        maximum: 600000
      },
      maxBytes: {
        type: 'integer',
        description: '本次上傳的位元組上限（省略 = 啟動設定的上限）。只能調低或在天花板內調高，' +
          '超過 ' + UPLOAD_BYTES_CEILING + ' 一律拒絕。',
        minimum: 1,
        maximum: UPLOAD_BYTES_CEILING
      }
    }, ['ticketId', 'filePath'], {
      // 上傳是「新增一筆」，不覆寫也不刪除；但它不是冪等的（同名可以重複上傳成兩筆），
      // 所以 idempotentHint 明確標 false —— 標 true 會誘導主機自動重試。
      idempotentHint: false,
      openWorldHint: true,
      title: '上傳本機檔案為工單附件'
    }, {
      dispatch: 'uploadAttachment',
      removedParams: {
        idempotencyKey: '此端點不接受 Idempotency-Key（後端回 422：串流上傳無法在送出前算出請求指紋）。' +
          UPLOAD_UNKNOWN_OUTCOME,
        url: '要附加外部連結請改用 litejira.attachLink；本工具只上傳本機檔案，不會去抓遠端 URL 的內容',
        content: '本工具不收檔案內容（base64 / 字串都不收）：內容走串流，參數只給 filePath',
        data: '本工具不收檔案內容（base64 / 字串都不收）：內容走串流，參數只給 filePath',
        base64: '本工具不收 base64 內容：請把檔案寫到本機再給 filePath（避免把整個檔案塞進 JSON）',
        kind: 'v1 的附件不分 kind；分類資訊請寫進 name'
      }
    }),
  tool('litejira.updateField',
    'Update ONE ticket field. One tool, five v1 routes — the field decides which: (a) ordinary fields (title, priority, description, module, subtype, releaseMethod, stdLevel2, stdLevel3, startDate, dueDate, tags, mrUrl, reproSteps, expectedResult, fixMethod, validationMethod, verifiableVersionAlpha, verifiableVersionRelease, ownerId) go to PATCH /tickets/{id} and take NO reason; (b) parentId goes to PUT /parent and takes a parent UUID or null; (c) assigneeId goes to PUT /assignee and REQUIRES reason; (d) targetVersion / foundVersion go to PUT /versions and take a version UUID or null (read litejira://versions — NOT the version name), with reason required by the server whenever the value actually changes; (e) status goes to the ADMIN-ONLY PUT /status and requires force=true. Renames: verifyMethod→validationMethod, owner→ownerId, assignee→assigneeId, version→targetVersion/foundVersion. "notes" has NO v1 equivalent — write it into description yourself; this tool will not move text between fields. field=status WITHOUT force=true is rejected locally: normal transitions MUST go through litejira.transitionTicket (action labels, role auto-reassign, send-test field gate). force=true only bypasses workflow PATH validation and only for admins (the server decides); the send-test required fields still apply, and force is never part of the request body. Values: null clears (including priority); tags is an array of strings; dates are YYYY-MM-DD; text fields accept "" except title.',
    'updateField', true, {
      ticketId: P_TICKET_REF,
      field: {
        type: 'string',
        description: '要改的欄位名（v1 契約名）。一般欄位直接 PATCH；parentId / assigneeId / targetVersion / foundVersion / status 各走專屬端點。',
        enum: ENUM_UPDATE_FIELDS
      },
      value: {
        type: ['string', 'null', 'array'],
        description: '新值（必填，要清空就明確傳 null）。型別依 field 而定：' +
          'tags 傳字串陣列；startDate / dueDate 傳 YYYY-MM-DD；' +
          'ownerId / assigneeId / parentId / targetVersion / foundVersion 傳 UUID（成員讀 litejira://members、版本讀 litejira://versions、父工單用其 id）；' +
          'priority / module / subtype / releaseMethod 等受控值讀 litejira://meta；status 傳目標狀態名（僅配 force=true）。',
        items: { type: 'string' }
      },
      force: {
        type: 'boolean',
        description: '管理者強制改狀態：只在 field=status 時可帶，且只接受 true（省略＝不強制）。' +
          '繞過的是工作流「路徑」驗證，不是欄位必填；是否真的放行由伺服器判斷（非 admin 會被拒）。' +
          '一般流轉請改用 litejira.transitionTicket。'
      },
      reason: {
        type: 'string',
        description: '異動原因，會記入工單歷程。field=assigneeId 時必填；' +
          'field=targetVersion / foundVersion / status 可帶（版本值真的改變時後端會要求）。' +
          '一般欄位的端點不收 reason，帶了會被本機擋下（不會被靜默丟掉）。'
      },
      expectedUpdatedAt: P_EXPECTED_UPDATED_AT,
      idempotencyKey: P_IDEMPOTENCY
    }, ['ticketId', 'field', 'idempotencyKey'], {
      destructiveHint: true,
      openWorldHint: true,
      title: '更新單一工單欄位'
    }, {
      dispatch: 'updateField',
      legacyValues: { field: UPDATE_FIELD_LEGACY },
      removedParams: {
        toStatus: '目標狀態請放在 value（且 field=status、force=true）；一般流轉請改用 litejira.transitionTicket',
        newValue: '新值的參數名是 value'
      }
    }),
  // LJ-095 新增（5 個）
  tool('litejira.createTicket',
    'Create a ticket via API v1 (POST /tickets). Body is FLAT — core fields: project, type, title, priority?, description?, assigneeId?. ALL of these optional fields are supported too and go straight into the create call (do NOT stuff them into description and do NOT wait until after creation): module, subtype, releaseMethod, stdLevel2, stdLevel3, startDate, dueDate, tags, mrUrl, reproSteps, expectedResult, fixMethod, validationMethod, verifiableVersionAlpha, verifiableVersionRelease, ownerId, targetVersion, foundVersion. The 18 additional fields may be null; core priority/description/assigneeId may be omitted but not null; dates are YYYY-MM-DD; tags is an array of strings; assigneeId / ownerId are member UUIDs (display names are NOT accepted — read litejira://members). Controlled values (type / priority / releaseMethod / module / subtype / version strings) come from litejira://meta and litejira://versions; releaseMethod is validated by the server. NOT part of create: status (the workflow start status applies — use litejira.transitionTicket), parentId (create first, then litejira.linkTickets) and expectedUpdatedAt (nothing to lock yet). targetVersion / foundVersion here are version NAMES.',
    'createTicket', true, {
      project: { type: 'string', description: '專案 key。省略時採用啟動環境的 LTJ_PROJECT；' +
        '正式站（litejira.untaglab.com）即使沒設 LTJ_PROJECT 也有內建預設主專案 MAIN。' +
        '兩者皆無會明確報錯（不會自動挑專案）。' },
      type: { type: 'string', description: '工單類型；IDEA 已退役，不能建單。', enum: ENUM_CREATE_TYPES },
      title: { type: 'string', description: '工單標題' },
      priority: { type: 'string', description: '優先級（含中文後綴），可省略，不接受 null。', enum: ENUM_PRIORITIES },
      description: { type: 'string', description: '工單描述（Markdown）；可省略或空字串，不接受 null。' },
      assigneeId: P_MEMBER_UUID('處理人'),
      ownerId: P_CREATE_MEMBER_UUID('負責人（最終負責人，不隨狀態流轉變化）'),
      module: P_CREATE_TEXT('模塊。動態受控值，請先讀 litejira://meta'),
      subtype: P_CREATE_TEXT('子類型（依 type 而定）。動態受控值，請先讀 litejira://meta'),
      // releaseMethod 的 v1 值域由後端裁決：本層不寫死 enum（寫死會在後端新增值時擋掉合法輸入）。
      releaseMethod: P_CREATE_TEXT('發布方式（受控值，例：待定 / 熱更 / 換包 / 停服）。實際值域以 litejira://meta 與伺服器驗證為準', false),
      stdLevel2: P_CREATE_TEXT('規範二級分類（STD 用）'),
      stdLevel3: P_CREATE_TEXT('規範三級分類（STD 用）'),
      startDate: P_CREATE_DATE('開始日期'),
      dueDate: P_CREATE_DATE('到期日'),
      tags: {
        type: ['array', 'null'],
        description: '標籤（字串陣列）。null = 不設；不要傳逗號串接的單一字串。',
        items: { type: 'string' }
      },
      mrUrl: P_CREATE_TEXT('MR / PR 連結'),
      reproSteps: P_CREATE_TEXT('重現步驟（BUG 用）—— 這是獨立欄位，不要併進 description'),
      expectedResult: P_CREATE_TEXT('預期結果（BUG 用）—— 這是獨立欄位，不要併進 description'),
      fixMethod: P_CREATE_TEXT('修復方式'),
      validationMethod: P_CREATE_TEXT('驗證方式（舊名 verifyMethod）'),
      verifiableVersionAlpha: P_CREATE_TEXT('可驗證版本（alpha）'),
      verifiableVersionRelease: P_CREATE_TEXT('可驗證版本（release）'),
      targetVersion: P_CREATE_TEXT('目標版本「名稱」（不是版本 UUID）。動態值，請先讀 litejira://versions'),
      foundVersion: P_CREATE_TEXT('發現版本「名稱」（BUG 常用，不是版本 UUID）。動態值，請先讀 litejira://versions'),
      idempotencyKey: P_IDEMPOTENCY
    }, ['type', 'title', 'idempotencyKey'], {
      idempotentHint: true,
      openWorldHint: true,
      title: '建立工單'
    }, {
      v1: { action: 'createTicket', defaultProject: 'required' },
      // 只剩「舊名 → 新名」與「本來就不屬於建單」的指路；建單支援的欄位一律直接收，
      // 不再叫呼叫端寫進 description 或建單後補做（那會讓資料落在錯的地方）。
      removedParams: {
        assignee: '處理人改用 assigneeId（UUID）；請先讀 litejira://members 取 id',
        owner: '負責人改用 ownerId（UUID）；請先讀 litejira://members 取 id',
        version: '版本拆成 targetVersion（目標版本）與 foundVersion（發現版本），請明講是哪一個',
        verifyMethod: '驗證方式的欄位名是 validationMethod',
        notes: 'v1 建單沒有 notes 欄位；補充說明請併入 description',
        parentId: '建單端點不掛父子；請先建單，再用 litejira.linkTickets（parentId 收 UUID）掛上',
        status: '建單不指定狀態（由工作流起始狀態開始）；要改狀態請用 litejira.transitionTicket 的動作標籤',
        expectedUpdatedAt: '建單沒有既有版本可鎖，不收 expectedUpdatedAt'
      }
    }),
  tool('litejira.addComment',
    'Post a comment on a ticket via API v1 (POST /tickets/{ticketId}/comments). Body is { body, mentions? } — the comment text parameter is "body", and mentions is an array of member UUIDs (read litejira://members). This endpoint does NOT transition status and does NOT take an optimistic lock: to change status, call litejira.transitionTicket separately.',
    'addComment', true, {
      ticketId: P_TICKET_REF,
      body: { type: 'string', description: '留言內容（Markdown 支援）' },
      mentions: {
        type: 'array',
        description: '要 @ 的成員 UUID 陣列（顯示名無效，請先讀 litejira://members 取 id）',
        items: { type: 'string', pattern: UUID_SCHEMA_PATTERN }
      },
      idempotencyKey: P_IDEMPOTENCY
    }, ['ticketId', 'body', 'idempotencyKey'], {
      idempotentHint: true,
      openWorldHint: true,
      title: '新增留言'
    }, {
      v1: { action: 'addComment' },
      removedParams: {
        content: '留言內文的參數名是 body',
        transition: '留言不再夾帶狀態流轉；請先留言，再呼叫 litejira.transitionTicket',
        toStatus: '留言不再夾帶狀態流轉；請先留言，再呼叫 litejira.transitionTicket',
        expectedUpdatedAt: '留言端點不做樂觀鎖（新增留言不會改動工單版本），故不收 expectedUpdatedAt'
      }
    }),
  tool('litejira.reassignTicket',
    'Reassign a ticket via API v1 (PUT /tickets/{ticketId}/assignee). Body is { assigneeId, reason, expectedUpdatedAt? }: assigneeId is a member UUID (display names are NOT accepted — read litejira://members) and reason is REQUIRED (it is recorded on the ticket history, not optional politeness).',
    'reassignTicket', true, {
      ticketId: P_TICKET_REF,
      assigneeId: P_MEMBER_UUID('新處理人'),
      reason: { type: 'string', description: '轉派原因（必填；會記入工單歷程）' },
      expectedUpdatedAt: P_EXPECTED_UPDATED_AT,
      idempotencyKey: P_IDEMPOTENCY
    }, ['ticketId', 'assigneeId', 'reason', 'idempotencyKey'], {
      idempotentHint: true,
      openWorldHint: true,
      title: '轉派工單'
    }, {
      v1: { action: 'reassignTicket' },
      removedParams: {
        newAssignee: '改用 assigneeId（UUID）；v1 不收顯示名，請先讀 litejira://members 取 id',
        assignee: '改用 assigneeId（UUID）；請先讀 litejira://members 取 id'
      }
    }),
  tool('litejira.convertTicketType',
    'Convert a ticket to another type via API v1 (POST /tickets/{ticketId}/type). Body is { type, subtype?, expectedUpdatedAt? } — the target parameter is "type", not "newType". Valid targets are EPIC / REQ / BUG / TASK only: IDEA and STD can NOT be conversion targets (an IDEA/STD ticket may still be converted away to one of the four).',
    'convertTicketType', true, {
      ticketId: P_TICKET_REF,
      type: {
        type: 'string',
        description: '目標類型（IDEA 與 STD 不能當目標，故 4 選 1）',
        enum: ENUM_CONVERT_TARGET_TYPES
      },
      subtype: { type: 'string', description: '轉型後的子類型（可省略）。動態值依目標 type 而定，請先讀 litejira://meta。' },
      expectedUpdatedAt: P_EXPECTED_UPDATED_AT,
      idempotencyKey: P_IDEMPOTENCY
    }, ['ticketId', 'type', 'idempotencyKey'], {
      destructiveHint: true,
      openWorldHint: true,
      title: '轉換工單類型'
    }, {
      v1: { action: 'convertTicketType' },
      removedParams: {
        newType: '目標類型的參數名是 type'
      }
    }),
  tool('litejira.toggleWatch',
    'Set whether YOU watch a ticket via API v1 (PUT /tickets/{ticketId}/watchers/me to watch, DELETE to unwatch). You must state the DESIRED result with watching=true|false — despite the tool name there is no blind toggle, because a toggle flips back on retry and is not idempotent. Setting the state you are already in is a no-op success. Watched tickets appear in the "我關注的" sidebar filter. Both verbs return the usual { data } envelope (NOT 204 — the only 204 endpoint is removeAttachment).',
    'toggleWatch', true, {
      ticketId: P_TICKET_REF,
      watching: { type: 'boolean', description: '要的結果狀態：true = 關注、false = 取消關注。必填（沒有盲目切換）。' },
      idempotencyKey: P_IDEMPOTENCY
    }, ['ticketId', 'watching', 'idempotencyKey'], {
      idempotentHint: true,
      openWorldHint: true,
      title: '設定工單關注狀態'
    }, {
      v1: { action: 'setWatchState' }
    }),
  // LJ-137 新增（2 個）：動作按鈕流轉對外化 + 查當前可用動作
  tool('litejira.transitionTicket',
    'Perform a status transition via API v1 (POST /tickets/{ticketId}/transitions), WITH the workflow\'s automatic role-based reassignment (首次認領→操作者 / 回流→上一手開發者 / 前進→目標 role 預設人). Body is { action, reason?, fields?, expectedUpdatedAt? }. "action" is an ACTION LABEL, not a target status: call litejira.getTransitions FIRST and use a label from data.actions[] — v1 does NOT accept a target status name. REASON IS REQUIRED whenever ANY of these three hold: (1) the action is BACK-direction (alpha不通過 / release不通過 / MR打回 / 退回 / 退單), (2) the action is the forward「main不受影響」bypass, or (3) litejira.getTransitions reports requiresReason=true for that action — condition (3) being false does NOT clear conditions (1)/(2); a blank reason is rejected with invalid_argument on field "reason". Extra fields required by the transition (e.g. the send-to-test trio) go in "fields".',
    'transitionTicket', true, {
      ticketId: P_TICKET_REF,
      action: { type: 'string', description: '動作標籤（如「開始開發」「送alpha測試」「alpha不通過」）。合法值依工單當前狀態而定，請先呼叫 litejira.getTransitions，取 data.actions[] 裡的標籤。' },
      reason: {
        type: 'string',
        description: '異動原因，會記入工單歷程。必填＝以下三條命中任一：退回類動作／' +
          '前進類的「main不受影響」／該動作 getTransitions 回報 requiresReason=true' +
          '（第三條為 false 不代表前兩條也可省略）。空白字串等同沒填，伺服器會回 invalid_argument（field=reason）。'
      },
      fields: { type: 'object', description: '該動作連帶要填的欄位（物件）。送測類動作需要修復方式 / 驗證方式 / 發布方式這類欄位；實際必填項與欄位名以 getTransitions 的回應與伺服器錯誤訊息為準。' },
      expectedUpdatedAt: P_EXPECTED_UPDATED_AT,
      idempotencyKey: P_IDEMPOTENCY
    }, ['ticketId', 'action', 'idempotencyKey'], {
      idempotentHint: true,
      openWorldHint: true,
      title: '流轉工單狀態（動作按鈕，含自動轉派）'
    }, {
      v1: { action: 'transitionTicket' },
      removedParams: {
        extraFields: '連帶欄位的參數名是 fields（物件）',
        toStatus: 'v1 只收動作標籤 action；目標狀態名是後端內部白名單，不對外接受。請用 litejira.getTransitions 的 data.actions[] 標籤',
        status: 'v1 只收動作標籤 action（見 litejira.getTransitions 的 data.actions[]）',
        force: '此端點不收 force'
      }
    }),
  tool('litejira.getTransitions',
    'Get the currently available action-button transitions for a ticket via API v1 (GET /tickets/{ticketId}/transitions; no query parameters). The ticket argument accepts a UUID, a public key (BUG-481) or a numeric key. Returns the contract object as-is — read data.actions[] and pass an action label to litejira.transitionTicket. Each action item carries requiresReason (boolean, workflow-config-driven, GH-306), but it is NOT the sole source of truth: reason is required whenever ANY of these three hold — direction=back, label=「main不受影響」, or requiresReason=true for that action — and requiresReason can be false even on a BACK-direction action, so a false value never overrides the first two rules. GH-253: any "transitions" array in the payload is NOT an action list; it is the backend validation whitelist of target STATUS names and its values differ from action labels — never pass those to transitionTicket. The same labels are what litejira.batchTransition takes for a whole batch — check them against the CURRENT status of the tickets you are batching.',
    'getAllowedTransitions', false, {
      ticketId: P_TICKET_REF
    }, ['ticketId'], {
      readOnlyHint: true,
      openWorldHint: true,
      title: '查工單當前可用流轉動作'
    }, {
      v1: { action: 'getAllowedTransitions', ticketParam: 'ticketId' }
    }),
  // LJ-178 + GH-257 第四包：批量操作 — 一發打一個 batch 端點（不是 client 端跑 N 次單張寫入）。
  // 三者共通：工單清單參數名是 tickets；沒有樂觀鎖；回 { succeeded, failed } 的部分成功結果。
  tool('litejira.batchTransition',
    'Batch status transition for MANY tickets in ONE call via API v1 (POST /tickets/batch/transitions), by ACTION LABEL, with the same workflow semantics as litejira.transitionTicket (incl. role-based auto-reassign) applied per ticket. Body is { tickets, action, reason?, fields? }: tickets is 1-100 ticket refs (UUID / BUG-481 / numeric). All tickets should currently sit at the same status, or the label will not be valid for every one of them — filter with litejira.searchTickets first. NO optimistic lock (each ticket has its own updatedAt, so one expectedUpdatedAt could not match). PARTIAL SUCCESS IS THE NORM: returns { succeeded:[{ticket,id,key,status,assignee}], failed:[{ticket,error:{code,message,details?}}] } with HTTP 200 even when some tickets failed — always read failed[] and report it; a 200 does NOT mean all tickets changed. Batch permission (can_batch) and per-ticket permissions are enforced by the server; do NOT work around a denial by looping single-ticket writes.',
    'batchTransition', true, {
      tickets: P_TICKETS,
      action: { type: 'string', description: '動作標籤（如「送release測試」「alpha不通過」），對每張工單的當前狀態各自驗證；不合法的落在 failed[]。請先用 litejira.getTransitions 取 data.actions[] 的 label。' },
      reason: {
        type: 'string',
        description: '異動原因（全批共用），會記入每張工單歷程。必填＝以下三條命中任一：退回類動作／' +
          '前進類的「main不受影響」／該動作 requiresReason=true（第三條為 false 不代表前兩條也可省略）。' +
          '沒帶時那幾張會整批落在 failed[]。'
      },
      fields: { type: 'object', description: '該動作連帶要填的欄位（物件，全批共用）。送測類動作需要修復方式 / 驗證方式 / 發布方式這類欄位；實際必填項以 getTransitions 的回應與伺服器錯誤為準。' },
      idempotencyKey: P_IDEMPOTENCY
    }, ['tickets', 'action', 'idempotencyKey'], {
      idempotentHint: true,
      openWorldHint: true,
      title: '批量流轉工單狀態（含自動轉派）'
    }, {
      v1: { action: 'batchTransition' },
      removedParams: {
        ids: '工單清單的參數名是 tickets（1-100 個工單參照：UUID / 公開 key / 數字 key）',
        extraFields: '連帶欄位的參數名是 fields（物件）',
        toStatus: 'v1 只收動作標籤 action；目標狀態名不對外接受',
        status: 'v1 只收動作標籤 action（見 litejira.getTransitions 的 data.actions[]）',
        force: '批次沒有管理者強制途徑；要強制改狀態請逐張用 litejira.updateField（field=status, force=true）',
        expectedUpdatedAt: '批次端點不做樂觀鎖（每張工單的 updatedAt 不同，單一值對不上任何一張）'
      }
    }),
  tool('litejira.batchReassign',
    'Batch reassign MANY tickets to the SAME assignee in ONE call via API v1 (POST /tickets/batch/assignee). Body is { tickets, assigneeId, reason }: assigneeId is a member UUID (display names are NOT accepted — read litejira://members) and reason is REQUIRED (recorded on every ticket\'s history). PARTIAL SUCCESS IS THE NORM: returns { succeeded:[{ticket,id,key,status,assignee}], failed:[{ticket,error:{code,message,details?}}] } with HTTP 200 even when some tickets failed — always read failed[] and report it. For a single ticket use litejira.reassignTicket. Batch and per-ticket permissions are enforced by the server; do NOT loop single-ticket writes to get around a denial.',
    'batchReassign', true, {
      tickets: P_TICKETS,
      assigneeId: P_MEMBER_UUID('新處理人（全批共用）'),
      reason: { type: 'string', description: '轉派原因（必填，全批共用；會記入每張工單歷程）' },
      idempotencyKey: P_IDEMPOTENCY
    }, ['tickets', 'assigneeId', 'reason', 'idempotencyKey'], {
      idempotentHint: true,
      openWorldHint: true,
      title: '批量轉派工單'
    }, {
      v1: { action: 'batchReassign' },
      removedParams: {
        ids: '工單清單的參數名是 tickets（1-100 個工單參照：UUID / 公開 key / 數字 key）',
        newAssignee: '改用 assigneeId（UUID）；v1 不收顯示名，請先讀 litejira://members 取 id',
        assignee: '改用 assigneeId（UUID）；請先讀 litejira://members 取 id',
        expectedUpdatedAt: '批次端點不做樂觀鎖'
      }
    }),
  tool('litejira.batchSetField',
    'Batch set ONE field to the SAME value across MANY tickets in ONE call via API v1. Ordinary fields and parentId go to POST /tickets/batch/fields as { tickets, fields:{ field: value } }; targetVersion / foundVersion go to POST /tickets/batch/versions as { tickets, targetVersionId|foundVersionId, reason? } and take a version UUID or null (read litejira://versions — NOT the version name). parentId here accepts a ticket REF (UUID / BUG-481 / numeric) or null, unlike the single-ticket parent route which takes a UUID; parent/child relations are validated server-side per ticket. status is NOT a batch field — use litejira.batchTransition. NO optimistic lock. PARTIAL SUCCESS IS THE NORM: returns { succeeded:[{ticket,id,key,status,assignee}], failed:[{ticket,error:{code,message,details?}}] } with HTTP 200 even when some tickets failed — always read failed[] and report it. Batch and per-ticket permissions are enforced by the server; do NOT loop single-ticket writes to get around a denial.',
    'batchSetField', true, {
      tickets: P_TICKETS,
      field: {
        type: 'string',
        description: '批量要改的欄位（v1 契約名）。status 不在此 —— 改狀態請用 litejira.batchTransition。',
        enum: ENUM_BATCH_FIELDS
      },
      value: {
        type: ['string', 'null', 'array'],
        description: '新值（必填，全批共用；要清空就明確傳 null）。tags 傳字串陣列；日期傳 YYYY-MM-DD；' +
          'ownerId 傳成員 UUID；targetVersion / foundVersion 傳版本 UUID；parentId 傳工單參照（UUID / BUG-481 / 數字）或 null；' +
          '受控值（priority / module / subtype / releaseMethod…）請先讀 litejira://meta。',
        items: { type: 'string' }
      },
      reason: {
        type: 'string',
        description: '異動原因（全批共用），只有 field=targetVersion / foundVersion 的版本端點接受；' +
          '版本值真的改變時後端會要求。其他欄位的批次端點不收 reason，帶了會被本機擋下。'
      },
      idempotencyKey: P_IDEMPOTENCY
    }, ['tickets', 'field', 'idempotencyKey'], {
      destructiveHint: true,
      openWorldHint: true,
      title: '批量改工單欄位'
    }, {
      dispatch: 'batchSetField',
      legacyValues: { field: BATCH_FIELD_LEGACY },
      removedParams: {
        ids: '工單清單的參數名是 tickets（1-100 個工單參照：UUID / 公開 key / 數字 key）',
        expectedUpdatedAt: '批次端點不做樂觀鎖',
        force: '批次沒有管理者強制途徑；狀態也不是批次欄位'
      }
    })
];

// ── LJ-095 v2：Resource 定義（6 個）；GH-257 第二包改走 API v1 ──
//
// 專案來源（needsProject 的四個資源）：URI 的 ?project=KEY > 環境變數 LTJ_PROJECT。
// 兩者皆無 → 明確報錯，**不**自動挑「第一個專案」（猜錯會安靜回錯專案的資料）。
// query：URI 上允許帶的查詢參數白名單；未列的參數一律擋下，不靜默忽略。
const RESOURCE_DEFS = [
  // GH-255：說明對齊實際回傳（流轉規則已移出 meta，改由 workflow 資源提供）
  {
    uri: 'litejira://meta', name: 'LiteJira 元資料',
    description: '指定專案的類型/優先級/狀態/子類型/模塊清單（不含流轉規則，見 workflow 資源）。' +
      '可用 litejira://meta?project=KEY 指定專案，省略則用 LTJ_PROJECT。',
    action: 'getMeta', needsProject: true, query: ['project']
  },
  {
    uri: 'litejira://members', name: '成員清單',
    description: '工作區成員名冊（含 UUID id —— 搜尋的 assigneeId/ownerId/creatorId 就用這個 id）。' +
      '預設只回啟用成員；可用 litejira://members?activeOnly=false 取全部、?jobRole=ROLE 篩職能。' +
      '注意：成員是工作區層級，不接受 project 參數。',
    action: 'getMembers', needsProject: false, query: ['activeOnly', 'jobRole']
  },
  {
    uri: 'litejira://versions', name: '版本清單',
    description: '指定專案的版本列表。可用 litejira://versions?project=KEY 指定專案，省略則用 LTJ_PROJECT。',
    action: 'getVersions', needsProject: true, query: ['project']
  },
  {
    uri: 'litejira://dashboard', name: 'Dashboard 統計',
    description: '指定專案的統計。scope=all（預設）或 me；scope / targetVersion / role 三者互斥，一次只能帶一個。' +
      '例：litejira://dashboard?project=KEY&scope=me。',
    action: 'getDashboardStats', needsProject: true, query: ['project', 'scope', 'targetVersion', 'role']
  },
  // LJ-116 批次 4: paramMap decodeURIComponent（防 percent-encoded ticketId / type 字符）
  {
    uriTemplate: 'litejira://workflow/{type}', name: '工作流規則',
    description: '指定專案（+ 可選工單類型）的狀態流轉規則。type 可留空（litejira://workflow/）取全部；' +
      '可另帶 ?project=KEY 與 ?flowGroupCode=CODE。',
    action: 'getWorkflow', needsProject: true, query: ['project', 'type', 'flowGroupCode'],
    paramMap: (path) => {
      const type = decodeURIComponent(path.split('/').pop());
      return type === '' ? {} : { type: type };
    }
  },
  {
    uriTemplate: 'litejira://ticket/{id}', name: '工單詳情',
    description: '單張工單資料。{id} 可用 UUID 主鍵、公開 key（BUG-481）或純數字 key。新版 MR／PR 與通用連結另讀 litejira://ticket/{id}/links 或 listTicketLinks；mrUrl 僅是舊欄位，並非完整連結清單。',
    action: 'getTicket', needsProject: false, query: [],
    paramMap: (path) => ({ ticket: decodeURIComponent(path.split('/').pop()) })
  },
  {
    uriTemplate: 'litejira://ticket/{id}/links', name: '工單連結（含 MR／PR）',
    description: '與網站「加連結」共用的完整外部連結清單 {items:[...]}，kind=mr 是 MR／PR。不是附件；舊 mrUrl 另見工單詳情。',
    action: 'listTicketLinks', needsProject: false, query: [],
    paramMap: (path) => ({ ticketId: decodeURIComponent(path.split('/').slice(-2)[0]) })
  }
];

// ── LJ-095 v2：Prompt 定義（4 個）；GH-257 第二包對齊 v1 讀取流程 ──
// 四個 prompt 一律以「彙整草稿 → 使用者確認 → 才寫入」收尾。
// 第四包起寫入工具全部可用，所以收尾語改講寫入紀律（見 WRITE_NOTE），
// 但「先給人看過再送出」這件事不變 —— 可用不等於可以自作主張。
const PROMPT_DEFS = [
  {
    name: 'report-bug',
    description: '回報 BUG — 引導填寫標題/重現步驟/預期結果，讀 meta/members/versions 備妥受控值，草稿確認後用 litejira.createTicket 建單',
    arguments: [
      { name: 'title', description: 'BUG 標題（可選，會再確認）', required: false },
      { name: 'project', description: '專案 key（可選；省略則用啟動設定的 LTJ_PROJECT）', required: false }
    ]
  },
  {
    name: 'weekly-status',
    description: '本週進度報告 — 讀 dashboard 統計 + searchTickets 近期更新，按版本分組彙整',
    arguments: [
      { name: 'project', description: '專案 key（可選；省略則用啟動設定的 LTJ_PROJECT）', required: false }
    ]
  },
  {
    name: 'triage-ticket',
    description: '分類工單 — 讀取完整工單+工作流規則+成員清單（UUID），建議優先級/負責人/狀態',
    arguments: [
      { name: 'ticketId', description: '工單參照：UUID、公開 key（BUG-481）或純數字 key', required: true },
      { name: 'project', description: '專案 key（可選；省略則用啟動設定的 LTJ_PROJECT）', required: false }
    ]
  },
  {
    name: 'close-ticket',
    description: '關閉工單 — 讀工單 + 可用流轉動作，列出到結案的合法路徑，確認後用 litejira.transitionTicket 逐步執行',
    arguments: [
      { name: 'ticketId', description: '工單參照：UUID、公開 key（BUG-481）或純數字 key', required: true }
    ]
  }
];

// GH-257 第二包：沒有 v1 契約列的工具一律標記 pending。
// 用「反推」而不是逐一手寫，確保新增工具時不會漏標而悄悄掉回舊後端。
// GH-257 第四包：18 個工具全部接線，這裡應該一個 pending 都標不出來。
// 反推的寫法保留：日後新增工具時，忘了接線就會立刻變成明確的 TOOL_NOT_MIGRATED，而不是悄悄掉回舊後端。
TOOL_DEFS.forEach(function (def) {
  if (!def.v1 && !def.dispatch) def.pending = true;
});

// LJ-116: tool() factory v2 — 接 annotations、properties 接 short form ('string') 或 long form ({type, description, ...})
// GH-257: extra 帶 v1 契約接線資訊（action / ticketParam / defaultProject）與 removedParams 指路表。
function tool(name, description, action, write, properties, required, annotations, extra) {
  const def = {
    name,
    description,
    action,
    write,
    inputSchema: {
      type: 'object',
      properties: Object.keys(properties || {}).reduce((acc, key) => {
        acc[key] = schemaFor_(properties[key]);
        return acc;
      }, {}),
      required: required || [],
      additionalProperties: false
    }
  };
  if (annotations) def.annotations = annotations;
  if (extra) Object.assign(def, extra);
  return def;
}

// GH-257：只公告已接上 v1 的工具。
// 未升級的工具留在 TOOL_DEFS（這樣 tools/call 回的是明確的 TOOL_NOT_MIGRATED 而非籠統的 unknown tool），
// 但不出現在 tools/list —— 廣告一個必定失敗的工具，只會浪費上下文並誘導助手走死路。
function listTools() {
  return TOOL_DEFS.filter((def) => !def.pending).map((def) => {
    const out = {
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema
    };
    if (def.annotations) out.annotations = def.annotations;
    return out;
  });
}

function getConfigFromEnv(env) {
  const runtimeEnv = env || process.env;
  // 站台 / 專案 / 寫入開關的預設由共用模組裁決（token-only 也能直接用正式站主專案）。
  const settings = resolveSettings(runtimeEnv);
  return {
    apiUrl: settings.apiUrl,
    token: settings.token,
    // GH-257：專案層級端點（meta / versions / dashboard / workflow）的預設專案。
    // 自訂站台沒有內建預設；沒設也不猜，缺的時候明確報錯。
    project: settings.project,
    enableWrites: settings.enableWrites,
    enableWritesInvalid: settings.enableWritesInvalid,
    enableWritesRaw: settings.enableWritesRaw,
    // GH-317：附件上傳的位元組上限。非祕密設定；沒設用預設值，設了壞值一律當面報錯
    //（靜默退回預設＝使用者以為調大了，實際沒有，然後撞一個看不懂的 file_too_large）。
    maxUploadBytes: parseMaxUploadBytes_(runtimeEnv.LTJ_MCP_MAX_UPLOAD_BYTES)
  };
}

function parseMaxUploadBytes_(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_MAX_UPLOAD_BYTES;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n <= 0 || n > UPLOAD_BYTES_CEILING) {
    throw mcpError_('CONFIG_ERROR',
      'LTJ_MCP_MAX_UPLOAD_BYTES 必須是 1 到 ' + UPLOAD_BYTES_CEILING + ' 之間的整數位元組（收到：' + raw + '）',
      { ceiling: UPLOAD_BYTES_CEILING });
  }
  return n;
}

// GH-257：尚未接上 v1 契約的工具一律在本機擋下。
// 關鍵是「不得悄悄退回舊後端」：舊路徑是單一 POST + body token，與 v1 是兩套權限模型，
// 混用會讓呼叫端拿到語意不同的錯誤碼，也讓 PAT 走回舊通道。
function assertMigrated_(def) {
  if (!def.pending) return;
  throw mcpError_('TOOL_NOT_MIGRATED',
    '工具「' + def.name + '」尚未接上 API v1（其 v1 端點契約未取得），本機拒絕呼叫，不會退回舊後端。' +
    '本版已接線的工具見 tools/list。',
    { tool: def.name, action: def.action }, -32601);
}

async function callTool(name, args, config, fetchImpl) {
  const def = TOOL_DEFS.find((candidate) => candidate.name === name);
  if (!def) throw mcpError_('UNKNOWN_TOOL', 'unknown MCP tool: ' + name, undefined, -32602);
  // 未升級的工具先擋：不論 LTJ_MCP_ENABLE_WRITES 設成什麼，回答都一樣且誠實。
  assertMigrated_(def);
  const cfg = config || getConfigFromEnv();
  if (!cfg.apiUrl || !cfg.token) throw mcpError_('CONFIG_ERROR', MISSING_TOKEN_MESSAGE);
  if (def.write && !cfg.enableWrites) {
    // 非法值（既不是 true 也不是 false）一律當成關閉，但錯誤訊息要點名那個值，
    // 否則使用者以為自己「已經打開了」，只會反覆重試同一個打錯的字。
    const detail = cfg.enableWritesInvalid
      ? 'LTJ_MCP_ENABLE_WRITES 的值「' + cfg.enableWritesRaw + '」不合法（只接受 true / false），已 fail closed 視為唯讀'
      : 'write tools require LTJ_MCP_ENABLE_WRITES=true';
    throw mcpError_('WRITES_DISABLED', detail);
  }

  const input = validateToolInput(def, args || {});
  // Idempotency-Key 走 header，不是 body 欄位：在這裡抽出來，別讓它混進 params。
  const idempotencyKey = input.idempotencyKey;

  // GH-257 第四包：replyFeedback 是「兩發呼叫」的複合操作，回應形狀也不同（含步驟與部分成功），
  // 所以整段自成一路，不套下面的單發流程。
  if (def.dispatch === 'replyFeedback') {
    return await replyFeedback_(input, cfg, fetchImpl);
  }
  // GH-317：附件兩個工具也自成一路 —— 一個要對讀回來的清單加工，
  // 另一個的 body 是 raw bytes（走 uploadAttachment，不是 callV1 的 JSON 信封）。
  if (def.dispatch === 'getAttachments') {
    return await getAttachments_(input, cfg, fetchImpl);
  }
  if (def.dispatch === 'uploadAttachment') {
    if (!(fetchImpl || globalThis.fetch)) {
      throw mcpError_('CONFIG_ERROR', 'fetch is required; use Node 18+ or pass fetchImpl');
    }
    return await uploadAttachmentTool_(input, cfg, fetchImpl);
  }
  // 其餘工具都是單發；差別只在「哪一條路由」是由參數決定（updateField / batchSetField）還是固定的。
  const plan = def.dispatch
    ? DISPATCHERS[def.dispatch](input)
    : { action: def.v1.action, params: toV1Params_(def, input, cfg) };

  const outcome = await callV1Or_(plan.action, plan.params, cfg, fetchImpl, idempotencyKey);
  if (outcome.isError) return outcome;
  // 契約上「204 無 body」的端點（本包只有刪附件）：沒有 data 可回。
  // 不編一個假的 { removed: true } 出來 —— 那會讓呼叫端以為伺服器真的說了什麼。
  if (outcome.noContent) {
    const ack = { ok: true, status: outcome.status, noContent: true };
    return {
      content: [{ type: 'text', text: JSON.stringify(ack) }],
      structuredContent: ack
    };
  }
  // v1 的 { data } 信封已由傳輸層拆掉一層，這裡拿到的就是契約裡的 data，原樣送出：
  // 新 shape（UUID id / 公開 key / member { id, name } / nextCursor）不做任何加工或改名。
  const data = outcome.value;
  // LJ-116 批次 4 (H5): 雙寫 — text fallback 給老主機、structuredContent 給新主機
  return {
    // GH-255：緊湊輸出。縮排只服務人眼，AI 一樣能解析，實測膨脹 52%（35.1KB → 53.5KB）
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data
  };
}

// MCP 參數 → v1 params。MCP 端刻意沿用契約參數名，這裡只處理四件事：
//   1. idempotencyKey 抽掉（它是 header，不是查詢 / body 欄位）
//   2. ticketId → 該路由實際的路徑參數名（ticket / ticketId）
//   3. project 預設值：缺了一律明確報錯，不猜專案。
//      'required'（建單）沒有替代方案；searchTickets 則接受 projectAlternative='mine'
//      （GH-313：v1 的工單查詢專案必填，唯一的跨專案入口是「我的」那一類）
//   4. 其餘原樣帶出 —— 不做任何改名或值域轉換，讓傳輸層的白名單是唯一守門人
function toV1Params_(def, input, cfg) {
  const wiring = def.v1;
  const out = {};
  Object.keys(input).forEach((key) => { out[key] = input[key]; });
  delete out.idempotencyKey;
  if (wiring.ticketParam && out.ticketId !== undefined) {
    out[wiring.ticketParam] = out.ticketId;
    if (wiring.ticketParam !== 'ticketId') delete out.ticketId;
  }
  // GH-313：明確帶了跨專案維度（mine）而沒帶 project 時，**不套用 LTJ_PROJECT 預設**。
  // 呼叫端要的是「我的全部」，偷偷收斂到某一個專案會回一份比要求更窄的清單，
  // 而回應裡看不出少了什麼 —— 那正是本檔對靜默篩選一貫拒絕的形態。
  // 要「某專案裡我的那些」就明講 project（契約上兩個都帶＝縮小，不放寬）。
  const crossProject = wiring.projectAlternative !== undefined &&
    out[wiring.projectAlternative] !== undefined;
  if (wiring.defaultProject && out.project === undefined && cfg.project && !crossProject) {
    out.project = cfg.project;
  }
  // GH-313：兩種「缺專案」的處置差別只在有沒有替代方案可指路，不在於要不要報錯。
  // 舊版讓 searchTickets 在缺專案時「不帶此條件」送出去，說法是跨專案搜尋 ——
  // 實際上後端一律回 invalid_argument（R-A15 一），呼叫端只拿到一句伺服器錯誤，不知道該補什麼。
  if (out.project === undefined &&
    (wiring.defaultProject === 'required' || wiring.projectAlternative !== undefined)) {
    const alt = wiring.projectAlternative;
    if (alt === undefined || out[alt] === undefined) {
      throw mcpError_('PROJECT_REQUIRED',
        '工具「' + def.name + '」需要指定專案。請在參數帶 project=<KEY>，' +
        '或在啟動環境設定 LTJ_PROJECT=<KEY>。（不會自動選用任一專案。）' +
        (alt === undefined ? ''
          : '真的要跨專案，請改帶 ' + alt + '=' + ENUM_MINE.join(' | ') +
            '（唯一天然跨專案的維度；此時伺服器不接受任何其他篩選條件）。'),
        { tool: def.name, crossProject: alt }, -32602);
    }
  }
  return out;
}

// ── GH-257 第四包：依欄位分流的兩個工具 ──
//
// v1 沒有「萬用 update」端點：狀態 / 父子 / 處理人 / 版本各有專屬端點，各有自己的必填條件
//（轉派的 reason 必填、改狀態要 admin 途徑）。硬做成一個端點的假象，會讓呼叫端以為
// reason、force 這些參數到處都能帶，然後在伺服器那邊撞一堆難解的錯。
// 所以這裡明確分流，並且對「這條路不收的參數」當面拒絕，不靜默丟掉。

function hasKey_(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function badInput_(message, details) {
  return mcpError_('VALIDATION_FAILED', message, details, -32602);
}

// value 不列進 schema 的 required：required 檢查會把合法的空字串當成缺值。
// 但 value 確實是必填（要清空就明確傳 null），所以在這裡自己檢查「有沒有這個鍵」。
function requireValue_(input, tool) {
  if (!hasKey_(input, 'value')) {
    throw badInput_('缺少必填參數：value（要清空請明確傳 null；' + tool + ' 不會把「沒帶」當成清空）',
      { param: 'value' });
  }
  return input.value;
}

// 這條路不收 reason 時，當面拒絕。收下卻沒地方送＝呼叫端以為原因已記進歷程，實際上沒有。
function rejectReason_(input, field, where) {
  if (input.reason !== undefined) {
    throw badInput_('field=' + field + ' 走的端點（' + where + '）不收 reason，本機拒絕以免你以為原因已記入歷程。' +
      '需要記錄原因的是 assigneeId（必填）、targetVersion / foundVersion 與 status。',
      { param: 'reason', field: field });
  }
}

function rejectForce_(input, field) {
  if (input.force !== undefined) {
    throw badInput_('force 只能用在 field=status（管理者強制改狀態）；field=' + field + ' 不接受 force。',
      { param: 'force', field: field });
  }
}

const DISPATCHERS = {
  updateField: function (input) {
    const field = input.field;
    const value = requireValue_(input, 'litejira.updateField');
    const expectedUpdatedAt = input.expectedUpdatedAt;

    if (field === 'status') {
      // LJ-188：一般流轉一律走 transitionTicket —— 它才帶得動作標籤、送測欄位閘門與角色自動轉派。
      // 沒帶 force 就在本機擋下，不代為改走別條路（猜錯會改出使用者沒要求的狀態）。
      if (input.force !== true) {
        throw badInput_('field=status 沒有 force=true 時一律拒絕：正常的狀態變更請改用 litejira.transitionTicket，' +
          '先呼叫 litejira.getTransitions 取 data.actions[] 的動作標籤（它才會套用工作流的角色自動轉派與送測欄位檢查）。' +
          'force=true 是管理者專用的例外途徑，只繞過工作流「路徑」驗證，不會放寬欄位必填，且是否放行由伺服器判斷。',
          { param: 'force', field: field });
      }
      if (typeof value !== 'string' || value.trim() === '') {
        throw badInput_('field=status 的 value 必須是目標狀態名（非空字串）', { param: 'value' });
      }
      // force 不進 body：它只是「走哪條路」的閘門。
      return {
        action: 'forceSetStatus',
        params: { ticketId: input.ticketId, status: value, reason: input.reason, expectedUpdatedAt: expectedUpdatedAt }
      };
    }

    rejectForce_(input, field);

    if (field === 'parentId') {
      rejectReason_(input, field, 'PUT /tickets/{childId}/parent');
      return {
        action: 'linkTickets',
        params: { childId: input.ticketId, parentId: value, expectedUpdatedAt: expectedUpdatedAt }
      };
    }

    if (field === 'assigneeId') {
      if (value === null) {
        throw badInput_('v1 的轉派端點不收 null：處理人不能用這條路清空（要改人請給新處理人的 UUID）。',
          { param: 'value', field: field });
      }
      if (input.reason === undefined) {
        throw badInput_('field=assigneeId 必須帶 reason（v1 的轉派把原因記進工單歷程，不是可選的客套話）。',
          { param: 'reason', field: field });
      }
      return {
        action: 'reassignTicket',
        params: {
          ticketId: input.ticketId, assigneeId: value,
          reason: input.reason, expectedUpdatedAt: expectedUpdatedAt
        }
      };
    }

    if (hasKey_(VERSION_FIELD_PARAM, field)) {
      const params = { ticketId: input.ticketId, reason: input.reason, expectedUpdatedAt: expectedUpdatedAt };
      // 省略 ＝ 保持原值、null ＝ 清空：這裡一定要明確帶上這個鍵，否則等於什麼都沒改。
      params[VERSION_FIELD_PARAM[field]] = value;
      return { action: 'setTicketVersions', params: params };
    }

    // 一般欄位：平攤成 { [欄位]: 值 } 送 PATCH。值的形狀由傳輸層的契約表把關。
    rejectReason_(input, field, 'PATCH /tickets/{ticket}');
    const params = { ticket: input.ticketId, expectedUpdatedAt: expectedUpdatedAt };
    params[field] = value;
    return { action: 'updateTicketField', params: params };
  },

  batchSetField: function (input) {
    const field = input.field;
    const value = requireValue_(input, 'litejira.batchSetField');

    if (hasKey_(VERSION_FIELD_PARAM, field)) {
      const params = { tickets: input.tickets, reason: input.reason };
      params[VERSION_FIELD_PARAM[field]] = value;
      return { action: 'batchSetVersions', params: params };
    }

    if (input.reason !== undefined) {
      throw badInput_('批次改欄位的端點（POST /tickets/batch/fields）不收 reason，本機拒絕以免你以為原因已記入歷程。' +
        '只有 field=targetVersion / foundVersion 的版本端點接受 reason。',
        { param: 'reason', field: field });
    }
    const fields = {};
    fields[field] = value;
    return { action: 'batchSetField', params: { tickets: input.tickets, fields: fields } };
  }
};

// ── replyFeedback：client 端複合（先可選流轉、再留言）──
//
// 舊 GAS 後端就是這個順序的兩個獨立操作，沒有原子性也沒有 rollback。這裡照實做、照實回報：
//   1. 流轉失敗 → 留言「不送」，回流轉的原錯誤。
//   2. 留言失敗 → 明講「流轉已生效、留言沒送成」，附原錯誤與該步的冪等鍵，不編造 rollback。
//   3. 每一步各自一把由 base key 推導的穩定鍵：同樣的輸入永遠得到同樣的兩把鍵（重送可被 server 去重），
//      而兩把鍵互不相同（同一把 key 配不同 body 會被 server 判 idempotency_key_reused）。
const REPLY_STEP_TRANSITION = 'transition';
const REPLY_STEP_COMMENT = 'comment';

// 由 base key 推導每一步的冪等鍵：sha256 → base64url（字元集正好是 [A-Za-z0-9_-]），取 43 字元（符合 16-64）。
// 必須是純函式：重試時要能推出「同一把」鍵，才輪得到 server 去重。
function stepKey_(baseKey, step) {
  return crypto.createHash('sha256')
    .update('litejira.replyFeedback/' + String(baseKey) + '/' + step)
    .digest('base64url')
    .slice(0, 43);
}

// idempotency_key_reused（409）有兩種成因，後端放在 error.details.reason，兩者的善後完全不同：
//   in_progress      → 同一把 key 的「前一次請求還在跑」。這一步有沒有生效無法從這個回應判斷 = unknown。
//   request_mismatch → 同一把 key 之前配過別的內容。這一份內容確定沒被受理（no），
//                      但「前一次用這把 key 的操作」結果並沒有被證明，不能當成整體無副作用。
// 其餘（後端沒給 reason / 給了沒見過的值）一律當成最保守的 unknown。
function reuseReason_(err) {
  if (err.code !== 'idempotency_key_reused') return null;
  const details = err.details;
  const reason = details !== null && typeof details === 'object' ? details.reason : undefined;
  if (reason === 'in_progress' || reason === 'request_mismatch') return reason;
  return 'unspecified';
}

// 單步呼叫：不拋例外，把成敗一律轉成結構化結果，好讓後續步驟決定要不要繼續、以及怎麼回報。
async function replyStep_(step, action, params, cfg, fetchImpl, key) {
  try {
    const result = await callV1({
      fetch: fetchImpl || globalThis.fetch,
      baseUrl: cfg.apiUrl,
      token: cfg.token,
      action: action,
      params: params,
      idempotencyKey: key
    });
    return { ok: true, step: step, idempotencyKey: key, status: result.status, data: result.data };
  } catch (err) {
    if (err instanceof LiteJiraApiError) {
      const reuse = reuseReason_(err);
      const out = {
        ok: false, step: step, idempotencyKey: key, kind: 'api',
        // 5xx 是「伺服器自己壞了」，這一步到底有沒有生效無法從回應判斷；4xx 才是明確的拒絕。
        applied: err.status >= 500 ? 'unknown' : 'no',
        error: { code: err.code, message: err.message, status: err.status, details: err.details }
      };
      if (reuse !== null) {
        out.idempotencyReuse = reuse;
        // request_mismatch：這份內容確定沒生效，但同一把 key 的前一次操作結果未知，要單獨標出來。
        out.applied = reuse === 'request_mismatch' ? 'no' : 'unknown';
        out.priorAttemptApplied = 'unknown';
      }
      return out;
    }
    if (err instanceof LiteJiraTransportError) {
      // 本機就擋下來的（invalid_argument 等）＝一發都沒送出；連線層失敗（timeout / network）則結果不明。
      const sent = err.code === 'timeout' || err.code === 'network_error' || err.code === 'invalid_response';
      return {
        ok: false, step: step, idempotencyKey: key, kind: 'transport',
        applied: sent ? 'unknown' : 'no',
        error: { code: err.code, message: err.message, details: err.details }
      };
    }
    throw err;
  }
}

function replyTransitionParams_(input) {
  const t = input.transition;
  if (typeof t !== 'object' || t === null || Array.isArray(t)) {
    throw badInput_('transition 必須是物件：{ action, reason?, fields? }', { param: 'transition' });
  }
  const allowed = ['action', 'reason', 'fields'];
  Object.keys(t).forEach(function (key) {
    if (allowed.indexOf(key) !== -1) return;
    if (key === 'toStatus' || key === 'status') {
      throw badInput_('transition.' + key + ' 不適用 v1：流轉只收動作標籤 action（見 litejira.getTransitions 的 data.actions[]）；' +
        '目標狀態名是後端內部白名單，不對外接受。', { param: 'transition.' + key });
    }
    throw badInput_('transition 不認得的鍵：' + key + '（只收 action / reason / fields）', { param: 'transition.' + key });
  });
  if (typeof t.action !== 'string' || t.action.trim() === '') {
    throw badInput_('transition.action 必須是非空的動作標籤字串', { param: 'transition.action' });
  }
  return {
    ticketId: input.ticketId,
    action: t.action,
    reason: t.reason,
    fields: t.fields,
    expectedUpdatedAt: input.expectedUpdatedAt
  };
}

async function replyFeedback_(input, cfg, fetchImpl) {
  if (!(fetchImpl || globalThis.fetch)) {
    throw mcpError_('CONFIG_ERROR', 'fetch is required; use Node 18+ or pass fetchImpl');
  }
  const hasTransition = input.transition !== undefined;
  if (!hasTransition && input.expectedUpdatedAt !== undefined) {
    // 留言端點沒有樂觀鎖，這個值無處可送。收下不用＝呼叫端以為「有人幫我擋住並行修改」。
    throw badInput_('沒有 transition 時不接受 expectedUpdatedAt：留言端點不做樂觀鎖（新增留言不會改動工單版本），' +
      '這個值會無處可送。要做樂觀鎖請一併給 transition，或改用 litejira.addComment。',
      { param: 'expectedUpdatedAt' });
  }

  const baseKey = input.idempotencyKey;
  const steps = [];

  if (hasTransition) {
    const params = replyTransitionParams_(input);
    const key = stepKey_(baseKey, REPLY_STEP_TRANSITION);
    const first = await replyStep_(REPLY_STEP_TRANSITION, 'transitionTicket', params, cfg, fetchImpl, key);
    if (!first.ok) {
      // 第一步就失敗：留言「沒有送出」，這點要講死，免得呼叫端以為留言已經在工單上。
      return replyErrorResult_(first, [], '流轉失敗，留言未送出（步驟順序是先流轉再留言）。');
    }
    steps.push(publicStep_(first));
  }

  const commentKey = stepKey_(baseKey, REPLY_STEP_COMMENT);
  const second = await replyStep_(REPLY_STEP_COMMENT, 'addComment',
    { ticketId: input.ticketId, body: input.content }, cfg, fetchImpl, commentKey);
  if (!second.ok) {
    const note = hasTransition
      ? '流轉已經生效，但未取得留言成功回應；留言是否生效請依下方結果判讀，先前流轉不會因此回滾。'
      : '未取得留言成功回應（本次沒有流轉步驟）；是否生效請依下方結果判讀。';
    return replyErrorResult_(second, steps, note);
  }
  steps.push(publicStep_(second));

  const payload = {
    ok: true,
    ticket: input.ticketId,
    atomic: false,
    steps: steps
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload
  };
}

function publicStep_(step) {
  return { step: step.step, ok: true, status: step.status, idempotencyKey: step.idempotencyKey, data: step.data };
}

// 善後指示。刻意不承諾「同一把 key 永遠可以安全重放」：
// 伺服器的冪等紀錄只保留 24 小時，過期後同一把 key 會被當成全新請求真的再做一次。
function replyRecovery_(failed) {
  if (failed.idempotencyReuse === 'request_mismatch') {
    return '伺服器回報「同一把 idempotencyKey 先前配過不同的內容」：這一次送的內容被拒絕（沒有受理），' +
      '但「前一次用這把 key 的操作」是否已生效並沒有被證明，不能當成什麼都沒發生。' +
      '請不要重複送同一份被拒的內容，也不要換一把新 key 把整個複合呼叫重跑一遍' +
      '（先前的流轉可能已經生效，重跑會做第二次）。' +
      '先讀工單當前狀態、確認哪些步驟已經完成，再針對確實還沒做的那一步，用正確的參數單獨續做。';
  }
  if (failed.idempotencyReuse !== undefined) {
    // in_progress（以及後端沒指明 reason 的情況）：前一次同 key 的請求還在跑，這一步的結果未知。
    return '伺服器回報「同一把 idempotencyKey 的前一次請求還在處理中」：這一步是否已生效目前未知。' +
      '不要換一把新 key，也不要改動輸入（換 key 會真的再做一次，改內容會被判 request_mismatch）。' +
      '請先讀工單當前狀態；若要重送，必須用「完全相同的輸入＋同一把 key」，' +
      '且要在伺服器的 24 小時冪等保留期內 —— 保留期過後不要盲目重送。';
  }
  if (failed.applied === 'unknown') {
    return '這一步的結果「不確定」（請求可能已送達）：不要自動重試。' +
      '請先讀工單當前狀態確認這一步到底有沒有生效；若要重送，請在伺服器的 24 小時冪等保留期內，' +
      '用「同一把 idempotencyKey」加上完全相同的輸入 —— 去重只在保留期內成立，過期後重送會真的再做一次。';
  }
  return '這一步「沒有生效」（伺服器明確拒絕，該步已回復原狀）：修正後可重送，沿用同一把 idempotencyKey。' +
    '若必須改動內容，請保留「已完成」清單上的步驟，只補真正還沒做的那一步，不要換新 key 把整個呼叫重跑一遍。';
}

// 失敗（含部分成功）的回報。完成的步驟一律列出來，錯誤原文照抄，不重新編碼。
function replyErrorResult_(failed, completed, note) {
  const outcome = replyRecovery_(failed);
  const partial = {
    ok: false,
    atomic: false,
    completed: completed.map(function (s) { return s.step; }),
    failedStep: failed.step,
    failedStepApplied: failed.applied,
    steps: completed
  };
  if (failed.idempotencyReuse !== undefined) {
    partial.idempotencyReuse = failed.idempotencyReuse;
    // 「這份內容沒生效」不等於「這把 key 從沒做成過任何事」，兩件事分開講。
    partial.priorAttemptApplied = failed.priorAttemptApplied;
  }
  const payload = { error: failed.error, partial: partial };
  const lines = [
    '[' + failed.error.code + '] ' + failed.error.message,
    failed.error.details !== undefined ? 'details: ' + JSON.stringify(failed.error.details) : '',
    '',
    '⚠️ 步驟「' + failed.step + '」失敗。' + note,
    completed.length
      ? '已完成：' + completed.map(function (s) { return s.step; }).join('、') + '（不會被還原）'
      : '已完成：無',
    outcome
  ].filter(function (line) { return line !== ''; });
  return {
    isError: true,
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: payload
  };
}

// ── GH-317：附件取檔 URL 與二進位上傳 ──────────────────────────────────────
//
// 兩個認證途徑講死，因為「這條連結能不能貼給人」完全取決於它：
//   web  → 瀏覽器既有登入態（session cookie）。URL 本身不含任何憑證，可以貼給人開。
//   api  → Authorization: Bearer <PAT>。URL 本身一樣不含 PAT，但少了 header 就打不開，
//          所以它不是「點一下就好」的連結，貼給人只會得到 401。
// 兩條都由設定的 base URL 推導，沿用 normalizeBaseUrl 的 origin 規則（https 或明確 loopback）。
const ATTACHMENT_AUTH = Object.freeze({
  web: 'browser-session：用你已登入 LiteJira 的瀏覽器開啟即可；URL 內不含 PAT，可以貼給人。',
  api: 'bearer-pat：必須自行帶 Authorization: Bearer <你的 PAT> 這個 header；' +
    'URL 內不含 PAT，所以直接貼給人或貼進瀏覽器只會拿到 401。回應是二進位內容，也可能是導向舊儲存體的 302。'
});

// 副檔名 → MIME。刻意只列常見且不會猜錯的幾種；推不出來一律 application/octet-stream，
// 不去讀檔頭做魔數判斷（猜錯 MIME 會讓瀏覽器用錯的方式渲染附件）。
const MIME_BY_EXT = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.log': 'text/plain',
  '.json': 'application/json', '.xml': 'application/xml', '.html': 'text/html',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.7z': 'application/x-7z-compressed',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.har': 'application/json', '.patch': 'text/x-diff', '.diff': 'text/x-diff'
});
const DEFAULT_UPLOAD_MIME = 'application/octet-stream';

function guessMime_(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return Object.prototype.hasOwnProperty.call(MIME_BY_EXT, ext) ? MIME_BY_EXT[ext] : DEFAULT_UPLOAD_MIME;
}

// 單筆附件 → 原欄位 + links。原物件的每一個鍵都原樣保留（含 legacy 的 url），
// 只**新增** links 這一個鍵：改名或丟棄舊欄位會讓既有的呼叫端無聲地壞掉。
function enrichAttachment_(item, cfg) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const out = Object.assign({}, item);
  const legacy = typeof item.url === 'string' && item.url !== '' ? item.url : null;
  const id = typeof item.id === 'string' && item.id !== '' ? item.id : null;
  if (id === null) {
    // 沒有 id 就組不出取檔 URL。回 null ＋ 講明原因，不回一條猜出來的路徑
    //（猜錯的 URL 會讓呼叫端拿到 404 還以為是權限問題）。
    out.links = { legacy: legacy, web: null, api: null,
      unavailable: '這筆附件沒有 id，無法組出取檔 URL（只剩 links.legacy 可用）' };
    return out;
  }
  const urls = attachmentContentUrls(cfg.apiUrl, id);
  out.links = {
    legacy: legacy,
    web: urls.web,
    webAuth: ATTACHMENT_AUTH.web,
    api: urls.api,
    apiAuth: ATTACHMENT_AUTH.api,
    apiContract: ATTACHMENT_DOWNLOAD_CONTRACT
  };
  return out;
}

// 上傳端點的自述：給「想自己打 HTTP 而不是用本工具」的呼叫端。
// headers 只描述**要放什麼**，PAT 的值永遠不在輸出裡。
function uploadDescriptor_(cfg, ticketRef) {
  // 用 buildUploadRequest 以外的路徑組 URL 會漂移；但它需要 token 與檔名，
  // 而這裡要的是「沒有檔名的樣板」，沿用正規化基底，保留子路徑部署前綴。
  const base = normalizeBaseUrl(cfg.apiUrl) +
    '/tickets/' + encodeURIComponent(String(ticketRef)) + '/attachments/upload';
  return {
    method: 'POST',
    contract: ATTACHMENT_UPLOAD_CONTRACT,
    url: base + '?name={ENCODED_FILENAME}',
    urlNote: 'name 是 URL-encode 後的檔名（encodeURIComponent），不是 multipart 的 field 名。',
    body: 'raw bytes：檔案原始位元組直接當 request body。沒有 multipart/form-data，也沒有 JSON / base64 信封。',
    headers: {
      Authorization: 'Bearer <你的 LiteJira PAT>（本工具不輸出 PAT 的值；請自行從環境取得）',
      'Content-Type': '檔案實際的 MIME（例 image/png）—— 不是 multipart/form-data',
      'Content-Length': '檔案位元組數（若走 chunked 串流可省略）',
      Accept: 'application/json'
    },
    forbiddenHeaders: {
      'Idempotency-Key': '不可帶：後端回 422（串流上傳無法在送出前算出請求指紋）'
    },
    tool: 'litejira.uploadAttachment',
    unknownOutcome: UPLOAD_UNKNOWN_OUTCOME
  };
}

// 列附件：讀 GET /tickets/{ticket}/attachments → 取 data.items[] → 加 links。
// ⚠️ **不走工單本體**：TicketDetail 契約上沒有附件欄（D-165），附件只有這一條專屬路由；
// 讀工單再挖 attachments[] 永遠只會拿到 undefined。
// 這條路由回完整集合、不分頁（每單上限個位數），所以沒有 cursor / nextCursor 要轉述；
// 排序有決定性但不承諾是「使用者的順序」，呼叫端不該把位置當識別（識別用 id）。
async function getAttachments_(input, cfg, fetchImpl) {
  const outcome = await callV1Or_('listAttachments', { ticket: input.ticketId }, cfg, fetchImpl);
  if (outcome.isError) return outcome;
  const data = outcome.value;
  const raw = data && typeof data === 'object' ? data.items : undefined;
  const payload = {
    ok: true,
    ticket: input.ticketId,
    paginated: false,
    orderNote: '排序有決定性，但不是「使用者的順序」：附件不是有序清單，請以 id 指名單筆。',
    download: {
      api: { method: 'GET', contract: ATTACHMENT_DOWNLOAD_CONTRACT, auth: ATTACHMENT_AUTH.api },
      web: { method: 'GET', contract: 'GET /api/web/attachments/{attachmentId}/content', auth: ATTACHMENT_AUTH.web },
      note: '本 server 不代為下載附件內容：它不會把二進位塞進 JSON，也不會帶著 Bearer 跟隨 redirect。' +
        '請用上面的 URL 自行取檔。'
    },
    upload: uploadDescriptor_(cfg, input.ticketId)
  };
  if (Array.isArray(raw)) {
    payload.count = raw.length;
    payload.attachments = raw.map(function (item) { return enrichAttachment_(item, cfg); });
  } else {
    // 回應裡沒有 items 這個陣列：不能回一個空陣列假裝「這張單沒有附件」——
    // 「沒有附件」與「這份回應根本沒講附件」是兩件事，後者要講出來。
    payload.count = null;
    payload.attachments = null;
    payload.unavailable = 'GET /tickets/{ticket}/attachments 的回應中沒有 items 陣列' +
      '（不等於「沒有附件」）；請確認後端版本是否有這條路由。';
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload
  };
}

// 上傳：本機檔案守門在傳輸層（普通檔案 / 非空 / 不超過上限），這裡只做三件事 ——
// 把 URL 當 filePath 的情況擋下、補檔名與 MIME 的預設值、把結果與善後指示講清楚。
async function uploadAttachmentTool_(input, cfg, fetchImpl) {
  const filePath = input.filePath;
  // 「給一條網址就幫我抓下來上傳」是明確拒絕的能力：那等於讓呼叫端用這台 server 的網路
  // 去取任意外部資源（SSRF），而且抓回來的東西沒有人看過。
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(filePath.trim())) {
    throw badInput_('filePath 必須是本機檔案路徑，不是 URL：本工具不會去下載任何遠端內容。' +
      '要附加外部連結請用 litejira.attachLink；要上傳遠端檔案請自行下載到本機後再給路徑。',
      { param: 'filePath' });
  }
  const resolved = path.resolve(filePath);
  const name = input.name !== undefined ? input.name : path.basename(resolved);
  const contentType = input.contentType !== undefined ? input.contentType : guessMime_(name);
  const maxBytes = input.maxBytes !== undefined ? input.maxBytes : cfg.maxUploadBytes;

  let result;
  try {
    result = await uploadAttachment({
      fetch: fetchImpl || globalThis.fetch,
      baseUrl: cfg.apiUrl,
      token: cfg.token,
      ticket: input.ticketId,
      filePath: resolved,
      name: name,
      contentType: contentType,
      maxBytes: maxBytes,
      timeoutMs: input.timeoutMs === undefined ? 300000 : input.timeoutMs
    });
  } catch (err) {
    if (err instanceof LiteJiraApiError && err.status < 500) return apiErrorResult_(err);
    if (err instanceof LiteJiraTransportError || err instanceof LiteJiraApiError) {
      // 5xx 也可能發生在檔案已保存之後，必須先對帳，不能宣稱沒有生效。
      // 前者檔案可能已經在伺服器上了，盲目重送會留下兩筆。
      const unknown = err instanceof LiteJiraApiError || err.code === 'timeout' || err.code === 'network_error' || err.code === 'invalid_response';
      const payload = {
        error: { code: err.code, message: err.message, details: err.details },
        uploaded: unknown ? 'unknown' : 'no',
        recovery: unknown
          ? UPLOAD_UNKNOWN_OUTCOME + '（對帳請用 litejira.getAttachments ticketId=' + input.ticketId + '）'
          : '這次上傳「沒有送出 / 沒有生效」（本機或伺服器明確拒絕）：修正後可直接重試。'
      };
      return {
        isError: true,
        content: [{ type: 'text', text: '[' + err.code + '] ' + err.message + '\n\n⚠️ ' + payload.recovery }],
        structuredContent: payload
      };
    }
    throw err;
  }

  // 回應只帶「檔案的身分」與伺服器回的 data，絕不回傳內容本身。
  // 後端 201 的 data 就是**新建的那一筆附件**（與清單同一個投影），所以這裡與 getAttachments
  // 走同一個 enrich：呼叫端上傳完可以直接拿到取檔 URL，不必再列一次附件。
  // 原欄位一個不動（enrichAttachment_ 只新增 links），非物件（理論上不會發生）則原樣帶出。
  const payload = {
    ok: true,
    status: result.status,
    ticket: input.ticketId,
    name: name,
    contentType: contentType,
    bytes: result.size,
    filePath: resolved,
    idempotencyKey: null,
    idempotencyNote: '此端點不接受 Idempotency-Key（後端回 422）；重送＝真的再上傳一次。',
    data: enrichAttachment_(result.data, cfg)
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload
  };
}

// 共用的 v1 呼叫 + 錯誤轉譯。回 { value } 或 MCP 的 isError 結果。
// idempotencyKey 只有寫入路由會用到；讀取路由給了也不會掛上去（傳輸層決定）。
async function callV1Or_(action, params, cfg, fetchImpl, idempotencyKey) {
  const ticketLinkWrite = action === 'addTicketLink' || action === 'removeTicketLink';
  const fetchFn = fetchImpl || globalThis.fetch;
  if (!fetchFn) throw mcpError_('CONFIG_ERROR', 'fetch is required; use Node 18+ or pass fetchImpl');
  let result;
  try {
    result = await callV1({
      fetch: fetchFn,
      baseUrl: cfg.apiUrl,
      token: cfg.token,
      action: action,
      params: params,
      idempotencyKey: idempotencyKey
    });
  } catch (err) {
    if (err instanceof LiteJiraApiError) {
      if (ticketLinkWrite && err.status >= 500) {
        throw mcpError_('write_outcome_unknown', '工單連結寫入結果未知；先用 listTicketLinks 回讀確認，若需重試，僅能在24小時內使用原idempotencyKey與完全相同輸入。', { cause: err.code }, -32000);
      }
      // 後端裁決：code / message / details 原樣轉出，不重新編碼、不映射回舊的四種代碼。
      return apiErrorResult_(err);
    }
    if (err instanceof LiteJiraTransportError) {
      if (ticketLinkWrite && ['timeout', 'network_error', 'invalid_response', 'aborted'].includes(err.code)) {
        throw mcpError_('write_outcome_unknown', '工單連結寫入結果未知；先用 listTicketLinks 回讀確認，若需重試，僅能在24小時內使用原idempotencyKey與完全相同輸入。', { cause: err.code }, -32000);
      }
      // 本機拒絕 / 連線層失敗：code 與 API 錯誤碼刻意不同名，呼叫端一看就知道沒到後端。
      throw mcpError_(err.code, err.message, err.details, -32000);
    }
    throw err;
  }
  return { value: result.data, noContent: !!result.noContent, status: result.status };
}

// 業務錯誤 → isError 結果。details 一併帶出（structuredContent 讓主機拿得到結構化原文）。
function apiErrorResult_(err) {
  const hint = errorHintFor_(err.code);
  const payload = { code: err.code, message: err.message, status: err.status };
  if (err.details !== undefined) payload.details = err.details;
  return {
    isError: true,
    content: [{
      type: 'text',
      text: '[' + err.code + '] ' + err.message +
        (err.details !== undefined ? '\ndetails: ' + JSON.stringify(err.details) : '') +
        (hint ? '\n\n💡 ' + hint : '')
    }],
    structuredContent: { error: payload }
  };
}

function validateToolInput(def, args) {
  const schema = def.inputSchema;
  const removed = def.removedParams || {};
  // GH-257 第四包：不只參數「名」會改，參數「值」也會（例：field='verifyMethod' → 'validationMethod'）。
  // 讓它撞 enum 只會回一句籠統的型別錯誤，呼叫端不知道新名字叫什麼，只好亂猜。
  const legacyValues = def.legacyValues || {};
  const out = {};
  const errors = [];
  Object.keys(args || {}).forEach((key) => {
    if (legacyValues[key] && typeof args[key] === 'string' &&
      Object.prototype.hasOwnProperty.call(legacyValues[key], args[key])) {
      errors.push(key + '=' + args[key] + ' 在 API v1 已不適用：' + legacyValues[key][args[key]]);
      return;
    }
    if (!schema.properties[key]) {
      // GH-257：已移除的舊參數要指路，不能只回一句 unknown，更不能默默吃掉。
      if (Object.prototype.hasOwnProperty.call(removed, key)) {
        errors.push('parameter removed in API v1: ' + key + ' — ' + removed[key]);
        return;
      }
      errors.push('unknown parameter: ' + key);
      return;
    }
    const value = args[key];
    if (!matchesSchema_(value, schema.properties[key])) {
      errors.push('invalid parameter type: ' + key);
      return;
    }
    out[key] = value;
  });
  (schema.required || []).forEach((key) => {
    if (out[key] === undefined || out[key] === '') errors.push('missing required parameter: ' + key);
  });
  if (errors.length) throw mcpError_('VALIDATION_FAILED', errors.join('; '), { errors }, -32602);
  return out;
}

async function handleJsonRpcRequest(request, config, fetchImpl) {
  if (!request || request.jsonrpc !== '2.0') {
    return jsonRpcError_(request && request.id, -32600, 'invalid JSON-RPC request');
  }
  try {
    if (request.method === 'initialize') {
      const clientVersion = (request.params && request.params.protocolVersion) || '2024-11-05';
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: clientVersion,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false }
          },
          serverInfo: { name: 'litejira-mcp', version: PKG_VERSION },
          // GH-265：啟動指令只保留操作安全規則，歷史背景留在規格文件，避免每個 session 重複載入。
          // GH-257 第四包：18 個工具全部接線，原本的「未接線」那一行退場（留著會讓助手不敢用已經可用的工具）；
          // 換上單欄更新的分流、批次的部分成功，以及 replyFeedback 非原子這三件會影響操作決策的事。
          instructions: [
            'LiteJira MCP v1：',
            '- 寫入必帶 idempotencyKey；去重限 24 小時內＋輸入相同：結果不明先讀狀態，' +
              '同 key 原輸入重送；換 key 或過期才重做。',
            '- 建單填齊 reproSteps／expectedResult／日期／tags／ownerId 等正式欄位，別塞進 description。',
            // GH-313：reason 必填是三選一命中即算（direction=back／label=main不受影響／
            // requiresReason=true），第三項為 false 不代表可省略前兩項。
            '- 改狀態走 transitionTicket：先 getTransitions 取 data.actions[].label' +
              '（退回／main不受影響／requiresReason=true 任一必填 reason）。',
            '- updateField 單欄：status 要 force=true（限管理者），assigneeId 要 reason，版本／父工單收 UUID。',
            '- batch 收 tickets（1-100）；回 succeeded/failed，200 非全成功，務必回報 failed。',
            '- replyFeedback 非原子：先流轉再留言，各一把衍生鍵；失敗如實回報部分成功。',
            // GH-317：只留會改變操作決策的兩件（URL 可不可以貼給人、上傳不能重試），
            // 欄位與認證細節在兩個工具的 schema 裡——預算不因新功能而放寬，其餘行同步壓縮。
            '- 附件：getAttachments 的 links.web 可貼給人、links.api 需 Bearer；' +
              '上傳無冪等鍵，先對帳不重送。',
            '- expectedUpdatedAt 原樣回填 ISO 字串，別轉毫秒（會撞假衝突）。',
            '- 工單參照可用 UUID／BUG-481／數字 key；成員條件只收 UUID，先讀 litejira://members。',
            '- 讀 litejira://meta（受控值）／litejira://versions／litejira://workflow/{type}。',
            '- 專案層級資源取 LTJ_PROJECT 或 URI 的 ?project=KEY；無則報錯，不猜。',
            '- searchTickets 的 project 必填（同上），無「不帶＝全部」；' +
              '跨專案僅 mine=assignee|creator|watcher，此時不可帶一般篩選。',
            // GH-265 的 instructions 預算仍然成立（本行是換掉舊的「type/status 等可傳陣列多值」那一句，
            // 不是另開一行）：新增的能力只講「有哪些運算子」，細節在工具 schema 裡。
            '- 清單用 limit+cursor 分頁（上限 100）；各維度可多值＋XNot，' +
              'title/description 另有 XContains/XNotContains，還有 overdue、id（≤' + TICKET_ID_FILTER_MAX + '）。',
            '- activity 用 kind=user|system 過濾，不帶＝全部。'
          ].join('\n')
        }
      };
    }
    if (request.method === 'notifications/initialized' || request.method === 'initialized') {
      return null;
    }
    if (request.method === 'tools/list') {
      return { jsonrpc: '2.0', id: request.id, result: { tools: listTools() } };
    }
    if (request.method === 'tools/call') {
      const params = request.params || {};
      const result = await callTool(params.name, params.arguments || {}, config, fetchImpl);
      return { jsonrpc: '2.0', id: request.id, result };
    }
    // LJ-095 + LJ-116 批次 4：Resource handlers
    // resources/list 只回固定 URI（4 個）；templated URI 走 resources/templates/list
    if (request.method === 'resources/list') {
      return {
        jsonrpc: '2.0', id: request.id,
        result: {
          resources: RESOURCE_DEFS
            .filter(function(r) { return !!r.uri; })
            .map(function(r) {
              return {
                uri: r.uri,
                name: r.name,
                description: r.description,
                mimeType: 'application/json'
              };
            })
        }
      };
    }
    if (request.method === 'resources/templates/list') {
      return {
        jsonrpc: '2.0', id: request.id,
        result: {
          resourceTemplates: RESOURCE_DEFS
            .filter(function(r) { return !!r.uriTemplate; })
            .map(function(r) {
              return {
                uriTemplate: r.uriTemplate,
                name: r.name,
                description: r.description,
                mimeType: 'application/json'
              };
            })
        }
      };
    }
    if (request.method === 'resources/read') {
      const uri = (request.params || {}).uri || '';
      const result = await readResource_(uri, config, fetchImpl);
      return { jsonrpc: '2.0', id: request.id, result };
    }
    // LJ-095：Prompt handlers
    if (request.method === 'prompts/list') {
      return {
        jsonrpc: '2.0', id: request.id,
        result: { prompts: PROMPT_DEFS.map(function(p) { return { name: p.name, description: p.description, arguments: p.arguments }; }) }
      };
    }
    if (request.method === 'prompts/get') {
      const promptName = (request.params || {}).name || '';
      const promptDef = PROMPT_DEFS.find(function(p) { return p.name === promptName; });
      if (!promptDef) throw mcpError_('UNKNOWN_PROMPT', 'unknown prompt: ' + promptName, undefined, -32602);
      const promptArgs = (request.params || {}).arguments || {};
      // LJ-116 批次 3: 必填參數驗證（不再用佔位字串混過）
      const missingArgs = (promptDef.arguments || [])
        .filter(function(a) { return a.required && !promptArgs[a.name]; })
        .map(function(a) { return a.name; });
      if (missingArgs.length) {
        throw mcpError_('MISSING_PROMPT_ARGS',
          'missing required prompt args: ' + missingArgs.join(', '),
          { missing: missingArgs }, -32602);
      }
      return {
        jsonrpc: '2.0', id: request.id,
        result: { description: promptDef.description, messages: getPromptMessages_(promptName, promptArgs) }
      };
    }
    return jsonRpcError_(request.id, -32601, 'method not found');
  } catch (err) {
    return jsonRpcError_(request.id, err.jsonRpcCode || -32000, err.message || String(err), {
      code: err.code || 'MCP_ERROR',
      details: err.details
    });
  }
}

// LJ-116: 型別匹配增強 — 支援 integer / minimum / maximum / pattern 約束
function matchesSchema_(value, schema) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (value === null) return types.indexOf('null') !== -1;
  // LJ-178: array 型別必須先攔（typeof [] === 'object'，否則會被下方 jsType 檢查誤殺）
  // GH-257: 只有「值真的是陣列」時才走這條。多值參數是 ['string','array'] 聯集型別，
  // 舊寫法會在收到單一字串時直接 return false。非陣列的值往下走一般型別檢查即可
  // （陣列在型別不允許時仍會被擋掉：typeof [] === 'object' 不在任何白名單裡）。
  if (types.indexOf('array') !== -1 && Array.isArray(value)) {
    if (value.length === 0) return false;
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false;
    if (schema.items) {
      for (var i = 0; i < value.length; i++) {
        if (!matchesSchema_(value[i], schema.items)) return false;
      }
    }
    return true;
  }
  const jsType = typeof value;
  if (types.indexOf(jsType) === -1) {
    // integer 也走 number 路徑
    if (!(schema.type === 'integer' && jsType === 'number')) return false;
  }
  // integer 要整數
  if (schema.type === 'integer' && !Number.isInteger(value)) return false;
  // 數值範圍
  if (jsType === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return false;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return false;
  }
  // 字串約束（pattern / minLength / maxLength）
  if (jsType === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return false;
  }
  // LJ-116 批次 2: enum 檢查（適用任何型別）
  if (Array.isArray(schema.enum) && schema.enum.indexOf(value) === -1) return false;
  return true;
}

// LJ-116: schema 產生器 — short form ('string' / ['string','null']) 或 long form ({type, description, ...})
function schemaFor_(kind) {
  if (kind && typeof kind === 'object' && !Array.isArray(kind) && 'type' in kind) {
    // long form：原樣回傳（已含 description / minimum 等屬性）
    return kind;
  }
  if (Array.isArray(kind)) return { type: kind };
  return { type: kind };
}

// LJ-116 批次 3: jsonRpcCode 分流 — UNKNOWN_X / VALIDATION_FAILED 等走 -32602；其他預設 -32000
function mcpError_(code, message, details, jsonRpcCode) {
  const err = new Error(message);
  err.code = code;
  err.details = details;
  err.jsonRpcCode = jsonRpcCode || -32000;
  return err;
}

// GH-257：hint 表改對齊 API v1 的錯誤碼。
// 舊的四碼（AUTH_FAILED / UNKNOWN_ACTION / ADMIN_REQUIRED / ACTION_FAILED）在 v1 路徑上不會出現，
// 也刻意不做重映射 —— v1 把它們拆成語意更細的碼（例如 403 底下三種互斥情況），
// 硬塞回四碼會把資訊壓扁。未知的碼就不給 hint，訊息以 server 原文為準。
function errorHintFor_(code) {
  switch (code) {
    case 'unauthenticated':
      return 'PAT 失效或缺失。請檢查 ~/.litejira/credentials.env 內的 LTJ_API_TOKEN；需要新 PAT 請聯絡 admin。';
    case 'membership_required':
      return '你不是這個專案 / 工作區的成員，所以看不到這筆資料。請聯絡 admin 加入。';
    case 'permission_denied':
      return '你是成員，但這個操作的權限不足。請聯絡 admin 調整角色。';
    case 'admin_required':
      return '此操作僅限 admin。請聯絡 admin 代為處理。';
    case 'not_found':
      return '找不到目標。確認工單參照（UUID / 公開 key / 數字 key）與 project 是否正確；可用 litejira.searchTickets 反查。';
    case 'invalid_argument':
      return '參數不合契約。受控值請讀 litejira://meta，成員 UUID 讀 litejira://members，版本讀 litejira://versions，狀態流轉讀 litejira://workflow/{type}。';
    case 'rate_limited':
      return '呼叫過於頻繁。請降低頻率後重試；清單請改用 limit + cursor 分頁而非大量單筆查詢。';
    case 'version_conflict':
      return '資料在你讀取後被別人改過。請重新讀取最新內容再決定下一步。';
    case 'state_conflict':
      return '目標狀態與工單當前狀態不相容。請先呼叫 litejira.getTransitions 取當前實際可用的動作。';
    case 'internal':
      return '後端內部錯誤，與你的參數無關。稍後重試；持續發生請回報 admin 並附上時間點。';
    default:
      return '';
  }
}

function jsonRpcError_(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id: id === undefined ? null : id,
    error: { code, message, data }
  };
}

// ── Resource 讀取 ──
// GH-257：resource URI 現在可帶 query（?project=KEY 等）。先把 query 切開再比對定義，
// 否則 litejira://meta?project=X 會被當成未知資源。
function splitResourceUri_(uri) {
  var raw = String(uri || '');
  var q = raw.indexOf('?');
  if (q === -1) return { path: raw, search: new URLSearchParams() };
  return { path: raw.slice(0, q), search: new URLSearchParams(raw.slice(q + 1)) };
}

// 布林 query：只收字面 true / false。收到 "1" / "yes" 之類就報錯，不猜使用者的意思。
function parseBoolQuery_(key, value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw mcpError_('INVALID_RESOURCE_URI',
    'resource query「' + key + '」只接受 true 或 false（收到：' + value + '）', { param: key }, -32602);
}

function resourceParams_(def, parts, cfg) {
  var allow = def.query || [];
  var params = def.paramMap ? def.paramMap(parts.path) : {};
  parts.search.forEach(function (value, key) {
    if (allow.indexOf(key) === -1) {
      throw mcpError_('INVALID_RESOURCE_URI',
        'resource query「' + key + '」不適用於 ' + (def.uri || def.uriTemplate) +
        '（可用：' + (allow.length ? allow.join(', ') : '無') + '）',
        { param: key, allowed: allow.slice() }, -32602);
    }
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      throw mcpError_('INVALID_RESOURCE_URI',
        'resource 參數「' + key + '」重複指定；路徑與 query 不可互相覆蓋',
        { param: key }, -32602);
    }
    params[key] = key === 'activeOnly' ? parseBoolQuery_(key, value) : value;
  });

  if (def.needsProject && params.project === undefined) {
    // URI 沒指定就用啟動設定的 LTJ_PROJECT；兩者都沒有 → 明確報錯。
    // 絕不自動挑「第一個專案」：猜錯會安靜回別的專案的資料，比報錯危險得多。
    if (!cfg.project) {
      throw mcpError_('PROJECT_REQUIRED',
        '資源 ' + (def.uri || def.uriTemplate) + ' 需要指定專案。' +
        '請在 URI 帶 ?project=<KEY>，或在啟動環境設定 LTJ_PROJECT=<KEY>。' +
        '（不會自動選用任一專案。）',
        { resource: def.uri || def.uriTemplate }, -32602);
    }
    params.project = cfg.project;
  }
  return params;
}

async function readResource_(uri, config, fetchImpl) {
  var parts = splitResourceUri_(uri);
  // 比對固定 URI
  var def = RESOURCE_DEFS.find(function(r) { return r.uri === parts.path; });
  // 比對 URI template
  if (!def) {
    def = RESOURCE_DEFS.find(function(r) {
      if (!r.uriTemplate) return false;
      var pattern = r.uriTemplate.replace(/\{[^}]+\}/g, '[^/]*');
      return new RegExp('^' + pattern + '$').test(parts.path);
    });
  }
  if (!def) throw mcpError_('UNKNOWN_RESOURCE', 'unknown resource URI: ' + uri, undefined, -32602);
  var cfg = config || getConfigFromEnv();
  if (!cfg.apiUrl || !cfg.token) throw mcpError_('CONFIG_ERROR', MISSING_TOKEN_MESSAGE);

  var params = resourceParams_(def, parts, cfg);
  var outcome = await callV1Or_(def.action, params, cfg, fetchImpl);
  if (outcome.isError) {
    // resources/read 沒有 isError 通道，業務錯誤一律走 JSON-RPC error，code 維持後端原文。
    var apiErr = outcome.structuredContent.error;
    throw mcpError_(apiErr.code, apiErr.message, apiErr.details, -32000);
  }
  return {
    contents: [{
      uri: uri,
      mimeType: 'application/json',
      // GH-255：緊湊輸出（同 callTool，見該處註解）
      // v1 的 data 原樣輸出，不補預設值（|| {} 會把「合法的空陣列/空值」偽裝成物件）。
      text: JSON.stringify(outcome.value)
    }]
  };
}

// ── Prompt 訊息生成 ──
// GH-257 第四包：寫入工具已全數接上 v1，結尾語改講「寫入前的紀律」而不是「哪些還不能用」。
// 留著舊的「尚未接上」清單會讓助手改走繞路寫法（例如把欄位塞進留言），比沒有提示更糟。
const WRITE_NOTE =
  '注意：寫入需要伺服器啟用（LTJ_MCP_ENABLE_WRITES），且任何寫入前先把要送出的內容給我確認，並帶上 idempotencyKey。' +
  '改單一欄位用 litejira.updateField（改狀態除外：正常流轉一律走 litejira.transitionTicket 的動作標籤）；' +
  '多張一起處理用 batch 系列，它們回的是 succeeded / failed 兩份清單 —— 有 failed 就要如實講出來，不要當成全部成功。' +
  'litejira.replyFeedback 是「先流轉再留言」的兩步操作、沒有原子性，' +
  '中途失敗我要看到哪一步成了、哪一步沒成，不要幫我補一個不存在的「已全部完成」。';

// 專案子句：prompt 參數有給就明講，沒給就交代改用啟動設定。
function projectClause_(project) {
  return project
    ? '本次專案 key = ' + project + '，讀資源時帶 ?project=' + encodeURIComponent(project) + '。'
    : '專案未指定，資源直接讀（伺服器會套用啟動設定的 LTJ_PROJECT）；若回報缺 project 再問我要專案 key。';
}

function getPromptMessages_(name, args) {
  const project = args.project;
  const ticket = args.ticketId;
  switch (name) {
    case 'report-bug':
      return [{
        role: 'user',
        content: {
          type: 'text',
          text: '幫我準備一張 BUG 工單的內容。' + (args.title ? '標題：' + args.title + '。' : '') +
            projectClause_(project) +
            '請先讀 litejira://meta（類型/優先級/子類型/模塊受控值）、litejira://members（成員名冊，含 UUID id）、' +
            'litejira://versions（版本清單），一律採用讀回來的實際值，不要沿用記憶中的舊值域。' +
            '然後問我：標題、重現步驟、預期結果、優先級、發現版本。' +
            '先輸出一份建單草稿（欄位: 值），成員欄位請同時列出顯示名與 UUID id；我確認後再用 litejira.createTicket 建單。' +
            '重現步驟與預期結果請放在 reproSteps / expectedResult 這兩個獨立欄位（不要併進 description）；' +
            'module / subtype / releaseMethod / startDate / dueDate（YYYY-MM-DD）/ tags（字串陣列）/ mrUrl / ownerId / ' +
            'targetVersion / foundVersion 等欄位建單時就能一次填齊，不用建完再補；沒有值就傳 null 或整個省略。' +
            WRITE_NOTE
        }
      }];
    case 'weekly-status':
      return [{
        role: 'user',
        content: {
          type: 'text',
          text: '給我本週進度報告。' + projectClause_(project) +
            '先讀 litejira://dashboard 取統計數據（需要只看我自己的部分時改讀 litejira://dashboard?scope=me；' +
            'scope / targetVersion / role 三者互斥，一次只能帶一個）。' +
            '再用 litejira.searchTickets 查近期更新的工單（sort=updatedAt, order=desc），' +
            '結果超過一頁就把回應的 nextCursor 當 cursor 帶回去續查。' +
            '狀態與版本條件可傳陣列一次帶多個值。' +
            'searchTickets 一定要有專案範圍：帶 project（或靠啟動設定的 LTJ_PROJECT），' +
            '缺了會被擋下；「不帶就是全部」不存在，只有 mine=assignee|creator|watcher 能跨專案，' +
            '而跨專案時不能再帶任何其他篩選條件。' +
            '彙整：本週完成 / 進行中 / 新開 各 N 張，按目標版本分組列出重點。' +
            '工單請用公開 key（如 BUG-481）稱呼，需要精確參照時附上 UUID id。'
        }
      }];
    case 'triage-ticket':
      return [{
        role: 'user',
        content: {
          type: 'text',
          text: '幫我分類工單 ' + (ticket || '（請提供工單參照）') + '。' + projectClause_(project) +
            '先讀 litejira://ticket/' + (ticket || '{id}') + ' 取完整資料（參照可用 UUID、公開 key 或數字 key），' +
            '再讀 litejira://workflow/{type}（type 用該工單實際的類型）取合法狀態流轉，' +
            '讀 litejira://members 取成員名冊 —— 建議負責人時請一併給出該成員的 UUID id，' +
            '因為搜尋的 assigneeId / ownerId / creatorId 只收 UUID，不收顯示名。' +
            '產出建議：優先級、負責人（名稱 + UUID）、下一個狀態。' +
            WRITE_NOTE
        }
      }];
    case 'close-ticket':
      return [{
        role: 'user',
        content: {
          type: 'text',
          text: '幫我確認工單 ' + (ticket || '（請提供工單參照）') + ' 要怎麼收尾。' +
            '先讀 litejira://ticket/' + (ticket || '{id}') + ' 取現況，' +
            '再呼叫 litejira.getTransitions（ticketId=' + (ticket || '{id}') + '）取當前實際可用的動作，' +
            '以回應中 data.actions[] 的 label 為準；同一份回應裡的 transitions 是目標狀態白名單，不是動作名稱，別混用。' +
            '若一步到不了結案狀態，請列出完整的中間步驟順序讓我確認；我同意後再用 litejira.transitionTicket 一步一步執行，' +
            '每一步都重新呼叫 getTransitions 取當下可用的動作標籤與各動作的 requiresReason' +
            '（reason 必填＝退回類動作／「main不受影響」／requiresReason=true 三者之一命中即算）。' +
            WRITE_NOTE
        }
      }];
    default:
      return [{ role: 'user', content: { type: 'text', text: name } }];
  }
}

function startStdioServer() {
  // 啟動時就把「寫入開關被打錯字」講出來（走 stderr，stdout 是 MCP 協定通道）。
  const startupWrites = resolveSettings(process.env);
  // 直接被啟動（沒走 launcher）時，站台的遷移 / 疑慮同樣要講出來。
  if (startupWrites.migratedFromLegacy) {
    process.stderr.write(
      'ℹ️  LTJ_API_URL 是已退役的舊正式站網址（' + startupWrites.legacyApiUrl + '），' +
      '本次連線改用 ' + startupWrites.apiUrl + '；請執行 `litejira-mcp setup` 永久更新設定。\n'
    );
  }
  if (startupWrites.isUnknownLegacyGas) {
    process.stderr.write(
      '⚠️  LTJ_API_URL 仍指向 Apps Script（GAS）網址：' + startupWrites.apiUrl + '，' +
      '不是我們認得的舊正式站部署，故不自動遷移。請確認該站台是否仍在服務，或改用 ' + OFFICIAL_API_URL + '。\n'
    );
  }
  if (startupWrites.enableWritesInvalid) {
    process.stderr.write(
      '⚠️  LTJ_MCP_ENABLE_WRITES=「' + startupWrites.enableWritesRaw + '」不是 true/false，' +
      '本次以唯讀模式啟動（fail closed）。\n'
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  rl.on('line', async (line) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      process.stdout.write(JSON.stringify(jsonRpcError_(null, -32700, 'parse error')) + '\n');
      return;
    }
    // LJ-116 批次 4 (M6): JSON-RPC 2.0 batch 支援
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        process.stdout.write(JSON.stringify(jsonRpcError_(null, -32600, 'empty batch')) + '\n');
        return;
      }
      const responses = await Promise.all(parsed.map((r) => handleJsonRpcRequest(r)));
      const filtered = responses.filter((r) => r !== null);
      if (filtered.length) process.stdout.write(JSON.stringify(filtered) + '\n');
      return;
    }
    const response = await handleJsonRpcRequest(parsed);
    if (response === null) return;
    process.stdout.write(JSON.stringify(response) + '\n');
  });
}

module.exports = {
  callTool,
  getConfigFromEnv,
  handleJsonRpcRequest,
  listTools,
  validateToolInput
};

if (require.main === module) {
  startStdioServer();
}
