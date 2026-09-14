# GH-257 第四包：最後 5 個工具接上 API v1（18/18 完成）

分支 `codex/gh257-v1-upgrade-20260911`，base `8e1c6ed`（第三包：9 個基本寫入工具）。

本包接上 `updateField`、`replyFeedback`、`batchTransition`、`batchReassign`、`batchSetField`。
第二 / 三包的 13 個工具、6 個 resources、4 個 prompts 全部保留，**tools/list 從 13 變成 18，沒有 pending**。

> `replyFeedback` 是 **client 端複合**，不是新的後端端點：v1 沒有「留言＋流轉」的複合端點，
> 舊 GAS 後端（`Code.js:3153`）也從來不是原子操作。本包照舊的步驟順序做（先可選流轉、再留言），
> 另外補上舊版沒有的三件事：**每步一把穩定且互不相同的冪等鍵**、**流轉失敗就不送留言**、
> **未取得留言成功回應時，保留已完成流轉，並區分明確拒絕與結果未知**。沒有 rollback，也不假裝有。

## 交付物

| 檔案 | 內容 |
|---|---|
| `litejira-v1-transport.js`（改） | 補 7 條路由（`updateTicketField` / `setTicketVersions` / `forceSetStatus` / `batchTransition` / `batchReassign` / `batchSetField` / `batchSetVersions`）；新增 body 驗證種類 `refArray` / `ticketRef` / `atLeastOne` / `fieldsObject`；把單值形狀檢查抽成 `checkBodyValue_`（PATCH 與批次 `fields` 共用同一份規則）；`PENDING_CONTRACT_ACTIONS` 清空，改用 `COMPOSITE_ACTIONS`（`updateField` / `replyFeedback` → `composite_action`） |
| `litejira-mcp-server.js`（改） | 5 個工具接線：`updateField` / `batchSetField` 走 `DISPATCHERS` 依欄位分流、`replyFeedback` 走兩步複合；`validateToolInput` 支援 `legacyValues`（舊**欄位值**指路）；批次參數 `ids` → `tickets`；`assertMigrated_` / `instructions` / prompt 收尾語移除「未接線」說法 |
| `test/gh-257-pack4-mcp-write.test.js`（新） | 本包全部行為：五條分流的真實 method/URL/body、force 閘門、複合步驟順序與衍生鍵、部分成功與「結果不確定」、批次端點與部分成功結果保真 |
| `test/gh-257-pack2-mcp-read.test.js`（改） | tools/list 由 13 → 18；「5 個 pending」改成「沒有工具回 `TOOL_NOT_MIGRATED`」；prompt 斷言改鎖「只提得到真的存在的工具」 |
| `test/gh-257-pack3-mcp-write.test.js`（改） | `replyFeedback` 的 pending 斷言改成 `composite_action` + 「`addComment` 不夾帶流轉」 |
| `test/gh-257-v1-transport.test.js`（改） | `replyFeedback` / `updateField` 由 `unmapped_action` 改 `composite_action` |
| `ltj-cli.js`（改） | `composite_action` 列入本機拒絕碼（exit 2）；標頭註解不再說 MCP 尚未改線 |
| `README.md`（改） | 能力表三個 ⏳ 改成 ✅，並講明批次是部分成功、`replyFeedback` 非原子 |

## 路由契約（本包新增）

| action | method / path | body |
|---|---|---|
| `updateTicketField` | `PATCH /tickets/{ticket}` | `{ [一般欄位]: 值, expectedUpdatedAt? }`（平攤，不收 `reason`） |
| `setTicketVersions` | `PUT /tickets/{ticketId}/versions` | `targetVersionId?`(UUID\|null), `foundVersionId?`(UUID\|null)（**至少一個**）, `reason?`, `expectedUpdatedAt?` |
| `forceSetStatus` | `PUT /tickets/{ticketId}/status` | `status`*, `reason?`, `expectedUpdatedAt?`（**body 沒有 force**） |
| `batchTransition` | `POST /tickets/batch/transitions` | `tickets`*(1-100 參照), `action`*, `reason?`, `fields?` |
| `batchReassign` | `POST /tickets/batch/assignee` | `tickets`*, `assigneeId`*(UUID), `reason`* |
| `batchSetField` | `POST /tickets/batch/fields` | `tickets`*, `fields`*（一般欄位；或 `parentId` **單獨成批**，收工單參照 \| null） |
| `batchSetVersions` | `POST /tickets/batch/versions` | `tickets`*, `targetVersionId?`/`foundVersionId?`（至少一個）, `reason?` |

一般欄位（`NORMAL_FIELDS`，19 個）：`title`, `priority`, `description`, `module`, `subtype`, `releaseMethod`,
`stdLevel2`, `stdLevel3`, `startDate`, `dueDate`, `tags`, `mrUrl`, `reproSteps`, `expectedResult`,
`fixMethod`, `validationMethod`, `verifiableVersionAlpha`, `verifiableVersionRelease`, `ownerId`。

值形狀：`null` ＝ 明確清空（**包含 `priority`**；`title` 除外 —— 後端連空字串都不收）；
`tags` 是 string[]；`ownerId` 是 UUID 或 `null`；日期是 `YYYY-MM-DD`；
文字欄位接受空字串（`title` 除外；`priority` / `releaseMethod` 是受控值，也不收空字串）。

批次一律**沒有樂觀鎖**（每張工單的 `updatedAt` 不同，單一 `expectedUpdatedAt` 對不上任何一張），
帶了會被本機擋下。寫入仍必帶 `Idempotency-Key`（header，`^[A-Za-z0-9_-]{16,64}$`，**永遠不進 body**）。

## `updateField`：一個工具、五條路

| field | 走哪條 | 額外規則 |
|---|---|---|
| 19 個一般欄位 | `PATCH /tickets/{ref}` | **不收 `reason`**（此端點不記異動原因），帶了當面拒絕 |
| `parentId` | `PUT /parent` | 只收**父工單 UUID** 或 `null`；不收 `reason` |
| `assigneeId` | `PUT /assignee` | **`reason` 必填**；`null` 不可（這條路不能清空處理人） |
| `targetVersion` / `foundVersion` | `PUT /versions` | 值是**版本 UUID**（不是版本名稱）；`reason` 可帶，值真的改變時後端會要求 |
| `status` | `PUT /status` | **必須 `force=true`**，否則本機拒絕並指路 `transitionTicket` |

舊欄位名一律指路，不回籠統的型別錯誤：
`verifyMethod`→`validationMethod`、`owner`→`ownerId`、`assignee`→`assigneeId`、
`version`→`targetVersion` / `foundVersion`（且值改收 UUID）。
**`notes` 在 v1 沒有等價欄位**：明確拒絕並請呼叫端改寫進 `description` ——
本層不代為搬運（那會覆蓋既有描述，等於安靜吃掉使用者的字）。

`force` 的界線：它只是「走哪條路」的**本機閘門**，永遠不進 body；
只有 `field=status` 能帶；繞過的是工作流**路徑**驗證，**不放寬欄位必填**（送測三欄照樣要填），
而且真正決定放不放行的是伺服器（非 admin 一樣會被拒）。

`value` 刻意**不列進 schema 的 `required`** —— `required` 檢查會把合法的空字串當成缺值；
改在分流時檢查「有沒有 value 這個鍵」，所以 `""` 收得下、完全沒帶則明確報錯（不把「沒帶」當成清空）。

## `replyFeedback`：步驟、鍵、與部分成功

1. 有 `transition` → 先 `POST /transitions`（`action` 是**動作標籤**，不收 `toStatus`）。
2. 再 `POST /comments`（`content` → body 的 `body`）。
3. 每步的冪等鍵 = `sha256('litejira.replyFeedback/' + 你的 idempotencyKey + '/' + 步驟名)` 的
   base64url 前 43 字元。**同輸入同鍵**（重送時可被 server 去重）、**兩步不同鍵**
   （同一把 key 配不同 body 會被判 `idempotency_key_reused`），且都不是原本那一把。

失敗處理（**不重試**）：

- 流轉失敗 → **留言一發都不送**，回流轉的原始錯誤，`partial.completed = []`。
- 留言失敗 → `isError` 結果，`partial.completed = ['transition']`、`failedStep = 'comment'`，
  附**原始錯誤**與已完成步驟的鍵。訊息明講「流轉已經生效」，不編造 rollback。
- `failedStepApplied`：連線層失敗（`timeout` / `network_error` / `invalid_response`）或後端 5xx → `unknown`；
  一般 4xx 明確拒絕 → `no`（伺服器已知回復原狀）。

### `idempotency_key_reused`（409）的兩種成因

後端把成因放在 `error.details.reason`，善後完全不同，**不可合併成同一句「沒有生效」**：

| `details.reason` | `failedStepApplied` | `priorAttemptApplied` | 善後 |
|---|---|---|---|
| `in_progress` | `unknown` | `unknown` | 同一把 key 的前一次請求還在跑，這一步是否已生效**未知**。**不要換新 key、不要改輸入**；先讀當前狀態，要重送就用**完全相同的輸入＋同一把 key**，且必須在保留期內。 |
| `request_mismatch` | `no`（指這份內容） | `unknown` | 這份內容被拒（未受理），但**前一次用這把 key 的操作結果並未被證明**。不要重送同一份被拒內容，也**不要換新 key 把整個複合呼叫重跑**（先前的流轉可能已生效）。先讀狀態與已完成步驟，只續做確實還沒做的那一步。 |

後端沒給 `reason`（或給了沒見過的值）時，一律當成最保守的 `unknown`。

### 冪等不是「永遠可安全重放」

去重只在伺服器的 **24 小時保留期**內、且**輸入完全相同**時成立；過了保留期，同一把 key 會被當成
全新請求真的再做一次。因此工具說明、`instructions`、README 與失敗訊息一律**不承諾無限期 exactly-once**：
結果不明（5xx / 連線失敗 / `in_progress`）時的指示是「不自動重試 → 先讀當前狀態 → 要重送就在保留期內
用同一把 key ＋相同輸入」。若必須改動內容，要保留已完成步驟、**明確只補缺的那一步**，而不是無條件
「換一把新 key 重跑整串」。
- 沒有 `transition` 時不接受 `expectedUpdatedAt`（留言端點沒有樂觀鎖，這個值無處可送）。

## 批次：部分成功是常態

三個批次端點都回 `{ succeeded: [{ ticket, id, key, status, assignee }], failed: [{ ticket, error: { code, message, details? } }] }`，
**HTTP 200 也可能有 failed**。MCP 把 `data` 原樣轉出：
`succeeded` / `failed` **不改名**（舊工具的 `success` 已不存在），也不因為有 failed 就整包改判 `isError` ——
那是後端真的回的形狀，改寫只會讓呼叫端看到不存在的東西。工具說明與 instructions 都明講
「200 不代表全成功，務必回報 failed」。

批次權限（`can_batch`）與逐張權限由伺服器裁決；被拒就是被拒，**不得改用 N 次單張寫入繞過**。
`ids` → `tickets`（1-100 個工單參照，UUID / 公開 key / 數字 key 皆可），舊名帶了會指路。
`batchSetField` 的 `parentId` 收的是**工單參照**（與單張的 `PUT /parent` 只收 UUID 不同 —— 這是契約差異）。

## 沒有做的事

- 沒有為了「湊原子性」而自創後端端點或假裝有交易語意。
- 沒有把 `updateField` 做成萬用端點的假象：`reason` / `force` 在哪條路能帶就只在那條路能帶。
- 沒有動 `package.json` 的版本號 / 發佈設定（本包不含版本決策）。
- 沒有做大規模傳輸層重構：只在既有 `buildBody` 裡把單值檢查抽成共用函式，行為維持不變。

## 本機驗證與限制

指揮實跑 `npm test`：173 項通過、0 跳過。另啟動真正 MCP stdio 子程序、HTTP API 與一次性 PostgreSQL，使用資料庫查驗的本機 PAT，驗證全部 18 工具、6 資源、4 提示。涵蓋留言加流轉同鍵重播只一筆留言、管理者改狀態、UUID 版本指派與 null 清空、批次部分成功。此為本機整合，沒有使用 Google、GCP 或真正對外寄送。

獨立 Sonnet 審查未發現包內阻擋；其跨工作樹 Read 權限被拒，因此只驗 MCP 內部契約，未獨立核對後端。指揮另讀後端 `idempotency-gate.ts` 的 reason 分支並核對本機真後端結果，沒有把包內自洽當跨庫證據。指揮補正文字訊息：連線中斷時只能說未取得留言成功回應，不能聲稱留言沒送成；已有回歸斷言與 173 項重驗。

未推送、未發布套件、未替換使用者安裝版或主庫 pin；整體切換、Google／正式 PAT 與雲端驗收仍待後續操作包。