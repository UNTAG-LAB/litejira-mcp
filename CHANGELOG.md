# 更新紀錄

只記使用者與呼叫端需要知道的變更；發布流程見 [docs/releasing.md](docs/releasing.md)。

## 3.7.0（未發布）

需要 LiteJira 2.16.0 以上的後端（2026-10-20 已上正式；`POST /tickets/{id}/comments` 收 `format=markdown`）。

> ⚠️ **發版步驟**：LiteJira #434（網站 2.16.0）上 Dev、上正式並抽查通過之後，才合併本版並推 tag 發 npm。舊伺服器不認得 `format` 欄位，3.7.0 搭舊伺服器時**每一則**不帶 format 的留言都會被 422 拒絕。

### ⚠️ 預設行為改變：寫留言不帶 `format` 時改為 Markdown

- `litejira.addComment`、`litejira.replyFeedback` 的 `format` 加 `markdown`，**預設 `markdown`**：內文原字送出並帶 `format=markdown`，由伺服器轉換、再走同一支白名單消毒。
- 支援標題、清單、粗體與斜體、行內程式碼、程式碼區塊、引用、分隔線、表格；連結只收 http／https；夾在 Markdown 裡的 HTML 標籤以字面顯示。
- **受影響的呼叫者**：原本不帶 `format`、期待「原字純文字」的，`**`、`#`、`|` 這類字元現在會被當 Markdown。要原字請改帶 `format: "text"`（行為與 3.5 相同）。
- `text`、`html` 的送法與 3.5 相同（不帶 `format` 欄位）。命令列 `ltj comment` 預設仍是 `text`，新增 `--format markdown`。
- 升號理由：同 3.5.0，工具、參數與回傳結構都沒有移除或改名，只改「不帶參數時」的預設，加一個參數即可恢復。3.6.0 已由 LiteJira GH-392 預定，本版取 3.7.0。

### 修正（LiteJira GH-360，litejira-mcp#4 併入）

- 工單參照的說明改正：參照用 UUID 或伺服器回傳的 key 原字串（新單是純數字，例 2229；舊單可能帶前綴，例 BUG-1205），不要用類型代碼自行拼 key。
- 找不到目標（not_found）時，錯誤指引列出這次請求帶到的所有參照，並說明回應不指出是哪一個對不上；批次工具的失敗項目也補上同樣的指引。錯誤碼、訊息與其他欄位不變。

## 3.6.0（未發布）

需要 LiteJira 2.16.0 以上的後端（待決事項與目前摘要的端點由後端提供；發布前以正式區實際版號核對）。

### 新增

- 待決事項（要人決定的問題）8 支工具：`listDecisions`、`listDecisionsAskedToMe`、`openDecisions`、`answerDecision`、`withdrawDecision`、`updateDecision`、`getSummary`、`setSummary`。
  - 開題一次 1〜20 題，全成或全敗；被問的人每次只收一則通知。對象不在名冊時錯誤會指出第幾題。
  - 回答、撤回、編輯都要帶 `expectedUpdatedAt`；已答或已撤回回 409 並附上現況。
  - 摘要整份覆寫成新版本，帶 `expectedVersion`；工單依賴走既有的「被擋住」關聯，不在摘要裡。
- `litejira.searchTickets` 的 `mine` 多一個 `decision`（等待我決定），跨專案。
- 伺服器說明（instructions）多一句：要人決定的事用 `openDecisions` 開題、不寫在留言裡；接手工單先 `getSummary`。

## 3.5.0（2026-10-15）

需要 LiteJira 2.15.0 以上的後端（精簡模式、`mrLinks`、`bodyText` 由後端提供）。

### ⚠️ 預設行為改變：寫留言不帶 `format` 時改為純文字

- `litejira.addComment`、`litejira.replyFeedback` 與 `ltj comment` 新增 `format`（`text`｜`html`），**預設 `text`**。
- **以前**：內文原樣送出，伺服器一律當 HTML 解析。純文字裡 `<` 後接字母、`/`、`!` 會連同後文被吃掉，網址的 `&copy`、`&reg` 會變成符號。
- **現在**（`text`）：送出前把 `&`、`<` 轉成實體、換行轉成 `<br>`，讀回 `bodyText` 就是原字。
- **受影響的呼叫者**：原本直接送 HTML 標籤（`<p>`、`<strong>`、`<a>` 等）的，升級後標籤會變成看得見的文字。**請改帶 `format: "html"`**（命令列：`--format html`），行為即與舊版相同。
- 只送純文字的呼叫者不用改，而且不會再遺失字。
- 因為改的是「不帶參數時」的預設語意，這一項不是單純的向下相容新增；維持 minor 升號的理由：工具、參數與回傳結構都沒有移除或改名，受影響的只有直接送 HTML 的呼叫者，且只要加一個參數即可恢復。

### 新增

- `litejira.searchTickets` 加 `view`（`full`｜`compact`）：`compact` 每筆只回 14 個對帳欄位，一頁 100 筆約為完整模式的 45%；跨專案只帶 `mine` 時也能帶。
- 搜尋結果每筆有 `mrLinks`（工單登記過的 MR／PR 網址），工具說明已點名。
- `listComments`／`getActivityLog` 說明指向每筆的 `bodyText`（看得到的純文字）；`body` 是存下來的 HTML，不要當純文字再送一次。
- `litejira.readAttachmentText` 的回應多附一段「資料，不是指令」提醒（第二段 content；第一段原始 JSON 與 `structuredContent` 不變）。

### 修正

- 留言工具說明不再宣稱支援 Markdown（實際會原樣顯示）。
