# 更新紀錄

只記使用者與呼叫端需要知道的變更；發布流程見 [docs/releasing.md](docs/releasing.md)。

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
