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

## 能做什麼

| 你說 | AI 會做 |
|------|--------|
| 「建一張 P1 BUG 給思源」 | 建立新工單 |
| 「搜尋 login 相關的工單」 | 搜尋篩選 |
| 「查 BUG-530 完整內容」 | 讀工單詳情 |
| 「在 BUG-530 留言說已修好」 | 發留言 |
| 「把 BUG-530 轉派給 Howard」 | 轉派（帶通知） |
| 「把 BUG-530 狀態改成自測中」 | 改狀態（依工作流自動轉派） |

AI 會自動載入成員清單、版本列表、工作流規則。

---

## 故障排除

| 症狀 | 解法 |
|------|------|
| AI 說找不到 litejira 工具 | 重啟 AI 工具；確認 `claude mcp add` 跑成功 |
| `AUTH_FAILED` | 確認 `~/.litejira/credentials.env` 的權杖沒打錯 |
| `WRITES_DISABLED` | credentials.env 加 `LTJ_MCP_ENABLE_WRITES=true` |
| 啟動拋 HTTP 401 + HTML（不是 JSON） | server 端 API 部署存取設定漂移，不是你的問題 → 找 admin |
| 多開 session 時連不上 | 改用全域安裝（`npm i -g`），不要用 npx |

零外部相依，只需 Node.js 18+。

## License

MIT
