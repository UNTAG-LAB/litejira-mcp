# GH-257 第二包：MCP 讀取面（tools / resources / prompts）接上 API v1

分支 `codex/gh257-v1-upgrade-20260911`，base `48922e1`（第一包：傳輸層 + CLI，50 項測試已驗）。

本包把 MCP 的**讀取面**全部切到 v1；寫入面不動，但也**不留在舊後端**——沒有 v1 契約的工具一律本機拒絕。

## 交付物

| 檔案 | 內容 |
|---|---|
| `litejira-v1-transport.js`（改） | 補 6 條讀取路由；`query` 規格新增 `required` / `bool` / `exclusive` |
| `litejira-mcp-server.js`（改） | 4 個讀取 tool、6 個 resource、4 個 prompt 改走 `callV1`；錯誤語意換成 v1；未升級工具本機擋下 |
| `litejira-mcp-launch.cjs`（改） | credentials 白名單新增 `LTJ_PROJECT`（非祕密） |
| `test/gh-257-pack2-mcp-read.test.js`（新） | 讀取面端到端測試（真 JSON-RPC in-process + 注入 fetch） |
| `test/gh-265-mcp-token-slim.test.js`（改） | `responseMode` 隨舊後端退場，改鎖「退場後不靜默忽略」 |
| `README.md`（改） | 標示本版只開放讀取、寫入待下一包；`LTJ_PROJECT` 設定說明 |

## 新增的路由契約（皆已由控制端核對）

| action | method / path | query |
|---|---|---|
| `getAllowedTransitions` | `GET /tickets/{ticketId}/transitions` | 無 |
| `getMeta` | `GET /meta` | `project`（必填） |
| `getWorkflow` | `GET /workflow` | `project`（必填）、`type`、`flowGroupCode` |
| `getMembers` | `GET /members` | `activeOnly`（預設 true）、`jobRole`；**不收 project** |
| `getVersions` | `GET /versions` | `project`（必填） |
| `getDashboardStats` | `GET /stats` | `project`（必填）、`scope`(all\|me) / `targetVersion` / `role` **三者互斥** |

必填 query 缺席、互斥組給超過一個、`activeOnly` 非布林 → 送出前本機拒絕（`invalid_argument`）。

## 讀取工具的 schema 變更

- **`searchTickets`**：參數名直接對齊 v1 白名單。
  - 新增 `project`、`statusGroup`、`targetVersion`、`foundVersion`、`assigneeId` / `ownerId` / `creatorId` / `parentId`（UUID）。
  - 多值條件（`type`/`status`/`statusGroup`/`priority`/`module`/`subtype`/`targetVersion`/`foundVersion`）收字串或字串陣列，送出時展開成**重複 query**，不做逗號串接。
  - `sort` 值域換成契約的 `updatedAt` / `createdAt` / `key`（舊的 `priority` / `dueDate` 不在 v1 契約內）。
  - **移除且明確拒絕**：`assignee` / `owner` / `creator`（顯示名 → 改 UUID）、`version`（→ 拆成 `targetVersion` / `foundVersion`）、`responseMode`（v1 的 `GET /tickets` 沒有這個參數）。
    一律回 `VALIDATION_FAILED` 並在訊息裡指路，**不是**靜默忽略，也不是只回一句 unknown parameter。
- **`listComments` / `getActivityLog` / `getTransitions`**：`ticketId` 放寬為「UUID / 公開 key（`BUG-481`）/ 純數字 key」三種形狀。
  `getActivityLog` 改用 `kind=user|system` 單選（不帶 = 全部）；舊的 `includeComments` / `includeSystemEvents` 明確拒絕並指路。

回應處理：傳輸層已拆掉唯一一層 `{ data }`，MCP 端把 `data` **原樣**送出，
新 shape（UUID `id`、公開 `key`、`member { id, name }`、未指派時整個為 `null`、`nextCursor`）不做任何加工或壓扁。

## Resources 的專案來源

四個專案層級資源（`meta` / `versions` / `dashboard` / `workflow`）依序取：

1. URI 上的 `?project=KEY`（例：`litejira://meta?project=OTHER`）
2. 環境變數 `LTJ_PROJECT`
3. 都沒有 → `PROJECT_REQUIRED`，訊息同時列出兩種設法。**不自動挑第一個專案**。

`members` 是工作區層級名冊，**不送 project**；明著在 URI 塞 `?project=` 會被擋下（`INVALID_RESOURCE_URI`），不靜默丟掉。
每個 resource 各有 query 白名單，未列的參數一律拒絕。

## 錯誤語意

- 後端錯誤（`LiteJiraApiError`）→ `isError` 結果，`code` / `message` / `details` **原樣**帶出，另附 `status` 供記錄。
- 舊的四碼（`AUTH_FAILED` / `UNKNOWN_ACTION` / `ADMIN_REQUIRED` / `ACTION_FAILED`）在 v1 路徑上不出現，**也不做重映射**——
  v1 把它們拆成語意更細的碼（403 底下 `membership_required` / `permission_denied` / `admin_required` 三種互斥），壓回四碼會丟資訊。
  hint 表已整個換成 v1 錯誤碼；未知的碼不給 hint，以 server 原文為準。
- 本機拒絕（`LiteJiraTransportError`）→ JSON-RPC error，code 與 API 錯誤碼刻意不同名，一看就知道沒到後端。

## 未升級的 14 個寫入工具

`linkTickets` / `replyFeedback` / `attachLink` / `removeAttachment` / `updateField` / `createTicket` /
`addComment` / `reassignTicket` / `convertTicketType` / `toggleWatch` / `transitionTicket` /
`batchTransition` / `batchReassign` / `batchSetField`

- **不出現在 `tools/list`**（廣告必定失敗的工具只會誘導助手走死路），但仍留在 `TOOL_DEFS`，
  所以 `tools/call` 回的是明確的 `TOOL_NOT_MIGRATED` 而非籠統的 unknown tool。
- 擋在 `enableWrites` 檢查**之前**：不論 `LTJ_MCP_ENABLE_WRITES` 設成什麼，答案一樣且誠實。
- 關鍵紀律：**不得悄悄退回舊後端**。`litejira-mcp-server.js` 已完全不再 require `postLiteJiraApi`
  （舊路徑是單一 POST + body token，與 v1 是兩套權限模型，混用會讓 PAT 走回舊通道、錯誤碼語意也對不上）。
  測試逐一斷言這 14 個工具的 fetch 呼叫次數為 0。

## Prompts

四個 prompt 改成 v1 讀取流程：工單參照三形狀、成員一律附 UUID、分頁用 `nextCursor`、
`close-ticket` 明講以 `getTransitions` 的 `actions[].label` 為準（同一份回應裡的 `transitions` 是目標狀態白名單，不是動作名稱）。
`report-bug` / `weekly-status` / `triage-ticket` 新增選用的 `project` 參數。

涉及寫入的 prompt 以「彙整草稿交還使用者」收尾，並明講本版寫入工具不可用——
**不指示助手呼叫本版拿不到的寫入工具，也不暗示有其他替代寫法**。

## 驗證

`npm test`（`node --test`，root 執行）。所有 fetch 皆為注入，不接觸真 API、不讀憑證。

新測試涵蓋：6 個 resource 與 4 個 prompt **逐項真呼叫**（走 `handleJsonRpcRequest` 的
`resources/read` / `prompts/get`，不是只驗 list）、4 個讀取工具的真實 method/path/query、
新 shape 原樣保留、403 三種語意不被壓扁、14 個寫入工具零送出、專案解析三條路徑、
以及「整個讀取面沒有任何一發請求走舊的 POST + body token」的全域斷言。

## 尚未完成（不代表 P7.14 完成）

本包是讀取面工作包。寫入面 14 個工具的 v1 契約（method / path / body / Idempotency-Key 語意 /
`expectedUpdatedAt` 樂觀鎖）**尚未取得**，補進 `ACTION_MAP` 並接線是第三包的工作。
在那之前寫入一律本機拒絕。

控制端驗證（2026-09-11）：npm test 全部 80 通過、0 跳過。獨立審查指出 workflow 路徑 type 可被 query 靜默覆寫；已改為拒絕重複參數，並以 workflow/type、重複 project、重複 activeOnly 三個反例驗證零送出。這是注入 fetch 的 JSON-RPC handler 測試，尚非真後端 PAT 或已安裝套件验收。
