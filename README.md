# litejira-mcp

讓你的 AI 助手（Claude Code / Cursor / ChatGPT Desktop）直接讀寫 LiteJira 工單系統。

這是一個 **MCP server**（純客戶端包裝）。它只負責「怎麼跟 LiteJira API 對話」，不含任何工單資料、後端邏輯或祕密——就像 `chrome-devtools-mcp` 不含 Chrome 的原始碼。你的存取權杖只存在你自己電腦上。

---

## ⚠️ 3.0 是 LiteJira 2.0 專用（破壞性改版）

**3.x 只能連 LiteJira 2.0 的對外 REST API v1，不能連舊的 Apps Script 後端。**
舊後端只有一個 POST 端點、權杖放在 request body 裡；2.0 是一整套 REST 路由 ＋ `Authorization: Bearer`。
兩者的權限模型與錯誤碼都不同，本版**沒有也不會有 fallback**：指向舊後端只會拿到一堆 `invalid_response`。

| | 2.x（舊） | 3.0（本版） |
|---|---|---|
| 後端 | Google Apps Script `/exec` | LiteJira 2.0 REST `/api/v1` |
| `LTJ_API_URL` | Apps Script 部署網址 | **`https://litejira.untaglab.com`** |
| 權杖 | 同一把 `ltj_pat_` | **同一把，不用換** |
| 送法 | POST body 裡的欄位 | `Authorization: Bearer` 標頭 |
| 冪等 | 只是客戶端約定，伺服器不去重 | 伺服器真的去重（`Idempotency-Key` 標頭，24 小時保留期） |
| 工單識別 | 只有 `BUG-481` | UUID 主鍵 ＋ 公開 key，兩者都收 |
| 成員條件 | 收顯示名 | **只收 UUID**（先讀 `litejira://members`） |

**升級只要做兩件事**：把 `LTJ_API_URL` 換成 `https://litejira.untaglab.com`、加一行 `LTJ_PROJECT`（見下）。
權杖沿用既有的 `ltj_pat_`，不必重辦。

---

## 安裝（一句指令）

> 前提：Node.js 18 以上。

**推薦：全域安裝**（更新最穩，避開 `npx` 快取與多開 session 兩個已知坑）

```bash
npm install -g litejira-mcp
claude mcp add litejira --scope user -- litejira-mcp
```

**快速：用 npx**（免全域安裝，但多開 session 偶爾連不上、更新需清快取）

```bash
claude mcp add litejira --scope user -- npx -y litejira-mcp@latest
```

裝完設定一次權杖（見下），重啟 AI 工具即可用。

---

## 更新（一句指令）

全域安裝者：

```bash
npm update -g litejira-mcp
```

然後完全關閉並重新打開你的 AI 工具。沒有手動拉檔、不用清快取。

> npx 安裝者：`npx` 會快取舊版，重啟未必更新到最新；請將啟動指令固定為 `npx -y litejira-mcp@3.0.0` 後重啟，或改用上面的全域安裝。

---

## 設定權杖（一次性）

1. 找 admin 在 LiteJira webapp「設定 → Token」幫你建一把 PAT（`ltj_pat_xxxxx`）。
   **從 2.x 升上來的人不用換權杖**，原本那把繼續用。
2. 在你電腦的家目錄建檔 `~/.litejira/credentials.env`：

**Mac / Linux**
```bash
mkdir -p ~/.litejira
cat > ~/.litejira/credentials.env << 'EOF'
LTJ_API_URL=https://litejira.untaglab.com
LTJ_API_TOKEN=<貼你的 ltj_pat_ 權杖>
LTJ_PROJECT=<你的專案 key>
LTJ_MCP_ENABLE_WRITES=true
EOF
```

**Windows（PowerShell）**
```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.litejira"
@"
LTJ_API_URL=https://litejira.untaglab.com
LTJ_API_TOKEN=<貼你的 ltj_pat_ 權杖>
LTJ_PROJECT=<你的專案 key>
LTJ_MCP_ENABLE_WRITES=true
"@ | Set-Content "$env:USERPROFILE\.litejira\credentials.env"
```

> `LTJ_API_URL` 是正式站 `https://litejira.untaglab.com`（自架另一套的人才需要改）。
> 只接受 `https://`，唯一例外是本機 loopback 的 `http://localhost`（開發用）。
>
> 可選：`LTJ_MCP_MAX_UPLOAD_BYTES=<位元組>` 調整附件上傳上限（預設 25 MiB，天花板 100 MiB）。
> 不設就用預設；設成範圍外的值會在啟動時明確報錯，不會靜默退回預設。
>
> 權杖只存在你電腦上、不進 git。離職或不用了，找 admin 在 webapp 撤銷。

---

## 測試

跟 AI 說：「用 LiteJira 搜尋最新的 BUG」。看到工單列表 = 成功。

要更確定一點（**唯讀，不會寫到任何東西**），對你自己那台跑一遍連線檢查：

```bash
LTJ_API_URL=https://litejira.untaglab.com \
LTJ_API_TOKEN=<你的權杖> \
LTJ_PROJECT=<你的專案 key> \
  node scripts/smoke-stdio-readonly.cjs
```

它會用真正的 stdio 通道跑一遍握手、18 個工具的清單、6 個資源、4 個提示與 4 個讀取工具，
逐項印出 ✔ / ✖，全過回 exit 0。腳本本身不含也不寫入任何憑證，只從環境變數讀，而且不把權杖印出來。

## 進階：dev / prod 雙環境（維護者用）

一般使用者忽略本段。若你要同時連正式與測試兩套 LiteJira，啟動器接受一個環境參數：

| 指令 | 讀哪個 credentials |
|------|-------------------|
| `litejira-mcp` | `~/.litejira/credentials.env`（預設） |
| `litejira-mcp dev` | `~/.litejira/credentials.dev.txt`（找不到再試 `.dev.env`） |
| `litejira-mcp prod` | `~/.litejira/credentials.prod.txt`（找不到再試 `.prod.env`） |

`.mcp.json` 範例（兩條並存）：
```json
"litejira":     { "command": "litejira-mcp", "args": ["prod"] },
"litejira-dev": { "command": "litejira-mcp", "args": ["dev"] }
```

---

## 設定預設專案 `LTJ_PROJECT`（3.0 起幾乎是必填）

LiteJira 2.0 的**工單查詢、元資料、版本、統計、工作流都是專案層級**的：沒有專案範圍，伺服器一律回
「請指定專案」而不是回全部。在 credentials 檔加一行就不用每次指定：

```
LTJ_PROJECT=<你的專案 key>
```

**專案 key 去哪裡拿**：LiteJira webapp 的「專案設定」頁上就寫著（也是網址上那一段）。
不確定就問 admin；本版**不會**自動挑一個專案給你——猜錯會安靜回錯專案的資料，比報錯危險得多。

臨時換專案：資源帶 `?project=OTHER`（例 `litejira://meta?project=OTHER`），工具帶 `project` 參數。

> 「不帶專案就是搜尋全部」**不存在**（2.x 的說明曾這樣寫，是錯的）。
> 唯一能跨專案的查詢是「我的」：搜尋時帶 `mine=assignee|creator|watcher`，
> 而跨專案時伺服器**不接受任何其他篩選條件**（要篩選就得指定專案）。

`LTJ_PROJECT` 不是祕密，只是一個專案代號。

---

## 能做什麼

> ✅ **本版連的是 LiteJira 2.0 的對外 REST API v1**：讀取與寫入全部切換完成，18 個工具都能用。
> 三件要知道的事：
> 1. **批量操作是「部分成功」的**：一次處理 N 張，伺服器會回「成功哪幾張、失敗哪幾張」，
>    整體回應成功不代表每張都改到了。AI 應該把失敗清單如實講給你聽。
> 2. **「留言＋改狀態」一次做（replyFeedback）不是原子操作**（舊版也不是）：
>    先改狀態、再留言，中途失敗會停在半路，而且**不會自動還原**。
>    AI 會明講哪一步成了、哪一步沒成。
> 3. **寫入結果不明時不要盲目重送**。本版不做任何自動重試：逾時、連線中斷、5xx、
>    以及 `idempotency_key_reused`（`details.reason=in_progress`）都代表「這一步有沒有生效未知」。
>    正確做法是**先讀工單當前狀態**，確認到底做了沒；真要重送，必須在伺服器的 **24 小時冪等保留期內、
>    用同一把 idempotencyKey ＋一模一樣的輸入**。換一把新 key 或過了保留期，重送一定會再做一次。
>    絕對不要為了「繞開」錯誤而換新 key 把整串重跑。
>
> 寫入另外需要在 `credentials.env` 設 `LTJ_MCP_ENABLE_WRITES=true`，否則一律擋下。

| 你說 | AI 會做 | 本版 |
|------|--------|------|
| 「搜尋 login 相關的工單」 | 搜尋篩選 | ✅（在 `LTJ_PROJECT` 這個專案裡；跨專案只支援「我的」） |
| 「找標題有『閃退』、但狀態不是已關閉、而且逾期的單」 | 「不是」＋「包含」＋逾期複合篩選 | ✅（見下「搜尋能篩到多細」） |
| 「列出我手上／我建的／我關注的單」 | 跨專案的「我的」查詢 | ✅（此時不能再加其他篩選條件） |
| 「查 BUG-530 完整內容」 | 讀工單詳情 | ✅ |
| 「BUG-530 的留言和歷程給我看」 | 讀留言 / 時間軸 | ✅ |
| 「BUG-530 現在能做哪些動作」 | 查可用流轉動作 | ✅ |
| 「這季的進度統計」 | 讀 dashboard / 版本 / 成員 | ✅ |
| 「建一張 P1 BUG 給思源」 | 建立新工單 | ✅（重現步驟、預期結果、模塊、日期、標籤、負責人、版本…建單時一次填齊） |
| 「在 BUG-530 留言說已修好」 | 發留言（可 @ 人） | ✅ |
| 「把 BUG-530 轉派給 Howard」 | 轉派（原因必填，帶通知） | ✅ |
| 「把 BUG-530 狀態改成自測中」 | 改狀態（依工作流自動轉派） | ✅（說動作名稱，例如「送 alpha 測試」；退回類動作與「main不受影響」要附原因） |
| 「把這張 BUG 掛到 EPIC-12 底下」 | 設定 / 解除父子關聯 | ✅ |
| 「附上這份設計稿連結」 / 「移掉那個附件」 | 附件增刪 | ✅ |
| 「BUG-530 上的附件給我看」 | 列附件，附可直接開的下載連結 | ✅（見下「附件怎麼拿、怎麼放」） |
| 「把這份 log 檔傳上去」 | 上傳本機檔案為附件 | ✅（給檔案路徑；不收網址，也不會把內容塞進對話） |
| 「幫我追蹤 / 取消追蹤這張」 | 設定關注（要講明追或不追） | ✅ |
| 「把 BUG-530 改成 REQ」 | 轉換工單類型 | ✅（IDEA / STD 不能當目標） |
| 「留言說明並同時改狀態，一次完成」 | 先改狀態、再留言（兩步，非原子） | ✅（中途失敗會明講哪一步沒成，不會自動還原） |
| 「把 BUG-530 的到期日改成下週五」 | 改單一欄位 | ✅（改狀態除外：那要說動作名稱，走一般流轉） |
| 「這 20 張一起送測 / 一起轉派 / 一起改版本」 | 批量操作（一次最多 100 張） | ✅（會回成功與失敗兩份清單） |

### 附件怎麼拿、怎麼放

附件有四個工具，兩個舊的（貼連結 / 刪除）與兩個新的（列出取檔連結 / 上傳檔案）：

| 你說 | 工具 | 結果 |
|------|------|------|
| 「BUG-530 有哪些附件？連結給我」 | `litejira.getAttachments` | 每筆附件的**原有欄位全部保留**，另外多一組 `links` |
| 「把 `./crash.log` 傳上去」 | `litejira.uploadAttachment` | 讀本機檔案、串流上傳，回新建的那筆附件（同樣附上 `links`）與位元組數 |
| 「附上這個雲端硬碟連結」 | `litejira.attachLink` | 只存一條 URL（不搬檔案） |
| 「移掉那個附件」 | `litejira.removeAttachment` | 依附件 UUID 刪除 |

`getAttachments` 讀的是附件專屬端點 `GET /api/v1/tickets/{ticket}/attachments`
（工單本體沒有附件欄）。它**一次回完整集合、不分頁**（每單附件數是個位數），
所以沒有 `limit` / `cursor`；排序穩定但**不代表使用者看到的順序**，要指名單筆請用 `id`。

`getAttachments` 每筆附件多出來的 `links`：

| 欄位 | 是什麼 | 怎麼用 |
|------|--------|--------|
| `links.legacy` | 舊的 `url` 欄位原樣回著（`attachLink` 存進去的那條外部連結） | 沒有變，舊流程照用 |
| `links.web` | `/api/web/attachments/{id}/content` | **這條是給人的**：用已登入 LiteJira 的瀏覽器開即可，可以直接貼進聊天室 |
| `links.api` | `/api/v1/attachments/{id}/content` | 給程式的：要自己帶 `Authorization: Bearer <PAT>`；回的是二進位內容（也可能是導向舊儲存體的 302） |

> **兩條 URL 裡都沒有權杖。** `links.web` 靠瀏覽器既有登入態，`links.api` 靠 header ——
> 所以 `links.api` 不是「點一下就開」的連結，貼給別人只會拿到 401。
>
> 這個 MCP server **不會代你下載附件內容**：它不把二進位塞進 JSON 回應（會炸掉上下文），
> 也不會帶著你的 Bearer 去跟隨 redirect。要取檔請拿上面的 URL 自己抓。

上傳的規矩（跟其他寫入工具不太一樣，值得看一眼）：

- **只收本機檔案路徑**，不收網址。要附外部連結請用 `attachLink`；要傳遠端檔案請自己先下載下來。
- 使用本機 stdio 信任範圍：工具可讀取執行帳號能讀取的檔案，呼叫端應只提交使用者授權上傳的路徑。
- 上傳期限預設 5 分鐘，可用 `timeoutMs` 調整，最多 10 分鐘；一般 JSON 查詢仍採原本的 20 秒期限。
- 只收**普通檔案**：目錄、FIFO、socket、裝置節點、0 byte 檔、超過上限的檔案，全部在送出前就被擋下。
- 檔案是**串流**送出的（一次一塊），不會整個讀進記憶體，也不會出現在對話裡。
  上限預設 25 MiB，可用 `LTJ_MCP_MAX_UPLOAD_BYTES` 調整（天花板 100 MiB）。
- 檔名與 MIME 會照原樣帶上（檔名放在 URL 的 `name`，MIME 放 `Content-Type`）。
- **這個端點不收 `Idempotency-Key`**（後端回 422：串流上傳沒辦法在送出前算出請求指紋）。
  所以上傳逾時或斷線時**不會自動重試**——AI 會先用 `getAttachments` 對帳，確認那筆在不在，再問你要不要重傳。
  自己動手重送就是真的再傳一份，會留下兩筆同名附件。
- 跟其他寫入工具一樣要 `LTJ_MCP_ENABLE_WRITES=true`。

### 搜尋能篩到多細

每個篩選維度都有「是」與「不是」兩種問法，文字欄位再多兩種：

| 問法 | 參數（CLI 旗標） | 例 |
|------|------------------|----|
| 是（多值＝其中之一） | `status`（`--status`） | `status=["開發中","待驗收"]` |
| 不是 | `statusNot`（`--status-not`） | `statusNot=已關閉`（**也會撈到該欄為空的單**，例如「處理人不是張三」含未指派） |
| 標題／內文包含 | `titleContains` / `descriptionContains`（`--title-contains`） | `titleContains=閃退` |
| 標題／內文不包含 | `titleNotContains` / `descriptionNotContains` | `titleNotContains=[已知]` |
| 已逾期 | `overdue`（`--overdue true\|false`） | 有到期日、已過期且尚未進終態 |
| 指名這幾張 | `id`（`--id`，可重複） | 只收 UUID，一次最多 50 張 |

適用的 12 個維度：`type` / `status` / `statusGroup` / `priority` / `module` / `subtype` /
`targetVersion` / `foundVersion` / `assigneeId` / `creatorId` / `ownerId` / `parentId`
（後四個只收成員或工單 UUID），外加兩個文字維度 `title` / `description`。

肯定條件給多值時匹配**任一值**；`Not`／`NotContains` 則**排除整個值集合**（例如 `typeNot=[BUG,TASK]` 會同時排除 BUG 與 TASK）。不同條件之間是**交集**。`q` 是跨欄合併搜尋，
只想比對單一欄請改用 `titleContains` / `descriptionContains`。

> 上表每一項都是**一般篩選**：跨專案（只帶 `mine`）時一項都不能帶，
> 伺服器與本工具都會直接拒絕，不會靜默忽略。排序與分頁不受此限。

AI 會自動載入成員清單、版本列表、工作流規則。

工單可以用 UUID、公開編號（`BUG-481`）或純數字編號來指；回傳同時附兩者，對人講編號、要精確就用 UUID。
依人篩選（處理人 / 負責人 / 建立者）只收成員 UUID，不收顯示名——AI 會先讀 `litejira://members` 換 id，
而不是憑姓名猜人。單張工單的完整內容請讀 `litejira://ticket/{id}`。

---

## 故障排除

| 症狀 | 解法 |
|------|------|
| AI 說找不到 litejira 工具 | 重啟 AI 工具；確認 `claude mcp add` 跑成功 |
| 批量做完說「有幾張失敗」 | 正常：批量是部分成功。看失敗清單的原因（多半是狀態不符或權限），修正後只重送那幾張 |
| AI 說「改狀態要用動作名稱」 | 正常：一般狀態變更一律走流轉（說「送 alpha 測試」這類動作名），不是直接寫狀態欄位 |
| AI 說「狀態改不了」但查得到工單 | 改狀態只收**動作名稱**（如「開始開發」），不是目標狀態名；讓 AI 先查可用動作 |
| `unauthenticated` | 確認 `~/.litejira/credentials.env` 的權杖沒打錯，或請 admin 換一把 |
| `membership_required` / `permission_denied` | 前者是你不在該專案，後者是角色權限不足 → 找 admin |
| 說「請指定專案」 | credentials.env 加 `LTJ_PROJECT=<key>`（專案 key 在 webapp 的專案設定頁），或在資源 URI 帶 `?project=<key>` |
| 說「跨專案查詢不接受一般篩選」 | 跨專案只能查「我的」。要篩選就指定專案（`statusNot` / `titleContains` / `overdue` / `id` 也都算篩選） |
| 說「overdue 只接受布林值」 | `overdue` 只認 `true` / `false`；`"yes"`、`1` 一律拒絕（打錯字與明確指定要分得出來） |
| 說「id 一次最多 50 個值」 | `id` 是指名查詢不是翻頁：超過 50 張請改用篩選條件＋ `cursor` 分頁 |
| 大量 `invalid_response`（不是 JSON） | `LTJ_API_URL` 可能還指著舊的 Apps Script 後端。3.x 只連 `https://litejira.untaglab.com` 這類 2.0 REST 站 |
| 寫入回逾時 / 5xx / `in_progress`，不知道成功沒 | **先讀工單現況**再說。要重送就用同一把 idempotencyKey ＋ 完全相同的輸入，且在 24 小時內；不要換新 key |
| `WRITES_DISABLED` | credentials.env 加 `LTJ_MCP_ENABLE_WRITES=true` |
| 上傳說 `file_too_large` | 檔案超過上限（預設 25 MiB）。調 `LTJ_MCP_MAX_UPLOAD_BYTES`（天花板 100 MiB），或改附連結 |
| 上傳說 `file_not_regular` / `file_empty` | 路徑指到的是目錄或 0 byte 檔。確認路徑，或等檔案寫完再傳 |
| 上傳說 `file_unreadable` | 路徑不存在或沒有讀取權限（server 是在**你這台機器**上讀檔） |
| 上傳回逾時 / 斷線，不知道傳上去沒 | 這個端點沒有冪等鍵，**不要直接重送**。先讓 AI 用 `litejira.getAttachments` 對帳，確認沒有才重傳 |
| 附件連結點開是 401 | 你拿到的是 `links.api`（要帶 Bearer）。要在瀏覽器開請用 `links.web` |
| 啟動拋 HTTP 401 + HTML（不是 JSON） | server 端 API 部署存取設定漂移，不是你的問題 → 找 admin |
| 多開 session 時連不上 | 改用全域安裝（`npm i -g`），不要用 npx |

零外部相依，只需 Node.js 18+。

## License

MIT
