# GH-257 第三包：9 個基本寫入工具接上 API v1

分支 `codex/gh257-v1-upgrade-20260911`，base `afbbb4c`（第二包：讀取面 tools / resources / prompts）。

本包把**基本寫入**切到 v1。**未完成（5 個，一律本機拒絕，不退回舊後端）**：
`replyFeedback`、`updateField`、`batchTransition`、`batchReassign`、`batchSetField` —— 仍無 v1 契約列。

> `replyFeedback` **不是**被取代的舊工具，但它**也不是原子操作**：舊 GAS 後端
> （`Code.js:3153`）是「先做可選流轉，再 `addComment`」兩個獨立操作，中間失敗本來就會留下
> 「流轉了但沒留言」的半套狀態。v1 沒有等價的複合端點，本包不新增後端原子端點。
> 下一包的待辦是把它實作成 **client 端複合**：每個步驟各一把**穩定且互不相同**的冪等鍵，
> 加上**明確的部分成功回報**（哪一步成了、哪一步沒成）。
> 本包沒有「18 個工具全部完成」這回事：13 個已接線、5 個待辦。

## 交付物

| 檔案 | 內容 |
|---|---|
| `litejira-v1-transport.js`（改） | 補 6 條寫入路由 + 既有 3 條補完；新增 `methodSwitch` / `pathUuid` / `emptyBody` / `body.isoString` / `body.object` / `body.date` / `body.stringArray`；`createTicket` 收全套 24 欄；`setWatchState` 不再宣告 `emptyBody`；`replyFeedback` 從「已取代」改列「契約待補」；無 body 契約的路由不再靜默吞參數 |
| `litejira-mcp-server.js`（改） | 9 個寫入 tool 改走 `callV1`（含 Idempotency-Key header 接線）、schema 換成 v1 參數名、建單 schema 補齊 18 個選填欄位（皆可 `null`）、instructions 與 prompts 同步 |
| `test/gh-257-pack3-mcp-write.test.js`（新） | 寫入面端到端 + 傳輸層邊界：建單全欄位 / 全 null / 形狀違規、關注端點的 `{ data }` 信封與意外 204、`replyFeedback` 待辦 |
| `test/gh-257-pack2-mcp-read.test.js`（改） | tools/list 由 4 → 13；pending 由 14 → 5（含 `replyFeedback`）；prompt 斷言改鎖新文案 |
| `test/gh-257-v1-transport.test.js`（改） | `replyFeedback` 改斷言 `unmapped_action` |
| `README.md`（改） | 能力表改成「基本寫入已開放（建單一次填齊）、replyFeedback / updateField / 批量待下一版」 |

## 路由契約

| action | method / path | body |
|---|---|---|
| `createTicket` | `POST /tickets` | 核心：`project`*, `type`*, `title`*, `priority`, `description`, `assigneeId`(UUID)；選填（全部支援、皆可 `null`）：`module`, `subtype`, `releaseMethod`, `stdLevel2`, `stdLevel3`, `startDate`, `dueDate`, `tags`(string[]), `mrUrl`, `reproSteps`, `expectedResult`, `fixMethod`, `validationMethod`, `verifiableVersionAlpha`, `verifiableVersionRelease`, `ownerId`(UUID), `targetVersion`, `foundVersion` |
| `addComment` | `POST /tickets/{ticketId}/comments` | `body`*, `mentions`(UUID[])；**無樂觀鎖** |
| `attachLink` | `POST /tickets/{ticketId}/attachments` | `url`*, `name`（無 `kind`）；200 / 201 皆回 `{ data }` |
| `removeAttachment` | `DELETE /tickets/{ticketId}/attachments/{attachmentId}` | 無 body；**204 無內容** |
| `linkTickets` | `PUT /tickets/{childId}/parent` | `parentId`*(UUID \| null), `expectedUpdatedAt` |
| `reassignTicket` | `PUT /tickets/{ticketId}/assignee` | `assigneeId`*(UUID), `reason`*, `expectedUpdatedAt` |
| `convertTicketType` | `POST /tickets/{ticketId}/type` | `type`*, `subtype`, `expectedUpdatedAt` |
| `setWatchState` | `PUT`（watching=true）/ `DELETE`（false）` /tickets/{ticketId}/watchers/me` | 無 body；**回 `{ data }` 信封（不是 204）** |
| `transitionTicket` | `POST /tickets/{ticketId}/transitions` | `action`*(動作標籤), `reason`, `fields`(物件), `expectedUpdatedAt` |

所有 `/api/v1` 一律 PAT Bearer；寫入必帶 `Idempotency-Key`（header，`^[A-Za-z0-9_-]{16,64}$`）。

## 語意變更（都是明確拒絕 + 指路，不靜默丟棄）

- **冪等鍵**：舊 schema 寫「server 端未真正去重，純 client 紀律」是錯的。v1 的 server **真的會去重**：
  同一把 key 重送回同一個結果，換一把才會真的再做一次；同 key 配不同內容回 `idempotency_key_reused`。
- **`expectedUpdatedAt` 改成原始 ISO 字串**（原為 ms number）。傳數字會在送出前被擋下並說明理由 ——
  `Date → ms` 會掉微秒，比對不上就撞出假的 `version_conflict`。
- **`toggleWatch` 不再 toggle**：必須帶 `watching=true|false`。toggle 重送會翻回去，在會重試的通道上是錯語意。
  工具名保留（相容既有呼叫端），但參數與行為是「設定期望狀態」。
- **`removeAttachment` 改用 `attachmentId`（UUID）**，不再用 url 比對。同一個 url 附兩次會是兩筆不同 id，
  用 url 刪根本指不動；也不會拿 url 假裝成 UUID 送出。找不到的 id 回 `not_found`，不再回假的 `removed:false`。
- **`transitionTicket` 只收動作標籤**（`getTransitions` 回應的 `data.actions[].label`）。
  v1 不收 `toStatus` —— 那是後端驗證用的目標狀態白名單，對外送出只會撞 `invalid_argument`。
  `extraFields` → `fields`。
- **`reassignTicket` 的 `reason` 是必填**，`assigneeId` 只收 UUID（不從顯示名反查）。
- **`convertTicketType`**：參數名 `type`；目標類型只有 `EPIC / REQ / BUG / TASK` —— **IDEA 與 STD 不能當目標**。
- **`addComment`**：內文參數名是 `body`；不夾帶流轉，也不收 `expectedUpdatedAt`。
- **`createTicket` 收全套建單欄位**：`project` 可由 `LTJ_PROJECT` 補；兩者皆無 → `PROJECT_REQUIRED`（不猜專案）。
  18 個選填欄位（見上表）全部直接進建單 body —— **不再要求呼叫端「寫進 description」或「建單後再補」**，
  那會讓資料落在錯的欄位。形狀規則：選填值皆可 `null`（= 明確不設）；
  **選填文字欄位也收空字串**（`module` / `subtype` / `stdLevel2` / `stdLevel3` / `mrUrl` / `reproSteps` /
  `expectedResult` / `fixMethod` / `validationMethod` / `verifiableVersionAlpha` /
  `verifiableVersionRelease` / `description` / `targetVersion` / `foundVersion`）——
  後端 `validateFieldValue` 對選填 TEXT_FIELDS 只驗 `typeof string`，空字串是合法輸入，
  這層要求非空就會把合法建單擋掉。核心 `project` / `type` / `title` 仍必須非空；
  `startDate` / `dueDate` 收 `YYYY-MM-DD`（純日期，且必須是真實存在的日子）；`tags` 收字串陣列；
  `assigneeId` / `ownerId` 收 UUID。`priority` 沿用已知受控值域；`releaseMethod` **不自創 enum**，
  只驗非空字串後原樣轉送，值域由後端裁決（寫死會在後端新增值時把合法輸入擋掉）。
  `targetVersion` / `foundVersion` 在建單是**版本名稱**，不是版本指派端點的 UUID。
  仍拒絕的只有兩類：舊名（`assignee`→`assigneeId`、`owner`→`ownerId`、`version`→兩個版本欄位、
  `verifyMethod`→`validationMethod`、`notes`→併入 `description`），以及本來就不屬於建單的
  `status`（走 `transitionTicket`）、`parentId`（建單後走 `linkTickets`）、`expectedUpdatedAt`（無既有版本可鎖）。

## 傳輸層安全（沿用第一包並補強）

- 單一總 deadline 涵蓋 fetch + 讀 body；`redirect: 'manual'`，3xx 直接拒絕以免 Bearer 外流。
- 網路錯誤 / 非 JSON 回應不轉述原始 message 與 body。API 的 `code` / `message` / `details` 原樣保留。
- 寫入**不自動重試**。
- **204 只在 `emptyBody` 路由放行**（本包唯一一條：刪附件），且必須真的沒有 body；
  關注 `PUT`/`DELETE` 回的是 `{ data }` 信封，收到 204 一律 `invalid_response`；
  其他端點的空 `200` / 意外 `204` 一律 `invalid_response`，不讓空回應悄悄當成功。
  204 成功回給 MCP 呼叫端的是 `{ ok: true, status: 204, noContent: true }` —— 不編造後端沒說過的內容。
- 契約上沒有 body 的寫入路由，多餘參數會被當面拒絕，不靜默吞掉。

## 已知未驗事項

- API v1 原始碼在本工作區外，讀取被權限擋下；以上契約依控制端提供的規格實作。
  `createTicket` 的欄位全集（含 `targetVersion` / `foundVersion` 為版本名稱）、
  `setWatchState` 回 `{ data }` 信封、`removeAttachment` 是唯一的 204 端點 —— 這三項已由控制端向後端核對。
- `releaseMethod` 的實際值域未取得，因此本層不驗 enum，只轉送字串由後端裁決；
  若值不合法會拿到伺服器端 `invalid_argument`（不會靜默寫錯資料）。
- 本包未觸碰 launcher、使用者 config、安裝版 pin 與版號發布。


## 整合者驗證（2026-09-14）

- 完整 `npm test`：123 通過、0 跳過；既有 instructions 長度預算維持不變。
- 啟動真正 MCP server、透過 stdio 呼叫 13 個工具、6 個資源與 4 個提示；19 個本機 HTTP 請求通過。使用假的 Bearer 與本機回應，不是真實 PAT／Google／GCP 驗收。
- 後端原始契約再次核對：核心 `priority`、`description`、`assigneeId` 可省略但不可 null；18 個附加資料欄可 null。文字附加欄與 description 接受空字串，必要核心文字不接受空白。
- `CREATABLE_TICKET_TYPES` 為 EPIC/REQ/BUG/TASK/STD；轉型目標為 EPIC/REQ/BUG/TASK；priority 固定為 P0-緊急/P1-高/P2-中/P3-低。MCP schema 與後端目前常數一致；獨立審查所提未來動態新增值為假設，沒有據此取消現行值域。IDEA 建單已排除。
- 獨立審查沒有發現路由、冪等標頭、204、deadline 或 redirect 的具體阻擋問題。其靜態審查不能代替上述實測。
- 尚餘 5 個寫入工具、真後端 PAT 整合、最終版號／pin／切換與回退驗證；本包不代表整個升級完成。
