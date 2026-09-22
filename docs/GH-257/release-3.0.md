# litejira-mcp 3.0.0 發版準備（GH-257 收尾 ＋ GH-313 契約漂移）

分支 `codex/gh257-v2-release-20260922`，base `3443fbe`（第四包：18 個工具全部接上 API v1）。

> **狀態：準備完成，尚未發布。**
> 本文件記錄候選與驗證範圍；公開發布仍待確認。
> npm publish、git tag、GitHub release **都還沒有做**，本包也沒有執行任何一項。
> 對正式站的驗收只涵蓋**唯讀**路徑（見下「已驗 / 未驗」），**寫入未做全雲端驗收**。

## 為什麼是 3.0.0（主版號跳號）

破壞性的是**傳輸契約**，不是某個工具的參數：

| | 2.x | 3.0 |
|---|---|---|
| 後端 | Google Apps Script 單一 `POST /exec` | LiteJira 2.0 REST `/api/v1`，逐動作一條路由 |
| 認證 | 權杖放在 request body | `Authorization: Bearer` 標頭 |
| 錯誤 | 四個碼（`AUTH_FAILED` / `UNKNOWN_ACTION` / `ADMIN_REQUIRED` / `ACTION_FAILED`） | 十一個碼 ＋ HTTP 狀態碼 |
| 冪等 | 客戶端約定，伺服器不去重 | 伺服器真的去重（`Idempotency-Key` 標頭，24h 保留期） |
| 身分 | 只有 `BUG-481`；成員收顯示名 | UUID 主鍵 ＋ 公開 key；成員**只收 UUID** |

同一支 MCP **不可能同時服務兩套後端**（權限模型不同、錯誤語意不同），所以本版
**沒有 legacy fallback**，指向舊後端會得到 `invalid_response` 而不是悄悄降級。
權杖沿用既有 `ltj_pat_`，升級只要改 `LTJ_API_URL` ＋ 加 `LTJ_PROJECT`。

## 本包修掉的真契約漂移（GH-313）

對照來源：上游後端 worktree `_wt-gh257-cloudsql-import`（HEAD `1c46c0b2`，實際 prod source `3aca1a48`）的
`v2/server/src/api/v1/**` 與 `v2/contracts/src/**`。

### 1. searchTickets 的專案是必填的（主控實測命中的那一項）

**後端事實**：`v2/server/src/api/v1/queries/tickets.ts` 的 `applyScope`（R-A15 一／三／四）

```
| 帶了什麼   | 範圍                                              |
| 專案       | 那一個專案（先驗操作者看得見它）                  |
| 「我的」   | 全部可見專案，再以身分收斂（唯一天然跨專案的維度）|
| 兩個都帶   | 那個專案裡我的那些（縮小，不放寬）                |
| 都沒帶     | 422 invalid_argument —— 不是回全部，也不是回空    |
```
跨專案（只帶 `mine`）時**一般篩選一律被拒**（`generalFilterKeys`，R-A15 四），不是被忽略。

**漂移**：MCP 的 `project` 參數說明寫「兩者皆無則不帶此條件（跨專案搜尋）」，
而 `toV1Params_` 真的就不帶條件送出去。那個模式從來沒有成立過：伺服器一律 422，
呼叫端拿到一句看不懂的伺服器錯誤，而說明還告訴它這樣是對的。

**修法**
- `project` 描述與工具描述改成「必填」，並寫明唯一跨專案入口是 `mine`。
- 新增 `mine` 參數（`assignee` / `creator` / `watcher`，值域取自後端 `MINE_DIMS`）。
- 缺專案且缺 `LTJ_PROJECT` 且沒帶 `mine` → **本機 `PROJECT_REQUIRED`，一發都不送**，訊息指出該補什麼。
- 傳輸層 `searchTickets` 路由加 `query.scope`：同一道守門在傳輸層再守一次，
  繞過工具層直接叫 action 也擋得住（與後端「守門放在碰 SQL 那一層」同一個判準）。
- 跨專案時帶一般篩選 → 本機拒絕並列出衝突的條件；排序與分頁不算一般篩選，照樣可帶。
- **只帶 `mine` 時不套用 `LTJ_PROJECT` 預設**：呼叫端要的是「我的全部」，
  偷偷收斂成一個專案會回一份比要求更窄的清單，而回應裡看不出少了什麼。

### 2. sort 值域少了 12 欄（客戶端誤擋合法輸入）

**後端事實**：`v2/contracts/src/ticket-fields.ts:29-67`——可排序欄位由 `TICKET_FIELDS` 的
`sortable` 旗標推導，共 **15 欄**：
`updatedAt, createdAt, key, type, title, status, priority, assignee, owner, creator, module,
targetVersion, foundVersion, startDate, dueDate`。

**漂移**：傳輸層的 `SORT_VALUES` 只寫了前三個，且註解稱「舊的 priority / dueDate 不在契約內」——
那是漏抄，不是契約。後果是 `sort=priority`、`sort=dueDate` 在**客戶端**就被擋掉，
呼叫端得到「這個客戶端說不行」而伺服器其實收。

**修法**：補齊 15 欄。登錄表標為 `sortable: false` 的（`id` / `tags` / `parent` / `stateGroup` /
`subtype` / `watchers`）仍然擋下——那些送出去會 422。

### 3. 前進流轉「main不受影響」也必填 reason（#313）

**後端事實**：`v2/server/src/api/v1/queries/ticket-writes.ts:985-997`
```js
const needsReason = action.direction === 'back' || action.label === REASON_REQUIRED_FORWARD;
```
`REASON_REQUIRED_FORWARD = 'main不受影響'`（GH-228 的熱修旁路，稽核要看到「為什麼 main 不受影響」）。

**漂移**：`transitionTicket` / `batchTransition` / `replyFeedback` 的說明一律只講
「退回類動作要帶 reason，前進類可省略」。助手照著做，在熱修回 main 那一步會漏帶而撞 422。

**修法**：三個工具的描述與 `reason` 欄位說明、啟動 `instructions`、`close-ticket` 提示
一併補上這個例外。**不在客戶端複製一份動作方向表**——「這個標籤是不是 back」是資料相關的判定，
複製的那一份一定會過時；本層只負責把說明講對。

### 檢查過、確認**沒有**漂移的項目

| 項目 | 後端事實源 | 結論 |
|---|---|---|
| `limit` 1-100、預設 50 | `routes/params.ts` `DEFAULT_LIMIT/MAX_LIMIT` | 一致 |
| `order` = asc/desc | `read-queries.ts` `SORT_ORDERS` | 一致 |
| 列舉篩選 12 維 | `read-queries.ts` `ENUM_FILTER_DIMS` | MCP 全部支援，名稱逐字相同 |
| 成員 / 母單只收 UUID | `routes/ticket-filter.ts` `parseUuidList` | 一致（本機先擋，訊息指路） |
| `/members` 不吃 `project` | `routes/catalog.ts:55-64` | 一致（MCP 明確拒絕 `project`） |
| `/meta` `/workflow` `/versions` `project` 必填 | `routes/catalog.ts` `requireProjectKey` | 一致 |
| `/stats` 的 scope 互斥 | 傳輸層 `exclusive` | 一致 |
| 流轉只收動作標籤、不收 `toStatus` | `routes/ticket-bodies.ts` `TRANSITION_BODY_FIELDS` | 一致 |
| 轉派 `reason` 必填 | `REASSIGN_BODY_FIELDS` ＋ 寫入層 | 一致 |
| 批次上限 100、無樂觀鎖、部分成功 | 批次路由 | 一致 |
| 附件只有 `{ url, name? }`、以 id 刪除、204 | 附件路由 | 一致 |

### 已知落差（前一輪列為「不在本包範圍」，本輪補齊）

後端 P4.2d／P5.6 把工單篩選擴成完整的查詢面，MCP 原本只接「是」那一組 ＋ `q`。
那是**能力缺口而不是契約違反**（白名單會當面拒絕，不存在「以為濾到了其實沒濾」），
但呼叫端也**用不到**：助手看不到參數、傳輸層擋下、CLI 沒有旗標。

**本輪補齊的能力**（欄位數由維度 × 運算子推導，不抄文件上的數字）：

| 來源 | 維度 | 運算子 | 欄位數 |
|---|---|---|---|
| `read-queries.ts` `ENUM_FILTER_DIMS` | 12（`type` / `status` / `statusGroup` / `priority` / `module` / `subtype` / `targetVersion` / `foundVersion` / `assigneeId` / `creatorId` / `ownerId` / `parentId`） | `X` / `XNot` | 24 |
| `read-queries.ts` `TEXT_FILTER_DIMS` | 2（`title` / `description`） | `X` / `XNot` / `XContains` / `XNotContains` | 8 |
| `routes/ticket-filter.ts` | `overdue`（布林，只認 `true`/`false`） | — | 1 |
| `routes/ticket-filter.ts` `TICKET_ID_FILTER_MAX` | `id`（UUID，一次最多 50 張） | — | 1 |

另補：**所有**列舉維度都是多值（後端 `multiParam`），包含原本只收單值的四個 UUID 維度。

**做法**
- 傳輸層放**維度登錄表**（`ENUM_FILTER_DIMS` / `TEXT_FILTER_DIMS` ＋ 兩張運算子表），
  白名單、多值表、UUID 表、CLI 旗標、工具 schema **全部由它推導**。
  三十幾列的欄位名抄第二份時，漏掉其中一列不會有任何症狀——這與後端用
  `Record<EnumFilterDim, …>` 完整映射的理由是同一條。
- 範圍守門**沿用原樣**：新參數全部落在「一般篩選」那一側，所以跨專案（只帶 `mine`）時
  一項都繞不過 R-A15 四。守門的白名單是「排序與分頁」，不是「篩選的黑名單」——
  加維度不必改守門，這一點有逐欄的回歸測試釘住。
- `id` 的上界（50）與 `overdue` 的布林在**本機先擋**，錯誤訊息講出上限與合法值；
  超過上限不截斷成前 50 個（截斷會回一份比要求更窄的清單而看不出少了什麼）。
- 文字條件的空字串**當面拒絕**：後端會把 `?titleContains=` 靜默當成「沒有指定」，
  本層擋下才講得出「你這個條件沒有生效」。

## 與 GH-303（舊 GAS 傳輸韌性修正）的對照

`origin/main` 的 `d90cfc2` 含 GH-303，針對的是 **Apps Script 兩段式回應**的失敗模式
（`POST /exec` 執行完回 302 → 第二段 `GET script.googleusercontent` 取結果）。
那些程式碼**不可以搬回新 REST 傳輸**——新後端根本沒有第二段。
但 GH-303 當時建立的**安全約束**必須保留其效果。逐條對照：

| GH-303 的約束（舊 `ltj-cli.js`） | 新 REST 傳輸的對應 | 判定 |
|---|---|---|
| 續跳上限 3 跳 ＋ 307/308 只在**同源**才續跳（否則 Bearer 送到第三方） | `redirect: 'manual'` ＋ 任何 3xx 直接 `redirect_blocked` 拒絕（`litejira-v1-transport.js`） | **效果更強**：一跳都不跟，Authorization 不可能送到重導目的地 |
| `resolveUrl_`：`Location` 一律先對基準網址解析，免得把等同臨時憑證的查詢字串寫進例外訊息 | 完全不解析 `Location`；另外 `normalizeBaseUrl` 拒絕內嵌帳密、拒絕 base 帶 query/fragment、非 loopback 一律要 https | **已涵蓋**（且多擋了 base URL 這一類） |
| `sanitizeErrorBody_` / `summarizeBody_`：回應內容以黑名單脫敏後只取 `<title>` | 回應內容**一律不轉述**（`invalid_response` 固定文案）；`network_error` 也不轉述 `err.message` | **效果更強**：黑名單脫敏認不出 `<input value=…>` 這類形狀，不轉述沒有這個問題 |
| 寫入不重發第一段（指令碼已執行，重發會生效兩次） | 傳輸層**不做任何自動重試**；寫入強制帶 `Idempotency-Key`，由伺服器真的去重（24h 保留期） | **效果保留且升級**：舊版只能「不重試」，新版可在保留期內安全重送 |
| 第二段 8 秒逾時、第一段**不設**逾時（中止不會讓已執行的寫入復原） | 整趟 20 秒 deadline，讀寫都適用 | **形式不同、處置對等**：寫入逾時＝結果未知，由 `Idempotency-Key` ＋「不盲目重試、先讀狀態」的工具說明與 `instructions` 接手 |

**結論：不需要從 `d90cfc2` 搬任何程式碼過來。** 本包也沒有 merge `origin/main`。
若之後要合併 `origin/main`，`ltj-cli.js` 與傳輸層的衝突一律以新 REST 版本為準。

## 變更清單

| 檔案 | 動作 | 內容 |
|---|---|---|
| `ltj-cli.js`／`test/gh-257-cli-scope.test.js` | 改／新 | 移除舊 GAS 匯出、補 CLI 範圍規則與兩項回歸 |
| `package.json` | 改 | `2.11.0` → `3.0.0`；描述改「LiteJira 2.0 … REST API v1」；加 `npm run smoke`；`files` 納入 smoke 腳本 |
| `litejira-v1-transport.js` | 改 | `SORT_VALUES` 補成契約的 15 欄；新增 `MINE_VALUES` 並匯出；`searchTickets` 路由加 `mine` 與 `query.scope`；`buildQuery` 實作範圍守門 |
| `litejira-mcp-server.js` | 改 | searchTickets 的描述 / `project` / 新 `mine` 參數；`toV1Params_` 的 `projectAlternative` 與「跨專案不套預設專案」；三個流轉工具的 reason 說明；`instructions` 與 `weekly-status` / `close-ticket` 提示 |
| `litejira-v1-transport.js`（搜尋能力） | 改 | 維度登錄表 ＋ `searchTickets` 白名單／多值／UUID／`bool`／`maxValues` 全面推導 |
| `litejira-mcp-server.js`（搜尋能力） | 改 | 工具 schema 由登錄表產生 32 個運算子欄 ＋ `overdue` / `id`；工具說明與 `instructions` |
| `ltj-cli.js`（搜尋能力） | 改 | 篩選旗標由登錄表推導（`--status-not`、`--title-contains`…）、`--overdue`、`--id`、用法說明 |
| `test/gh-257-search-filter-ops.test.js` | 新 | 20 項：登錄表對照後端、query mapping 三方一致、逐欄正例、六組反例、跨專案逐欄負面靶 |
| `test/gh-313-contract-drift.test.js` | 新 | 13 項：三個靶的正反例（含「說明不得再宣稱跨專案搜尋」這種會回歸的措辭斷言） |
| `test/gh-313-stdio-smoke.test.js` | 新 | 3 項：真 spawn stdio ＋ 本機 stub，覆蓋 4 讀取工具 / 6 資源 / 4 提示；寫入被擋；smoke 腳本自身可用 |
| `scripts/smoke-stdio-readonly.cjs` | 新／改 | 對真伺服器跑的唯讀 stdio smoke（憑證只從環境變數讀、不印出；子行程強制 `LTJ_MCP_ENABLE_WRITES=false`）；本輪多一步「伺服器收不收 `statusNot` / `titleContains` / `overdue`」，故正式站下次跑是 20 步而非 19 步 |
| `test/gh-257-pack2-mcp-read.test.js` | 改 | 四項舊斷言改成真契約（缺專案＝本機擋下、sort 值域 15 欄） |
| `test/gh-257-v1-transport.test.js` | 改 | 通用 fixture 補 `project`（它們測的是傳輸機制，不是範圍守門） |
| `README.md` | 改 | 新增「3.0 是 LiteJira 2.0 專用」對照表；正式 URL；權杖沿用；`LTJ_PROJECT` 取得方式與必填；寫入未知不可盲重試；唯讀 smoke 用法；四條新的故障排除 |
| `docs/GH-257/release-3.0.md` | 新 | 本文件 |

## 驗證（2026-09-22 最終）

- 主控與獨立 Sonnet 均實跑 `node --test`：191/191 通過，0 跳過，退出碼 0。基準為 173 項，本輪增加 18 項。
- 主控真 stdio＋HTTP＋最新後端＋一次性 PostgreSQL／DB-backed 測試 PAT：18 工具、6 資源、4 提示全過；含複合流轉留言同鍵重播只有一筆留言、批次部分成功、版本 UUID 指派與 null 清空。
- 已安裝 tarball 對正式站的唯讀 stdio：19/19 過，含 4 個讀取工具、6 資源、4 提示、握手／清單與寫入關閉守門。握手版號為 3.0.0，既有正式 PAT 可沿用。
- 正式唯讀加驗：`mine=assignee`、`sort=priority`、`sort=dueDate` 全成功。
- 隔離突變移除 CLI 預設專案接線，對應測試轉紅；还原後轉綠。
- 安全審查採納：移除 `ltj-cli.js` 遺留的 `postLiteJiraApi` 與脫敏函式，避免匯出仍會自動轉送 body token 的 GAS 通道。另補 CLI `LTJ_PROJECT` 預設與 `--mine`，跨專案不套用預設專案；`test/gh-257-cli-scope.test.js` 兩項回歸。
- 最終獨立審查無功能阻擋；採納文件測試數／變更清單過期的提醒並修正。
- 搜尋能力補齊後重跑 `node --test`：**211/211 通過，0 跳過，退出碼 0**（前一輪 191 項 ＋ 本輪 20 項）。
  隔離突變：把 `TEXT_FILTER_OPS` 拿掉 `NotContains`，登錄表對照／運算子存在性／文字複合三項轉紅；還原後轉綠。
- ⚠️ **新篩選尚未對真後端驗收**：本輪全部是注入假 fetch 的本機驗證。
  正式站唯讀加驗待主控執行（見下「未完成與限制」）。

## 未完成與限制

正式工單沒有寫入；本機真資料庫寫入不能冒稱正式雲端寫入。24 小時冪等保留期未等待實測；完整正式寫入驗收須另有測試工單授權。

本輪補齊的搜尋運算子只有本機驗證，**需要主控對正式站補跑唯讀驗收**（一發都不寫入）：
`statusNot`（要撈得到該欄為空的單）、`assigneeIdNot`（未指派也要在內）、
`titleContains` / `descriptionNotContains`、`overdue=true` 與 `overdue=false`（後者要含沒填到期日的單）、
`id` 指名一張與指名 50 張、同一維度多值＝聯集／跨維度＝交集各一例、
以及負面靶：只帶 `mine` ＋ `statusNot`（本機就該擋、伺服器同樣拒絕）、`overdue=yes`、`id=BUG-481`、51 個 `id`。
重點是確認**伺服器真的照這些條件收斂**，而不只是「HTTP 200」——本機測試證明得了形狀，證明不了語意。

npm publish、Git tag 與遠端整合尚未執行。P7.14／P4.12 尚不標全數完成。主庫背景 worker 的 pin 保留，另待 P7.15 消費端改版；不能只改 pin 造成舊 GAS 呼叫者失效。DEV 既有本機 PAT 對 2.0 回 unauthenticated，未挪用正式 PAT。

## 舊主線整合

已將 origin/main d90cfc2 納入本機升級分支的合併歷史。衝突採用已驗證的 REST 實作與 3.0.0 版號；舊 GAS 兩段取結果的 postLiteJiraApi 已退役，專測該函式的 gh-303-transport-resilience.test.js 隨之退役（歷史仍保留在 d90cfc2）。其安全要求由現行傳輸測試覆蓋：禁止轉址、固定錯誤訊息、整趟期限、寫入不重送與結果未知提示；沒有把舊 GAS 重試邏輯帶進新版。此為本機整合，尚未推送遠端。

## 搜尋補齊最終驗收（2026-09-22）

32 個運算子欄、overdue、id（最多50個UUID）及成員多值已提供MCP與CLI。主控與獨立Sonnet均211/211通過；主控以真stdio/HTTP/一次性PostgreSQL驗證文字等於/不等於/包含/不包含、類型排除、空負責人被Not保留、50個id、逾期true/false及跨專案範圍拒絕，原18工具6資源4提示回歸通過。多值否定按整個集合排除，文件已明說。

更新的3.0.0候選已打包並安裝本機；實際安裝包對正式站唯讀20/20通過。正式寫入仍未驗，公開Git/npm/tag/Release依使用者「先不發布」不執行。既有MCP程序需重啟才載入新schema。
