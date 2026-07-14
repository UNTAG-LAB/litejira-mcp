#!/usr/bin/env node

const readline = require('readline');
const { postLiteJiraApi } = require('./ltj-cli');

// LJ-160 #2：版本號單一事實源 = package.json，避免手寫在多處漂移。
const PKG_VERSION = require('./package.json').version;        // 例 "2.3.0"
const PKG_VER_SHORT = PKG_VERSION.split('.').slice(0, 2).join('.'); // 例 "2.3"

// LJ-134: 工單 ID regex（PREFIX-NNN）。試算表工單前綴僅限 FB/BUG/REQ/EPIC/IDEA/TASK/STD。
// 命名空間紀律（根 CLAUDE.md）：LJ/DEV 是 LiteJira「自身開發」編號，事實源在 BACKLOG.md，
// 不是試算表工單 → 故意排除。防止把 BACKLOG 編號當試算表工單下 addComment/updateField/linkTickets
// 等操作而污染命名空間（webapp/Code.js 的 VALID_TYPES 本就無 LJ/DEV，此 pattern 對齊）。
const TICKET_ID_PATTERN = '^(FB|BUG|REQ|EPIC|IDEA|TASK|STD)-\\d+$';

// LJ-116 批次 2: enum 常數（基於 webapp/Code.js:38-40 + UPDATE_FIELD_WHITELIST 2289-2299 事實依據）
const ENUM_TYPES = ['EPIC', 'REQ', 'BUG', 'IDEA', 'TASK', 'STD'];
const ENUM_CONVERTIBLE_TYPES = ['EPIC', 'REQ', 'BUG', 'IDEA', 'TASK']; // STD 不可轉
const ENUM_PRIORITIES = ['P0-緊急', 'P1-高', 'P2-中', 'P3-低']; // 含中文後綴
const ENUM_ORDER = ['asc', 'desc'];
const ENUM_SORT = ['createdAt', 'updatedAt', 'priority', 'dueDate'];
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
const P_LIMIT = { type: 'integer', description: 'Max results (1-100). 超過上限請改用 cursor 分頁。', minimum: 1, maximum: 100 };
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
    'Search and filter tickets. Returns summary fields (16 cols). For full detail use litejira://ticket/{id} resource.',
    'searchTickets', false, {
      q: { type: 'string', description: 'Keyword search across title + description' },
      type: { type: 'string', description: 'Filter by ticket type', enum: ENUM_TYPES },
      status: { type: 'string', description: 'Filter by status. 動態值依工單 type 而定，請先讀 litejira://workflow/{type}。' },
      assignee: { type: 'string', description: 'Filter by assignee 處理人顯示名稱（不是 email）' },
      owner: { type: 'string', description: 'GH-242 Filter by owner 負責人（最終負責人）顯示名稱（不是 email）' },
      creator: { type: 'string', description: 'Filter by creator 顯示名稱' },
      version: { type: 'string', description: 'Filter by 目標版本（version name）' },
      module: { type: 'string', description: 'Filter by module 模塊。動態值，請先讀 litejira://meta。' },
      subtype: { type: 'string', description: 'Filter by subtype 子類型。動態值依 type 而定，請先讀 litejira://meta。' },
      limit: P_LIMIT,
      cursor: P_CURSOR,
      sort: { type: 'string', description: 'Sort field', enum: ENUM_SORT },
      order: P_ORDER
    }, [], {
      readOnlyHint: true,
      openWorldHint: true,
      title: '搜尋工單'
    }),
  tool('litejira.listComments',
    'List comments for a ticket (paginated). Returns comment content + author + timestamps.',
    'listComments', false, {
      ticketId: P_TICKET_ID,
      limit: P_LIMIT,
      cursor: P_CURSOR,
      order: P_ORDER
    }, ['ticketId'], {
      readOnlyHint: true,
      openWorldHint: true,
      title: '列出工單留言'
    }),
  tool('litejira.getActivityLog',
    'Get full activity timeline (comments + system events like status changes, reassignments). Paginated.',
    'getActivityLog', false, {
      ticketId: P_TICKET_ID,
      limit: P_LIMIT,
      cursor: P_CURSOR,
      includeComments: { type: 'boolean', description: '是否含留言事件（預設 true）' },
      includeSystemEvents: { type: 'boolean', description: '是否含系統事件如狀態變更 / 轉派（預設 true）' }
    }, ['ticketId'], {
      readOnlyHint: true,
      openWorldHint: true,
      title: '取工單時間軸'
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
    'Get the currently available action-button transitions for a ticket (by its current status). Returns { status, actions: [{ label, toStatus, direction }], isFinal }. Feed the returned actions[].label into litejira.transitionTicket as the "action" arg.',
    'getAllowedTransitions', false, {
      ticketId: P_TICKET_ID
    }, ['ticketId'], {
      readOnlyHint: true,
      openWorldHint: true,
      title: '查工單當前可用流轉動作'
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

// ── LJ-095 v2：Resource 定義（6 個） ──
const RESOURCE_DEFS = [
  { uri: 'litejira://meta', name: 'LiteJira 元資料', description: '類型/優先級/子類型/模塊清單', action: 'getMeta' },
  { uri: 'litejira://members', name: '成員清單', description: '啟用成員（name/email/role）', action: 'getMembers' },
  { uri: 'litejira://versions', name: '版本清單', description: '版本列表（name/status/dates）', action: 'getVersions' },
  { uri: 'litejira://dashboard', name: 'Dashboard 統計', description: '各狀態計數、逾期數', action: 'getDashboardStats' },
  // LJ-116 批次 4: paramMap decodeURIComponent（防 percent-encoded ticketId / type 字符）
  { uriTemplate: 'litejira://workflow/{type}', name: '工作流規則', description: '指定類型的狀態流轉規則', action: 'getWorkflow', paramMap: (uri) => ({ type: decodeURIComponent(uri.split('/').pop()) }) },
  { uriTemplate: 'litejira://ticket/{id}', name: '工單詳情', description: '單張工單完整資料（28 欄位）', action: 'getTicket', paramMap: (uri) => ({ ticketId: decodeURIComponent(uri.split('/').pop()) }) }
];

// ── LJ-095 v2：Prompt 定義（4 個） ──
const PROMPT_DEFS = [
  {
    name: 'report-bug',
    description: '回報 BUG — 引導填寫標題/重現步驟/預期結果，自動判斷子類型+負責人+版本，建單',
    arguments: [
      { name: 'title', description: 'BUG 標題（可選，會再確認）', required: false }
    ]
  },
  {
    name: 'weekly-status',
    description: '本週進度報告 — 統計本週完成/進行中/新開/逾期工單，按版本分組',
    arguments: []
  },
  {
    name: 'triage-ticket',
    description: '分類工單 — 讀取完整工單+工作流規則+成員清單，建議優先級/負責人/狀態',
    arguments: [
      { name: 'ticketId', description: '要 triage 的工單 ID', required: true }
    ]
  },
  {
    name: 'close-ticket',
    description: '關閉工單 — 檢查合法狀態轉換路徑，標記完成並附留言',
    arguments: [
      { name: 'ticketId', description: '要關閉的工單 ID', required: true }
    ]
  }
];

// LJ-116: tool() factory v2 — 接 annotations、properties 接 short form ('string') 或 long form ({type, description, ...})
function tool(name, description, action, write, properties, required, annotations) {
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
  return def;
}

function listTools() {
  return TOOL_DEFS.map((def) => {
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
    enableWrites: String(runtimeEnv.LTJ_MCP_ENABLE_WRITES || '').toLowerCase() === 'true'
  };
}

async function callTool(name, args, config, fetchImpl) {
  const def = TOOL_DEFS.find((candidate) => candidate.name === name);
  if (!def) throw mcpError_('UNKNOWN_TOOL', 'unknown MCP tool: ' + name, undefined, -32602);
  const cfg = config || getConfigFromEnv();
  if (!cfg.apiUrl || !cfg.token) throw mcpError_('CONFIG_ERROR', 'LTJ_API_URL and LTJ_API_TOKEN are required (legacy LTJ_API_PAT also accepted)');
  if (def.write && !cfg.enableWrites) throw mcpError_('WRITES_DISABLED', 'write tools require LTJ_MCP_ENABLE_WRITES=true');

  const params = validateToolInput(def, args || {});
  if (def.write && !params.idempotencyKey) {
    throw mcpError_('IDEMPOTENCY_KEY_REQUIRED', 'write tools require idempotencyKey', undefined, -32602);
  }

  const fetchFn = fetchImpl || globalThis.fetch;
  if (!fetchFn) throw mcpError_('CONFIG_ERROR', 'fetch is required; use Node 18+ or pass fetchImpl');
  const envelope = await postLiteJiraApi(fetchFn, cfg.apiUrl, cfg.token, def.action, params);
  // LJ-116 批次 4 (H4): 業務錯誤改 isError + 帶 next-step hint
  if (!envelope.ok) {
    const apiError = envelope.error || {};
    const apiCode = apiError.code || 'API_ERROR';
    const apiMsg = apiError.message || 'LiteJira API error';
    const hint = errorHintFor_(apiCode);
    return {
      isError: true,
      content: [{
        type: 'text',
        text: '[' + apiCode + '] ' + apiMsg + (hint ? '\n\n💡 ' + hint : '')
      }]
    };
  }
  // LJ-116 批次 4 (H5): 雙寫 — text fallback 給老主機、structuredContent 給新主機
  const data = envelope.data || {};
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data
  };
}

function validateToolInput(def, args) {
  const schema = def.inputSchema;
  const out = {};
  const errors = [];
  Object.keys(args || {}).forEach((key) => {
    if (!schema.properties[key]) {
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
          // LJ-116: instructions — server-capabilities skill 說「整個 spec 槓桿最高的一行」
          instructions: [
            `LiteJira MCP server v${PKG_VER_SHORT}：`,
            '',
            '- 寫入工具（createTicket / updateField / linkTickets / addComment / attachLink / removeAttachment / replyFeedback / reassignTicket / convertTicketType / toggleWatch / transitionTicket / batchTransition / batchReassign / batchSetField 共 14 個）必傳 idempotencyKey（16-64 字元 alphanumeric/_/-），retry 同語意操作請傳同一 key',
            '- 合法 enum 值請先讀 resource litejira://meta（types / priorities / subtypes / modules / statusMeta / kanbanColumnsByType）',
            '- 工作流轉換規則請讀 litejira://workflow/{type}',
            '- 轉狀態（含依 role 自動轉派負責人，等同 webapp 動作按鈕）：先 litejira.getTransitions 取當前可用動作 → litejira.transitionTicket(action=動作標籤)。LJ-188：updateField(field=status) 已焊死（僅 admin 帶 force=true 例外）；送測（進 alpha 測試 / release 測試 / 熱修待合 release）須 發布方式/修復方式/驗證方式 三欄齊備，缺項經 extraFields 一併帶入',
            '- 批量（一次改多張）：同狀態多張推進用 litejira.batchTransition(ids[], action)（含自動轉派，部分失敗回 failed[]）；多張轉派同一人用 litejira.batchReassign(ids[], newAssignee, reason)；多張改 version/priority/module 用 litejira.batchSetField(ids[], field, value)。一發呼叫取代逐張迴圈',
            '- STD 工單（客服申訴）建立必帶 stdLevel2 + stdLevel3，可選值見 litejira://meta',
            '- 工單清單請用 litejira.searchTickets 分頁 + cursor，不要 enumerate 個別 ticket resource',
            '- limit 參數上限 100，超過會被 schema 擋下',
            '- 工單 ID 格式 PREFIX-NNN（PREFIX ∈ {FB, BUG, REQ, EPIC, IDEA, TASK, STD}）。LJ/DEV 是 LiteJira 自身開發編號（BACKLOG.md），非試算表工單、不接受',
            '- priority 含中文後綴：P0-緊急 / P1-高 / P2-中 / P3-低（不是純 P0/P1）'
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
  if (types.indexOf('array') !== -1) {
    if (!Array.isArray(value)) return false;
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

// LJ-116 批次 4: 業務錯誤 hint 表（依 server 端 4 種錯誤代碼，見 webapp/Code.js:316-370）
function errorHintFor_(code) {
  switch (code) {
    case 'AUTH_FAILED':
      return 'LiteJira PAT 失效或缺失。請檢查 ~/.litejira/credentials.{env}.txt 內 LTJ_API_TOKEN。如需新 PAT 請聯絡 admin。';
    case 'UNKNOWN_ACTION':
      return '未知的 LiteJira action（litejira-mcp 與 server 版本不符）。請更新 litejira-mcp 至最新版。';
    case 'ADMIN_REQUIRED':
      return '此操作需要 LiteJira admin 權限（createPat / listPats / revokePat）。請聯絡 admin。';
    case 'ACTION_FAILED':
      return 'LiteJira 業務驗證失敗。建議：(1) 用 litejira.searchTickets 找正確 ticketId；(2) 讀 litejira://meta 取合法 type/priority/subtype/module enum 值；(3) 讀 litejira://workflow/{type} 取合法 status 流轉。';
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
async function readResource_(uri, config, fetchImpl) {
  // 比對固定 URI
  var def = RESOURCE_DEFS.find(function(r) { return r.uri === uri; });
  // 比對 URI template
  if (!def) {
    def = RESOURCE_DEFS.find(function(r) {
      if (!r.uriTemplate) return false;
      var pattern = r.uriTemplate.replace(/\{[^}]+\}/g, '[^/]+');
      return new RegExp('^' + pattern + '$').test(uri);
    });
  }
  if (!def) throw mcpError_('UNKNOWN_RESOURCE', 'unknown resource URI: ' + uri, undefined, -32602);
  var cfg = config || getConfigFromEnv();
  if (!cfg.apiUrl || !cfg.token) throw mcpError_('CONFIG_ERROR', 'LTJ_API_URL and LTJ_API_TOKEN are required');
  var fetchFn = fetchImpl || globalThis.fetch;
  var params = def.paramMap ? def.paramMap(uri) : {};
  var envelope = await postLiteJiraApi(fetchFn, cfg.apiUrl, cfg.token, def.action, params);
  if (!envelope.ok) {
    var apiError = envelope.error || {};
    throw mcpError_(apiError.code || 'API_ERROR', apiError.message || 'LiteJira API error');
  }
  return {
    contents: [{
      uri: uri,
      mimeType: 'application/json',
      text: JSON.stringify(envelope.data || {}, null, 2)
    }]
  };
}

// ── Prompt 訊息生成 ──
function getPromptMessages_(name, args) {
  switch (name) {
    case 'report-bug':
      return [{
        role: 'user',
        content: {
          type: 'text',
          text: '幫我建一張 BUG 工單。' + (args.title ? '標題：' + args.title + '。' : '') +
            '請先讀 litejira://meta 和 litejira://members 和 litejira://versions 取得子類型/成員/版本清單，' +
            '然後問我：標題、重現步驟、預期結果、優先級（預設 P2-中）。' +
            '自動判斷子類型和負責人，用最新 active 版本，最後呼叫 createTicket 建單。'
        }
      }];
    case 'weekly-status':
      return [{
        role: 'user',
        content: {
          type: 'text',
          text: '給我本週進度報告。' +
            '先讀 litejira://dashboard 取統計數據，再用 searchTickets 查本週更新的工單（sort=updatedAt, order=desc）。' +
            '彙整：本週完成 N 張、進行中 N 張、新開 N 張、逾期 N 張，按版本分組列出重點。'
        }
      }];
    case 'triage-ticket':
      return [{
        role: 'user',
        content: {
          type: 'text',
          text: '幫我分類工單 ' + (args.ticketId || '（請提供工單 ID）') + '。' +
            '先讀 litejira://ticket/' + (args.ticketId || '{id}') + ' 取完整資料，' +
            '讀 litejira://workflow/{type} 取合法狀態轉換，讀 litejira://members 取成員清單。' +
            '建議：優先級、負責人、狀態。列出建議但不自動執行，等我確認。'
        }
      }];
    case 'close-ticket':
      return [{
        role: 'user',
        content: {
          type: 'text',
          text: '幫我關閉工單 ' + (args.ticketId || '（請提供工單 ID）') + '。' +
            '先讀 litejira://ticket/' + (args.ticketId || '{id}') + ' 和 litejira://workflow/{type}，' +
            '確認合法轉換路徑。若可直接到「已完成」就執行，否則列出中間步驟讓我確認。附帶留言「由 AI 協助關閉」。'
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
