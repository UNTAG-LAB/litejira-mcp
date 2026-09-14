# litejira-mcp

讓你的 AI 助手（Claude Code / Cursor / ChatGPT Desktop）直接讀寫 LiteJira 工單系統。

這是一個 **MCP server**（純客戶端包裝）。它只負責「怎麼跟 LiteJira API 對話」，不含任何工單資料、後端邏輯或祕密——就像 `chrome-devtools-mcp` 不含 Chrome 的原始碼。你的存取權杖只存在你自己電腦上。

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

> npx 安裝者：`npx` 會快取舊版，重啟未必更新到最新；要更新請跑 `npx --cache-clear` 後重啟，或改用上面的全域安裝。

---

## 設定權杖（一次性）

1. 找 admin 在 LiteJira webapp「設定 → Token」幫你建一把 PAT（`ltj_pat_xxxxx`），順便要 `LTJ_API_URL`。
2. 在你電腦的家目錄建檔 `~/.litejira/credentials.env`：

**Mac / Linux**
```bash
mkdir -p ~/.litejira
cat > ~/.litejira/credentials.env << 'EOF'
LTJ_API_URL=<向 admin 索取>
LTJ_API_TOKEN=<貼你的 ltj_pat_ 權杖>
LTJ_MCP_ENABLE_WRITES=true
EOF
```

**Windows（PowerShell）**
```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.litejira"
@"
LTJ_API_URL=<向 admin 索取>
LTJ_API_TOKEN=<貼你的 ltj_pat_ 權杖>
LTJ_MCP_ENABLE_WRITES=true
"@ | Set-Content "$env:USERPROFILE\.litejira\credentials.env"
```

> 權杖只存在你電腦上、不進 git。離職或不用了，找 admin 在 webapp 撤銷。

---

## 測試

跟 AI 說：「用 LiteJira 搜尋最新的 BUG」。看到工單列表 = 成功。

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

## 設定預設專案（選用）

本版有幾個資源是「專案層級」的（元資料、版本、統計、工作流）。在 credentials 檔加一行就不用每次指定：

```
LTJ_PROJECT=<你的專案 key>
```

沒設也沒關係——臨時指定即可，例如讀 `litejira://meta?project=OTHER`。
兩邊都沒有時會直接報錯說「請指定專案」，**不會**自動挑一個專案給你（猜錯會安靜回錯專案的資料）。
`LTJ_PROJECT` 不是祕密，只是一個專案代號。

---

## 能做什麼

> ✅ **本版已完整遷移到 LiteJira 對外 API v1**：讀取與寫入全部切換完成，18 個工具都能用。
> 兩件要知道的事：
> 1. **批量操作是「部分成功」的**：一次處理 N 張，伺服器會回「成功哪幾張、失敗哪幾張」，
>    整體回應成功不代表每張都改到了。AI 應該把失敗清單如實講給你聽。
> 2. **「留言＋改狀態」一次做（replyFeedback）不是原子操作**（舊版也不是）：
>    先改狀態、再留言，中途失敗會停在半路，而且**不會自動還原**。
>    AI 會明講哪一步成了、哪一步沒成。重試時沿用同一個 idempotencyKey 最安全，但去重**只在伺服器的
>    24 小時保留期內、且輸入完全相同**時成立 —— 過了保留期或換一把新 key，重送就會真的再做一次。
>    結果不明時先讀工單當前狀態再決定，不要盲目重送，也不要為了「繞開」錯誤而換新 key 重跑整串。
>
> 寫入另外需要在 `credentials.env` 設 `LTJ_MCP_ENABLE_WRITES=true`，否則一律擋下。

| 你說 | AI 會做 | 本版 |
|------|--------|------|
| 「搜尋 login 相關的工單」 | 搜尋篩選 | ✅ |
| 「查 BUG-530 完整內容」 | 讀工單詳情 | ✅ |
| 「BUG-530 的留言和歷程給我看」 | 讀留言 / 時間軸 | ✅ |
| 「BUG-530 現在能做哪些動作」 | 查可用流轉動作 | ✅ |
| 「這季的進度統計」 | 讀 dashboard / 版本 / 成員 | ✅ |
| 「建一張 P1 BUG 給思源」 | 建立新工單 | ✅（重現步驟、預期結果、模塊、日期、標籤、負責人、版本…建單時一次填齊） |
| 「在 BUG-530 留言說已修好」 | 發留言（可 @ 人） | ✅ |
| 「把 BUG-530 轉派給 Howard」 | 轉派（原因必填，帶通知） | ✅ |
| 「把 BUG-530 狀態改成自測中」 | 改狀態（依工作流自動轉派） | ✅（說動作名稱，例如「送 alpha 測試」） |
| 「把這張 BUG 掛到 EPIC-12 底下」 | 設定 / 解除父子關聯 | ✅ |
| 「附上這份設計稿連結」 / 「移掉那個附件」 | 附件增刪 | ✅ |
| 「幫我追蹤 / 取消追蹤這張」 | 設定關注（要講明追或不追） | ✅ |
| 「把 BUG-530 改成 REQ」 | 轉換工單類型 | ✅（IDEA / STD 不能當目標） |
| 「留言說明並同時改狀態，一次完成」 | 先改狀態、再留言（兩步，非原子） | ✅（中途失敗會明講哪一步沒成，不會自動還原） |
| 「把 BUG-530 的到期日改成下週五」 | 改單一欄位 | ✅（改狀態除外：那要說動作名稱，走一般流轉） |
| 「這 20 張一起送測 / 一起轉派 / 一起改版本」 | 批量操作（一次最多 100 張） | ✅（會回成功與失敗兩份清單） |

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
| 說「請指定專案」 | credentials.env 加 `LTJ_PROJECT=<key>`，或在資源 URI 帶 `?project=<key>` |
| `WRITES_DISABLED` | credentials.env 加 `LTJ_MCP_ENABLE_WRITES=true` |
| 啟動拋 HTTP 401 + HTML（不是 JSON） | server 端 API 部署存取設定漂移，不是你的問題 → 找 admin |
| 多開 session 時連不上 | 改用全域安裝（`npm i -g`），不要用 npx |

零外部相依，只需 Node.js 18+。

## License

MIT
