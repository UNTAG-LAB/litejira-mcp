# GH-257 第一包：對外 API v1 傳輸層 + CLI 接線

分支 `codex/gh257-v1-upgrade-20260911`，base `a24a2fe`。本包**只**動傳輸層與 CLI，
MCP 的 18 個 tools / 6 個 resources / 4 個 prompts schema 一律不動（下一包）。

## 交付物

| 檔案 | 內容 |
|---|---|
| `litejira-v1-transport.js`（新） | action → REST 映射表、請求組裝、Bearer、Idempotency-Key、逾時/Abort、redirect 封鎖、URL 合法性、錯誤原樣保存 |
| `ltj-cli.js`（改） | 6 個既有指令改走 v1；補 `--project`、UUID 成員條件、`--idempotency-key`、字串型 `--expected-updated-at` |
| `test/gh-257-v1-transport.test.js`（新） | 映射（真 method/path/query）、錯誤狀態、逾時、redirect、URL、CLI 接線；fetch 一律注入，不打真 API |
| `package.json`（改） | `files` 收錄新模組 |

## 已落實的契約行為

- **Base / 認證**：`<origin>/api/v1`，`Authorization: Bearer <pat 明文>`。base URL 已含 `/api/v1` 或帶尾斜線都不會重複串接。
- **錯誤原樣保存**：非 2xx 且形狀為 `{ error: { code, message, details? } }` → 丟 `LiteJiraApiError`，`code/message/details` 一字不改，另附 `status` 供記錄。
  呼叫端一律讀 `code` 分支；`API_ERROR_STATUS` 只當已知碼對照，不用狀態碼反推語意
  （403 底下 `membership_required` / `permission_denied` / `admin_required` 三種互斥語意，測試逐一鎖住）。
  舊契約四碼（`AUTH_FAILED` / `UNKNOWN_ACTION` / `ADMIN_REQUIRED` / `ACTION_FAILED`）在 v1 路徑上完全不出現。
- **Idempotency-Key**：只有寫入方法掛 header，格式 `^[A-Za-z0-9_-]{16,64}$` 本機先驗；GET 即使呼叫端塞了 key 也不掛。
- **逾時**：整趟 20 秒（`DEFAULT_TIMEOUT_MS`），涵蓋 fetch **與**讀取回應內文兩段，逾時 abort 同一個 controller；
  `finally` 清 timer 與外部 signal listener，外部 signal 取消會連動。
- **不跟隨 redirect**：`redirect: 'manual'`，3xx 直接拒絕（`redirect_blocked`），避免 Bearer 被帶去未驗證的目的地。
- **URL 合法性**：正式站只收 `https`；`http` 只放行明確 loopback（`localhost` / `127.0.0.1` / `::1`）。
  拒絕其他協定、內嵌帳密、帶 query/fragment 的 base。
- **成員身分**：`assigneeId` / `ownerId` / `creatorId` / `parentId` 只收 UUID。
  傳顯示名（`--assignee` 等）→ 本機 `invalid_argument` 並指路，**不從姓名猜人**。
- **`expectedUpdatedAt`**：CLI 以字串原樣傳遞，不再 `Number()`（微秒精度掉了會撞出假的 `version_conflict`）。
- **無 legacy fallback、無寫入自動重試**：5xx / 逾時一律直接回報，寫入結果不確定時交由呼叫者以**同一把 key** 重送
  （server 端真去重的驗證留待下一包的真 DB 驗證）。
- **未知 action 本機拒絕**：不推測、不編造路由，且拒絕發生在送出之前（測試斷言 fetch 呼叫次數為 0）。

## 第一包交付範圍

第一包提交 48922e1 已包含 searchTickets、getTicket、listComments、getActivityLog、linkTickets、addComment、attachLink 七條 action 映射；CLI 的 search/show/comments/activity/link/comment（reply 別名）/attach 已接新 API。初稿缺映射的問題已在交付前修正，不能沿用初稿的不可用敘述。

其餘 MCP 工具與資源依後續工作包補齊；本包不代表全部 MCP 升級完成。讀取面後續進度見 pack2-mcp-read.md。

## 驗證

`npm test`（`node --test`，root 執行）。所有測試皆注入假的 `fetch`，不接觸真 API、不讀憑證。

控制端驗證（2026-09-11）：50 項 Node 測試通過，0 跳過；獨立審查完成。控制端另核對 body 的 parentId:null 保留解除關聯語意，不能把 null 一概當無資訊。全部 fetch 為注入測試，未使用真 PAT 或呼叫雲端。這是傳輸／CLI 工作包，MCP schemas/resources/prompts 尚待升級，不代表 P7.14 完成。
