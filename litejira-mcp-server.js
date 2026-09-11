#!/usr/bin/env node

const readline = require('readline');

// GH-257 第二包：讀取路徑（4 個 read tools + 6 個 resources）改走對外 API v1。
// 舊的 postLiteJiraApi（單一 POST + body token）在本檔案已完全不再使用：
// 尚未取得 v1 契約的 14 個寫入工具一律本機拒絕，不會退回舊後端。
const {
  callV1,
  ACTIVITY_KIND_VALUES,
  LiteJiraApiError,
  LiteJiraTransportError,
  ORDER_VALUES,
  SORT_VALUES
} = require('./litejira-v1-transport');

// LJ-160 #2：版本號單一事實源 = package.json，避免手寫在多處漂移。
const PKG_VERSION = require('./package.json').version;        // 例 "2.3.0"

// GH-257：v1 的工單參照可以是 UUID、字母 key（BUG-481）或純數字 key，三者都直接進路徑。
// 舊版只認固定前綴的 PREFIX-NNN，會把 v1 主鍵 UUID 擋在門外，故放寬。
// 前綴不再寫死白名單：v1 的 key 命名空間由 server 決定，客戶端硬編前綴只會在新增類型時誤擋。
// 這裡只擋「三種形狀都不是」的自由字串，不讓它送出去碰運氣；不存在的 key 由後端回 not_found。
const TICKET_REF_PATTERN =
  '^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[A-Za-z]+-\\d+|\\d+)$';
// 寫入工具（本包未升級）仍沿用舊的 PREFIX-NNN 形狀說明，但它們在 callTool 就被擋下。
const TICKET_ID_PATTERN = '^(FB|BUG|REQ|EPIC|IDEA|TASK|STD)-\\d+$';

// LJ-116 批次 2: enum 常數（基於 webapp/Code.js:38-40 + UPDATE_FIELD_WHITELIST 2289-2299 事實依據）
const ENUM_TYPES = ['EPIC', 'REQ', 'BUG', 'IDEA', 'TASK', 'STD'];
const ENUM_CONVERTIBLE_TYPES = ['EPIC', 'REQ', 'BUG', 'IDEA', 'TASK']; // STD 不可轉
const ENUM_PRIORITIES = ['P0-緊急', 'P1-高', 'P2-中', 'P3-低']; // 含中文後綴
// GH-257：order / sort 值域改以傳輸層契約表為單一事實源，避免兩處漂移。
// v1 的 sort 只有 updatedAt / createdAt / key —— 舊的 priority / dueDate 不在契約內。
const ENUM_ORDER = ORDER_VALUES.slice();
const ENUM_SORT = SORT_VALUES.slice();
// LJ-184：發布方式 enum（對齊 webapp/Code.js UPDATE_FIELD_WHITELIST + transitionTicket 送測守衛）
const ENUM_RELEASE_METHOD = ['待定', '熱更', '換包', '停服'];
// LJ-184：createTicket / updateField 共用的 releaseMethod 參數 schema（集中維護，避免兩處漂移）
const P_RELEASE_METHOD = {
  type: 'string',
  description: '發布方式（熱更=能上現役熱修線含純後端修復／換包=需重新打包發版／停服=需停機維護），送測必填非待定',
  enum: ENUM_RELEASE_METHOD
};
const ENUM_UPDATE_FIELDS = [
  'title', 'priority', 'version', 'dueDate', 'startDate',
  'description', 'notes', 'subtype', 'tags', 'mrUrl',
  'reproSteps', 'expectedResult', 'verifyMethod', 'fixMethod',
  'verifiableVersionAlpha', 'verifiableVersionRelease', 'foundVersion', 'module', 'parentId',
  'stdLevel2', 'stdLevel3',
  'releaseMethod', // LJ-184 發布方式（待定/熱更/換包/停服）
  'status', 'assignee',
  'owner' // GH-242 負責人（最終負責人，固定，可空；null 清空）
];

// LJ-116: 常用參數 schema（給多個工具引用，集中維護）
const P_TICKET_ID = { type: 'string', description: 'Ticket ID with prefix (FB/BUG/REQ/EPIC/IDEA/TASK/STD)-NNN，例如 BUG-481 / REQ-205。注意：LJ/DEV 是 LiteJira 自身開發編號（住 BACKLOG.md），非試算表工單，不接受。', pattern: TICKET_ID_PATTERN };
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
// GH-257：多值查詢條件 —— 單值傳字串，多值傳字串陣列（送出時展開成重複 query，不做逗號串接）。
const P_MULTI = (description) => ({
  type: ['string', 'array'],
  description: description + '（單值傳字串，多值傳字串陣列）',
  items: { type: 'string' }
});
const P_LIMIT = { type: 'integer', description: 'Max results (1-100，客戶端上限). 超過上限請改用 cursor 分頁。', minimum: 1, maximum: 100 };
const P_CURSOR = { type: 'string', description: '分頁 cursor（從前一次回應的 nextCursor 帶入）' };
const P_ORDER = { type: 'string', description: 'Sort order：asc 或 desc', enum: ENUM_ORDER };
const P_IDEMPOTENCY = {
  type: 'string',
  description: 'Idempotency key（16-64 字元 alphanumeric / _ / -），retry 同語意操作請傳同一個 key。注意：server 端未真正去重，純 client 契約紀律。',
  minLength: 16,
  maxLength: 64,
  pattern: '^[a-zA-Z0-9_-]{16,64}$'
};
const P_EXPECTED_UPDATED_AT = { type: 'number', description: '樂觀鎖：上一次讀到的 updatedAt（ms timestamp），用於偵測併寫衝突' };
// LJ-178：批量工具共用 — 工單 ID 陣列（1-100 張，逐張走與單張相同的後端路徑）
const P_IDS = {
  type: 'array',
  description: '工單 ID 陣列（1-100 張，皆 PREFIX-NNN）。一發呼叫由伺服器內部迴圈處理全部，取代逐張單獨呼叫。',
  items: { type: 'string', pattern: TICKET_ID_PATTERN },
  minItems: 1,
  maxItems: 100
};
// LJ-178：批量改欄位白名單（對齊後端 batchSetField，status 請走 batchTransition）
const ENUM_BATCH_FIELDS = ['priority', 'version', 'module', 'parentId'];

// ── LJ-095 v2 + LJ-116：Tool 定義（12 個）+ LJ-178 批量（3 個）──
const TOOL_DEFS = [
  // 既有保留（7 個）
  tool('litejira.searchTickets',
    'Search and filter tickets via API v1 (GET /tickets). Returns { items, nextCursor } — each item carries a UUID "id" plus a human-readable public "key"; member fields are { id, name } objects (null when unset). Pass nextCursor back as "cursor" to page. Member/parent filters take UUIDs only (assigneeId / ownerId / creatorId / parentId) — read litejira://members for ids; display names are NOT accepted. Multi-value filters (type/status/statusGroup/priority/module/subtype/targetVersion/foundVersion) accept a string or an array of strings. Use litejira://ticket/{id} for one complete ticket.',
    'searchTickets', false, {
      project: { type: 'string', description: '專案 key。省略時採用啟動環境的 LTJ_PROJECT；兩者皆無則不帶此條件（跨專案搜尋）。' },
      q: { type: 'string', description: 'Keyword search across title + description' },
      type: P_MULTI('Filter by ticket type 工單類型。動態值，請先讀 litejira://meta'),
      status: P_MULTI('Filter by status 狀態。動態值依工單 type 而定，請先讀 litejira://workflow/{type}'),
      statusGroup: P_MULTI('Filter by status group 狀態分組。動態值，請先讀 litejira://meta'),
      priority: P_MULTI('Filter by priority 優先級。動態值，請先讀 litejira://meta'),
      module: P_MULTI('Filter by module 模塊。動態值，請先讀 litejira://meta'),
      subtype: P_MULTI('Filter by subtype 子類型。動態值依 type 而定，請先讀 litejira://meta'),
      targetVersion: P_MULTI('Filter by 目標版本。動態值，請先讀 litejira://versions'),
      foundVersion: P_MULTI('Filter by 發現版本。動態值，請先讀 litejira://versions'),
      assigneeId: P_MEMBER_UUID('處理人'),
      ownerId: P_MEMBER_UUID('負責人（最終負責人）'),
      creatorId: P_MEMBER_UUID('建立者'),
      parentId: { type: 'string', description: '父工單 UUID（不是公開 key）', pattern: UUID_SCHEMA_PATTERN },
      limit: P_LIMIT,
      cursor: P_CURSOR,
      sort: { type: 'string', description: 'Sort field（v1 契約值域）', enum: ENUM_SORT },
      order: P_ORDER
    }, [], {
      readOnlyHint: true,
      openWorldHint: true,
      title: '搜尋工單'
    }, {
      v1: { action: 'searchTickets', defaultProject: true },
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
    'Set or remove parent-child relationship between tickets (e.g. link BUG to EPIC). Pass parentId=null to unlink.',
    'linkTickets', true, {
      childId: { type: 'string', description: '子工單 ID', pattern: TICKET_ID_PATTERN },
      parentId: { type: ['string', 'null'], description: '父工單 ID；傳 null 解除關聯' },
      expectedUpdatedAt: P_EXPECTED_UPDATED_AT,
      idempotencyKey: P_IDEMPOTENCY
    }, ['childId', 'idempotencyKey'], {
      destructiveHint: true,
      openWorldHint: true,
      title: '關聯/解除工單父子'
    }),
  tool('litejira.replyFeedback',
    'Post a comment AND optionally transition ticket status in one call. Use this when the comment is paired with a status change. For comment-only use addComment instead.',
    'replyFeedback', true, {
      ticketId: P_TICKET_ID,
      content: { type: 'string', description: '留言內容（Markdown 支援）' },
      transition: { type: 'object', description: '可選的狀態轉換。Shape: { toStatus: string }。server 端只看 toStatus 欄。' },
      expectedUpdatedAt: P_EXPECTED_UPDATED_AT,
      idempotencyKey: P_IDEMPOTENCY
    }, ['ticketId', 'content', 'idempotencyKey'], {
      idempotentHint: true,
      openWorldHint: true,
      title: '回覆反饋（含可選狀態轉換）'
    }),
  tool('litejira.attachLink',
    'Attach a reference URL (doc, design, external page) to a ticket\'s attachment list. NOT for MR/PR links — use updateField(field=\'mrUrl\') for code review links.',
    'attachLink', true, {
      ticketId: P_TICKET_ID,
      url: { type: 'string', description: '參考連結 URL，必須 http:// 或 https:// 開頭' },
      name: { type: 'string', description: '顯示名稱（省略則用 url）' },
      kind: { type: 'string', description: '連結分類提示（server 端不限制，free-form）如 doc / design / external' },
      idempotencyKey: P_IDEMPOTENCY
    }, ['ticketId', 'url', 'idempotencyKey'], {
      idempotentHint: true,
      openWorldHint: true,
      title: '附加 URL 連結'
    }),
  tool('litejira.removeAttachment',
    'Remove a previously attached reference URL from a ticket\'s attachment list, matched by url. Idempotent: removing a url that is not attached returns removed:false without error. NOT for MR/PR links — those live in the mrUrl field.',
    'removeAttachment', true, {
      ticketId: P_TICKET_ID,
      url: { type: 'string', description: '要移除的附件 URL（以 attachLink 當初附上的 url 為準）' },
      idempotencyKey: P_IDEMPOTENCY
    }, ['ticketId', 'url', 'idempotencyKey'], {
      destructiveHint: true,
      openWorldHint: true,
      title: '移除附件連結'
    }),
  tool('litejira.updateField',
    'Update a single ticket field. Whitelist: title, priority, version, dueDate, startDate, description, notes, subtype, tags, mrUrl, reproSteps, expectedResult, verifyMethod, fixMethod, verifiableVersionAlpha, verifiableVersionRelease, foundVersion, module, parentId, stdLevel2, stdLevel3, releaseMethod, status, assignee, owner. For MR/PR links: field=\'mrUrl\'. Assignee (處理人) follows member validation; LJ-188/GH-249: changing assignee here also notifies old+new assignee via team Chat (same as reassignTicket, without a reason comment). GH-242: field=\'owner\'（負責人 / 最終負責人，固定，不隨狀態流轉變化）可設成員名或清空（value=null / ""）；與 assignee 處理人區分。releaseMethod（發布方式）值域受控 待定/熱更/換包/停服（送測必填非待定）. LJ-188 WELDED: field=\'status\' WITHOUT force is REJECTED (use_transitionTicket) — all normal transitions MUST go through litejira.transitionTicket (carries send-test 3-field gate 發布方式/修復方式/驗證方式 + role auto-reassign + notification). ADMIN ONLY escape hatch: pass force=true with field=\'status\' to bypass workflow path validation (LJ-153) — target must still be a defined status of the ticket\'s flow group; the audit comment is marked 「（管理者強制）」. field=\'version\' 改為不同值時必帶 reason（後端 version_reason_required 守衛，LJ-168）。',
    'updateField', true, {
      ticketId: P_TICKET_ID,
      field: { type: 'string', description: 'Whitelist 欄位名（25 個合法值）', enum: ENUM_UPDATE_FIELDS },
      value: { type: ['string', 'number', 'null'], description: '新值。型別依 field 而定：status/subtype/module 等動態值請先讀 litejira://meta；priority 用 P0-緊急/P1-高/P2-中/P3-低；releaseMethod 用 待定/熱更/換包/停服（發布方式，送測必填非待定）；null 代表清空。' },
      force: { type: 'boolean', description: 'LJ-153 管理者強制改狀態：true 時繞過工作流路徑驗證（僅 field=status 可用、僅 admin 放行；目標仍須是該流程組已定義的狀態）。一般流轉請不要帶此參數。' },
      reason: { type: 'string', description: 'GH-234：改 field=version 且新舊版本不同時必填（後端 version_reason_required 守衛，LJ-168），說明為何改版本；會記入工單歷程。其他欄位可省略。' },
      expectedUpdatedAt: P_EXPECTED_UPDATED_AT,
      idempotencyKey: P_IDEMPOTENCY
    }, ['ticketId', 'field', 'idempotencyKey'], {
      destructiveHint: true,
      openWorldHint: true,
      title: '更新工單欄位'
    }),
  // LJ-095 新增（5 個）
  tool('litejira.createTicket',
    'Create a new ticket. Required: type (BUG/REQ/EPIC/IDEA/TASK/STD), title. Optional: priority, assignee, version, description, subtype, module, releaseMethod, etc. BUG type also accepts reproSteps, expectedResult, foundVersion. STD type (LJ-106 客服申訴) also accepts stdLevel2 (二級類目) + stdLevel3 (三級類目); 不支援 subtype / module / parentId。',
    'createTicket', true, {
      type: { type: 'string', description: '工單類型', enum: ENUM_TYPES },
      title: { type: 'string', description: '工單標題' },
      priority: { type: 'string', description: '優先級（含中文後綴）', enum: ENUM_PRIORITIES },
      assignee: { type: 'string', description: 'Member 顯示名稱（不是 email）；省略則自動指派（處理人）' },
      owner: { type: 'string', description: 'GH-242 負責人（最終負責人，固定）顯示名稱（不是 email）；省略留空，之後首次進入開發/進行中類狀態自動補為推進者' },
      version: { type: 'string', description: '目標版本' },
      description: { type: 'string', description: '工單描述 / body（Markdown 支援）' },
      subtype: { type: 'string', description: '子類型。動態值依 type 而定，請先讀 litejira://meta。' },
      module: { type: 'string', description: '模塊。動態值，請先讀 litejira://meta。' },
      releaseMethod: P_RELEASE_METHOD, // LJ-184 發布方式（省略則後端預設待定）
      notes: { type: 'string', description: '內部備註' },
      reproSteps: { type: 'string', description: 'BUG 重現步驟（BUG type 專用）' },
      expectedResult: { type: 'string', description: 'BUG 預期結果（BUG type 專用）' },
      foundVersion: { type: 'string', description: 'BUG 發現版本（BUG type 專用）' },
      parentId: { type: 'string', description: '父工單 ID（REQ/BUG → EPIC）', pattern: TICKET_ID_PATTERN },
      dueDate: { type: 'string', description: '到期日（YYYY-MM-DD）' },
      startDate: { type: 'string', description: '開始日（YYYY-MM-DD）' },
      stdLevel2: { type: 'string', description: 'STD 客服申訴二級類目。動態值，請先讀 litejira://meta（STD type 專用）。' },
      stdLevel3: { type: 'string', description: 'STD 客服申訴三級類目。動態值（依 stdLevel2 cascade），請先讀 litejira://meta。' },
      idempotencyKey: P_IDEMPOTENCY
    }, ['type', 'title', 'idempotencyKey'], {
      idempotentHint: true,
      openWorldHint: true,
      title: '建立工單'
    }),
  tool('litejira.addComment',
    'Post a comment on a ticket WITHOUT status transition. For comment + status change use replyFeedback instead.',
    'addComment', true, {
      ticketId: P_TICKET_ID,
      content: { type: 'string', description: '留言內容（Markdown 支援）' },
      idempotencyKey: P_IDEMPOTENCY
    }, ['ticketId', 'content', 'idempotencyKey'], {
      idempotentHint: true,
      openWorldHint: true,
      title: '新增留言'
    }),
  tool('litejira.reassignTicket',
    'Reassign a ticket to a different member with an optional reason comment. Triggers notification to new assignee. For changing assignee without comment use updateField(field=\'assignee\').',
    'reassignTicket', true, {
      ticketId: P_TICKET_ID,
      newAssignee: { type: 'string', description: '新 assignee 顯示名稱（不是 email）。動態值，請先讀 litejira://members。' },
      reason: { type: 'string', description: '轉派原因（會作為留言寫入工單）' },
      expectedUpdatedAt: P_EXPECTED_UPDATED_AT,
      idempotencyKey: P_IDEMPOTENCY
    }, ['ticketId', 'newAssignee', 'reason', 'idempotencyKey'], {
      idempotentHint: true,
      openWorldHint: true,
      title: '轉派工單'
    }),
  tool('litejira.convertTicketType',
    'Convert ticket type (e.g. BUG→REQ, IDEA→TASK). Allowed conversions: any of BUG/REQ/IDEA/TASK/EPIC can convert to any other. STD type is NOT convertible.',
    'convertTicketType', true, {
      ticketId: P_TICKET_ID,
      newType: { type: 'string', description: '目標類型（STD 不可轉，故只 5 選 1）', enum: ENUM_CONVERTIBLE_TYPES },
      idempotencyKey: P_IDEMPOTENCY
    }, ['ticketId', 'newType', 'idempotencyKey'], {
      destructiveHint: true,
      openWorldHint: true,
      title: '轉換工單類型'
    }),
  tool('litejira.toggleWatch',
    'Toggle watch/unwatch on a ticket. Watched tickets appear in "我關注的" sidebar filter.',
    'toggleWatchTicket', true, {
      ticketId: P_TICKET_ID,
      idempotencyKey: P_IDEMPOTENCY
    }, ['ticketId', 'idempotencyKey'], {
      idempotentHint: true,
      openWorldHint: true,
      title: '切換工單關注'
    }),
  // LJ-137 新增（2 個）：動作按鈕流轉對外化 + 查當前可用動作
  tool('litejira.transitionTicket',
    'One-shot status transition by action-button label, WITH automatic role-based reassignment (首次認領→點按者 / 回流→上一手開發者 / 前進→目標 role 預設人). Equivalent to the webapp Drawer action buttons. The "action" label must be one currently available for the ticket — call litejira.getTransitions FIRST to get valid labels. To set status WITHOUT auto-reassign use updateField(field=\'status\') instead. 退回類動作（getTransitions 回傳 direction=back，如 alpha不通過/release不通過/MR打回/退回/退單）必須帶 reason，否則後端拒絕（GH-215：原因會記入工單歷程供被打回的開發者查看）。',
    'transitionTicket', true, {
      ticketId: P_TICKET_ID,
      action: { type: 'string', description: '動作標籤（如「開始開發」「送alpha測試」「alpha不通過」）。合法值依工單當前狀態而定，請先呼叫 litejira.getTransitions 取得。' },
      expectedUpdatedAt: P_EXPECTED_UPDATED_AT,
      extraFields: { type: 'object', description: '連帶欄位（不覆蓋 status/assignee）。LJ-188 送測（進 alpha/release 測試 / 熱修待合 release）三欄必備，缺項在此帶入：{ fixMethod: "修復方式", verifyMethod: "驗證方式", releaseMethod: "熱更/換包/停服" }。' },
      reason: { type: 'string', description: 'GH-215：退回類動作（direction=back）必填的原因，說明測試哪裡不通過；會記入工單歷程。前進類動作可省略。' },
      idempotencyKey: P_IDEMPOTENCY
    }, ['ticketId', 'action', 'idempotencyKey'], {
      idempotentHint: true,
      openWorldHint: true,
      title: '流轉工單狀態（動作按鈕，含自動轉派）'
    }),
  tool('litejira.getTransitions',
    'Get the currently available action-button transitions for a ticket via API v1 (GET /tickets/{ticketId}/transitions; no query parameters). The ticket argument accepts a UUID, a public key (BUG-481) or a numeric key. Returns the contract object as-is — read actions[] for the labels that are valid transition actions. GH-253: any "transitions" array in the payload is NOT an action list; it is the backend validation whitelist of target STATUS names and its values differ from action labels. NOTE: performing a transition (litejira.transitionTicket / litejira.batchTransition) is NOT available in this version — its v1 write contract is not wired yet.',
    'getAllowedTransitions', false, {
      ticketId: P_TICKET_REF
    }, ['ticketId'], {
      readOnlyHint: true,
      openWorldHint: true,
      title: '查工單當前可用流轉動作'
    }, {
      v1: { action: 'getAllowedTransitions', ticketParam: 'ticketId' }
    }),
  // LJ-178 新增（3 個）：批量操作對外化 — 一發處理 N 張，取代逐張迴圈
  tool('litejira.batchTransition',
    'Batch status transition for MANY tickets in ONE call, by action-button label, WITH automatic role-based reassignment (same semantics as litejira.transitionTicket, applied to every id). All tickets SHOULD currently be at the same status so the action label is valid for each — call litejira.searchTickets to filter a same-status batch first. Tickets where the action is not valid (or not found) land in failed[] without aborting the rest (partial success). NO optimistic lock (batch status changes intentionally skip it to avoid concurrent-write conflicts). Returns { success:[{id,status,assignee}], failed:[{id,error}] }. 退回類動作（direction=back）須帶 reason，否則每張落 failed[]（GH-215）。',
    'batchTransition', true, {
      ids: P_IDS,
      action: { type: 'string', description: '動作標籤（如「送release測試」「alpha不通過」），對全批工單當前狀態須合法；不合法的工單落在 failed[]。合法值依當前狀態而定，請先 litejira.getTransitions 取得。' },
      extraFields: { type: 'object', description: '連帶欄位（全批共用，不覆蓋 status/assignee）。LJ-188 送測三欄必備，缺項在此帶入：{ fixMethod: "修復方式", verifyMethod: "驗證方式", releaseMethod: "熱更/換包/停服" }。' },
      reason: { type: 'string', description: 'GH-215：退回類動作（direction=back）必填的原因，批次共用；會記入每張工單歷程。前進類動作可省略。' },
      idempotencyKey: P_IDEMPOTENCY
    }, ['ids', 'action', 'idempotencyKey'], {
      idempotentHint: true,
      openWorldHint: true,
      title: '批量流轉工單狀態（含自動轉派）'
    }),
  tool('litejira.batchReassign',
    'Batch reassign MANY tickets to the SAME new assignee in ONE call, with a shared reason comment. Triggers a notification per ticket. Returns { success:[id], failed:[{id,error}] }. For a single ticket use litejira.reassignTicket.',
    'batchReassign', true, {
      ids: P_IDS,
      newAssignee: { type: 'string', description: '新 assignee 顯示名稱（不是 email）。動態值，請先讀 litejira://members。' },
      reason: { type: 'string', description: '轉派原因（會作為留言寫入每張工單）' },
      idempotencyKey: P_IDEMPOTENCY
    }, ['ids', 'newAssignee', 'reason', 'idempotencyKey'], {
      idempotentHint: true,
      openWorldHint: true,
      title: '批量轉派工單'
    }),
  tool('litejira.batchSetField',
    'Batch set ONE field to the SAME value across MANY tickets in ONE call. Whitelist: priority / version / module / parentId (NOT status — for status use litejira.batchTransition). Goes through the same updateTicket path (workflow/member validation per field). Returns { success:[id], failed:[{id,error}] }.',
    'batchSetField', true, {
      ids: P_IDS,
      field: { type: 'string', description: '批量改的欄位（白名單 4 個）。status 不在此 — 改狀態請用 litejira.batchTransition。', enum: ENUM_BATCH_FIELDS },
      value: { type: ['string', 'number', 'null'], description: '新值（全批共用）。priority 用 P0-緊急/P1-高/P2-中/P3-低；version/module 動態值請先讀 litejira://meta；parentId 為 PREFIX-NNN 或 null 解除掛載。' },
      idempotencyKey: P_IDEMPOTENCY
    }, ['ids', 'field', 'idempotencyKey'], {
      destructiveHint: true,
      openWorldHint: true,
      title: '批量改工單欄位'
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
    description: '單張工單完整資料。{id} 可用 UUID 主鍵、公開 key（BUG-481）或純數字 key。',
    action: 'getTicket', needsProject: false, query: [],
    paramMap: (path) => ({ ticket: decodeURIComponent(path.split('/').pop()) })
  }
];

// ── LJ-095 v2：Prompt 定義（4 個）；GH-257 第二包對齊 v1 讀取流程 ──
// 本版只有讀取工具可用（寫入端點的 v1 契約尚未接線），因此四個 prompt 一律以
// 「彙整草稿 → 交還給使用者」收尾，不指示呼叫本版拿不到的寫入工具。
const PROMPT_DEFS = [
  {
    name: 'report-bug',
    description: '回報 BUG — 引導填寫標題/重現步驟/預期結果，讀 meta/members/versions 備妥受控值，產出建單草稿（本版不自動建單）',
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
    description: '關閉工單 — 讀工單 + 可用流轉動作，列出到結案的合法路徑（本版不執行流轉）',
    arguments: [
      { name: 'ticketId', description: '工單參照：UUID、公開 key（BUG-481）或純數字 key', required: true }
    ]
  }
];

// GH-257 第二包：沒有 v1 契約列的工具一律標記 pending。
// 用「反推」而不是逐一手寫，確保新增工具時不會漏標而悄悄掉回舊後端。
TOOL_DEFS.forEach(function (def) {
  if (!def.v1) def.pending = true;
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
  return {
    apiUrl: runtimeEnv.LTJ_API_URL || '',
    token: runtimeEnv.LTJ_API_TOKEN || runtimeEnv.LTJ_API_PAT || '',
    // GH-257：專案層級端點（meta / versions / dashboard / workflow）的預設專案。
    // 非祕密設定；沒設也不猜，缺的時候明確報錯。
    project: runtimeEnv.LTJ_PROJECT || '',
    enableWrites: String(runtimeEnv.LTJ_MCP_ENABLE_WRITES || '').toLowerCase() === 'true'
  };
}

// GH-257：尚未接上 v1 契約的工具一律在本機擋下。
// 關鍵是「不得悄悄退回舊後端」：舊路徑是單一 POST + body token，與 v1 是兩套權限模型，
// 混用會讓呼叫端拿到語意不同的錯誤碼，也讓 PAT 走回舊通道。
function assertMigrated_(def) {
  if (!def.pending) return;
  throw mcpError_('TOOL_NOT_MIGRATED',
    '工具「' + def.name + '」尚未接上 API v1（其 v1 端點契約未取得），本機拒絕呼叫，' +
    '不會退回舊後端。本版可用的是讀取工具：litejira.searchTickets / listComments / getActivityLog / getTransitions，' +
    '以及 litejira:// 資源。寫入工具將在下一個版本接齊。',
    { tool: def.name, action: def.action }, -32601);
}

async function callTool(name, args, config, fetchImpl) {
  const def = TOOL_DEFS.find((candidate) => candidate.name === name);
  if (!def) throw mcpError_('UNKNOWN_TOOL', 'unknown MCP tool: ' + name, undefined, -32602);
  // 未升級的工具先擋：不論 LTJ_MCP_ENABLE_WRITES 設成什麼，回答都一樣且誠實。
  assertMigrated_(def);
  const cfg = config || getConfigFromEnv();
  if (!cfg.apiUrl || !cfg.token) throw mcpError_('CONFIG_ERROR', 'LTJ_API_URL and LTJ_API_TOKEN are required (legacy LTJ_API_PAT also accepted)');
  if (def.write && !cfg.enableWrites) throw mcpError_('WRITES_DISABLED', 'write tools require LTJ_MCP_ENABLE_WRITES=true');

  const params = toV1Params_(def, validateToolInput(def, args || {}), cfg);

  const outcome = await callV1Or_(def.v1.action, params, cfg, fetchImpl);
  if (outcome.isError) return outcome;
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

// MCP 參數 → v1 params。MCP 端刻意沿用契約參數名，這裡只處理三件事：
//   1. ticketId → 該路由實際的路徑參數名（ticket / ticketId）
//   2. project 預設值（僅 searchTickets；沒有 LTJ_PROJECT 就不帶，等於跨專案搜尋）
//   3. 其餘原樣帶出 —— 不做任何改名或值域轉換，讓傳輸層的白名單是唯一守門人
function toV1Params_(def, input, cfg) {
  const wiring = def.v1;
  const out = {};
  Object.keys(input).forEach((key) => { out[key] = input[key]; });
  if (wiring.ticketParam && out.ticketId !== undefined) {
    out[wiring.ticketParam] = out.ticketId;
    if (wiring.ticketParam !== 'ticketId') delete out.ticketId;
  }
  if (wiring.defaultProject && out.project === undefined && cfg.project) {
    out.project = cfg.project;
  }
  return out;
}

// 共用的 v1 呼叫 + 錯誤轉譯。回 { value } 或 MCP 的 isError 結果。
async function callV1Or_(action, params, cfg, fetchImpl) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (!fetchFn) throw mcpError_('CONFIG_ERROR', 'fetch is required; use Node 18+ or pass fetchImpl');
  let result;
  try {
    result = await callV1({
      fetch: fetchFn,
      baseUrl: cfg.apiUrl,
      token: cfg.token,
      action: action,
      params: params
    });
  } catch (err) {
    if (err instanceof LiteJiraApiError) {
      // 後端裁決：code / message / details 原樣轉出，不重新編碼、不映射回舊的四種代碼。
      return apiErrorResult_(err);
    }
    if (err instanceof LiteJiraTransportError) {
      // 本機拒絕 / 連線層失敗：code 與 API 錯誤碼刻意不同名，呼叫端一看就知道沒到後端。
      throw mcpError_(err.code, err.message, err.details, -32000);
    }
    throw err;
  }
  return { value: result.data };
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
  const out = {};
  const errors = [];
  Object.keys(args || {}).forEach((key) => {
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
          // GH-257 第二包：改述 v1 讀取契約；寫入尚未接線，明講以免助手繞路自創寫法。
          instructions: [
            'LiteJira MCP 操作規則（API v1）：',
            '- 本版只提供讀取：searchTickets / listComments / getActivityLog / getTransitions 與 litejira:// 資源。寫入工具（建單/留言/改欄位/流轉/批量）尚未接上 v1，呼叫會被拒絕，請改交草稿給使用者。',
            '- 工單參照可用 UUID 主鍵、公開 key（BUG-481）或純數字 key；回傳同時有 UUID id 與公開 key，對人講 key、要精確就用 id。',
            '- 成員條件只收 UUID：assigneeId / ownerId / creatorId（顯示名無效）。先讀 litejira://members 取 id。',
            '- 受控值讀 litejira://meta，版本讀 litejira://versions，狀態流轉讀 litejira://workflow/{type}；別沿用記憶中的舊值域。',
            '- 專案層級資源（meta/versions/dashboard/workflow）取 LTJ_PROJECT，或在 URI 帶 ?project=KEY；沒有就會報錯，不要亂猜專案。',
            '- 清單用 limit + cursor 分頁（把 nextCursor 當 cursor 帶回），limit 上限 100；type/status/priority 等條件可傳陣列一次帶多值。',
            '- activity 用 kind=user|system 單選過濾，不帶 kind 才是全部。'
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
  if (!cfg.apiUrl || !cfg.token) throw mcpError_('CONFIG_ERROR', 'LTJ_API_URL and LTJ_API_TOKEN are required');

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
// GH-257：統一結尾語 —— 本版寫入工具尚未接上 v1 契約，呼叫會被本機拒絕。
// prompt 直接講明，免得助手一路走到最後才撞牆、或自行編造替代寫法。
const WRITE_PENDING_NOTE =
  '注意：本版 litejira MCP 只開放讀取工具（searchTickets / listComments / getActivityLog / getTransitions 與 litejira:// 資源）。' +
  '建單、留言、改欄位、流轉狀態等寫入工具尚未接上 API v1，呼叫會被直接拒絕 —— ' +
  '請把結果整理成草稿交給我，不要嘗試用其他方式代為寫入。';

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
            '最後輸出一份建單草稿（欄位: 值），成員欄位請同時列出顯示名與 UUID id。' +
            WRITE_PENDING_NOTE
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
            WRITE_PENDING_NOTE
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
            '以回應中的 actions[].label 為準；同一份回應裡的 transitions 是目標狀態白名單，不是動作名稱，別混用。' +
            '若一步到不了結案狀態，請列出完整的中間步驟順序讓我確認。' +
            WRITE_PENDING_NOTE
        }
      }];
    default:
      return [{ role: 'user', content: { type: 'text', text: name } }];
  }
}

function startStdioServer() {
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
