# AI 代跑的安裝契約（litejira-mcp）

這份文件的讀者是 **AI 助手**（Codex CLI / Claude Code / Gemini CLI 或任何能跑指令的 agent）。
使用者只會做兩件事：叫你安裝、把 PAT 給你。其餘全部由你完成，不要叫使用者去編設定檔。

## 指令契約

```bash
# 1) 安裝（或更新到最新版）
npm install -g litejira-mcp@latest

# 2) 設定 + 註冊（非互動；PAT 從 stdin 一行餵進來，不要放進 argv）
printf '%s' "$PAT" | litejira-mcp setup --client auto --token-stdin --json

# 3) 驗證（唯讀）
litejira-mcp doctor --client auto
```

若遇到未預期的檔案錯誤，CLI 仍會輸出 `ok: false, error: "internal_error"` 的 JSON，不轉述可能含憑證的原始例外。setup 的 `partiallyApplied: null, mutationState: "unknown"` 表示變更狀態尚未確認，AI 應檢查設定與備份後再處理，不能宣稱零變更；doctor 是唯讀，這種錯誤的 `mutationState` 為 `"unchanged"`。

### `setup` 參數

| 參數 | 說明 |
|---|---|
| `prod` / `dev` | 選用。改用 `~/.litejira/credentials.{prod,dev}.env`，註冊時 args 會帶上該參數 |
| `--client codex\|claude\|gemini\|auto` | 目標主機。`auto`（預設）偵測已存在的 `~/.codex`（或 `CODEX_HOME`）、`~/.claude.json`、`~/.gemini`；一個都沒有就失敗，不會假裝成功 |
| `--token-stdin` | 從 stdin 讀一行 PAT。上限 4096 位元組、30 秒逾時，超過一律中止且零變更 |
| `--json` | 額外輸出結構化報告（見下） |
| `--no-register` | 只寫憑證，不碰任何主機設定檔 |
| `--no-verify` | 跳過「啟動一次做唯讀驗證」那一步 |

token 來源優先序：`--token-stdin` > `LTJ_API_TOKEN` / `LTJ_API_PAT` 環境變數 > 互動輸入（僅 TTY）
> **本機憑證檔裡既有的 token**（報告裡的 `tokenSource: "existing"`）。

**升級既有安裝時不要跟使用者要 token。** 本機已經有憑證的話，直接跑
`litejira-mcp setup --client auto --json`（不帶 `--token-stdin`）即可：它會拿既有的 PAT
重新驗證一次再寫設定。只有在「完全沒有任何來源」時才會失敗（退出碼 2），
那時才需要請使用者提供 PAT。

> ⚠️ 套件更新（`npm update -g`）之後仍然要重跑 `setup`：安裝路徑會變，
> 主機設定檔裡那條啟動指令不會自己跟著更新。`doctor` 的 `versionMatch` 就是在抓這件事。

### 輸出約定

帶 `--json` 時，**stdout 只有一份 JSON**（直接 `JSON.parse` 整個 stdout，不要去找第一個 `{`），
人看的進度訊息與警告一律走 stderr。不帶 `--json` 時 stdout 是給人看的文字。

### 退出碼

| 碼 | 意義 | 該怎麼辦 |
|---|---|---|
| 0 | 全部成功 | 先自己重載 / 重連主機並實際呼叫一次 litejira 唯讀工具；做不到才請使用者重啟（見 `hostReloadRequired`） |
| 1 | token 驗證失敗，或寫入後的啟動驗證沒過、或該主機的 litejira 被明確停用 | 如果報告帶 `partiallyApplied: true`，代表**設定檔已經改過**（旁邊有 `.litejira-backup-*` 備份），不要說成零變更；把 `checks` 裡失敗那項如實轉述 |
| 2 | 參數錯、偵測不到主機、沒有 token 來源 | 依訊息補參數後重跑 |
| 3 | preflight 擋下：某個主機設定檔壞掉或形狀不支援 | **零變更**（連憑證都沒寫）。由 AI 依 `message` 檢查並備份，在保留原意的前提下修復設定後重跑；只有缺少必要資訊或權限時才問使用者 |
| 130 | 互動輸入被使用者取消 | 不必重試，問使用者要不要再來一次 |

### `--json` 報告

```jsonc
{
  "ok": true,
  "package": { "name": "litejira-mcp", "version": "3.2.1" },
  "credentialsFile": "/home/me/.litejira/credentials.env",
  "command": "/usr/local/bin/node",
  "args": ["/usr/local/lib/node_modules/litejira-mcp/litejira-mcp-launch.cjs"],
  "clients": [
    {
      "client": "codex",
      "configured": true,        // 設定檔已寫好
      "stdioVerified": true,     // 那條指令真的起得來、協定通、唯讀查詢成功
      "serverVersion": "3.2.1",
      "files": [{ "scope": "user", "file": "…/config.toml", "status": "replaced" }]
    }
  ],
  "hostReloadRequired": true     // 永遠是 true：見下
}
```

`files[].status`：`added` / `replaced` / `unchanged` / `blocked` / `warning`。

## 必須誠實的三件事

1. **`hostReloadRequired` 永遠是 `true`，但那不是叫你就此收工。**
   `stdioVerified: true` 只證明「設定檔裡那條指令可以起來」，**不代表**執行中的
   Codex / Claude Code / Gemini 已經載入它。完成 setup 之後，你的預設動作是
   **自己去重載／重連你所在的主機，然後實際呼叫一次 litejira 的唯讀工具**
   （例如搜尋 1 筆工單）來確認真的可用，再回報結果。
   只有在你的主機沒有重載機制、或重連後工具仍然不在時，才交還給使用者手動重啟 ——
   而且要講清楚你試過什麼、卡在哪一步。單憑 `hostReloadRequired: true` 就丟回去給人，不算完成。
2. **退出碼 3 是零變更；退出碼 1 不是。** 3 代表 preflight 在碰任何檔案之前就擋下來了。
   1 則可能是憑證與設定檔都已經寫過但驗證沒過（看 `partiallyApplied`）——
   這時不要宣稱「什麼都沒改」。兩種情況都不要繞過去硬改設定檔。
3. **憑證不得外流。** 不要把 PAT 寫進 argv、log、commit、設定檔，也不要複述使用者貼給你的 token。
   升級既有安裝時更不要跟使用者重新索取 token：本機有憑證就會自動沿用。
4. **被停用的不算成功。** Codex 的 `enabled = false`、Claude 的 `disabledMcpjsonServers`、
   Gemini 的 `mcp.excluded` / `mcp.allowed` 都是使用者或管理者的決定。工具會如實回報且
   `ok: false`，你也不要自己動手把它改成啟用 —— 請使用者自行確認要不要放行。

## 這個工具會 / 不會動什麼

會：`mcp_servers.litejira`（Codex）、`mcpServers.litejira`（Claude / Gemini）這一個項目，
以及會遮蔽它的專案層覆寫（僅限那些**已經存在** litejira 項目的檔案）。
寫入前先備份（0600），並以 tmp + rename 原子替換。

不會：其他 MCP server、其他設定鍵、註解與不認得的內容；不會新建專案層覆寫檔；
不會繞過 Gemini 的 `mcp.allowed` / `mcp.excluded` 管理者限制；
不會改 Claude 的 `disabledMcpjsonServers` 信任設定（只回報）；不會刪使用者其他檔案。

**litejira 這個項目本身也只動「怎麼啟動」。** 同一個項目裡的政策設定一律原樣保留：
Codex 的 `enabled`、`enabled_tools` / `disabled_tools`、`[mcp_servers.litejira.tools]`、
`startup_timeout_*`；Gemini 的 `includeTools` / `excludeTools` / `trust` / `timeout`；
Claude 的 `disabled`；以及任何我們不認得的鍵。

會被清掉的只有兩類：
1. 與 stdio 互斥的舊傳輸欄位（`url` / `http_url` / `type` / `headers` …）——
   留著的話主機會照舊的 http/sse 去連，新設定等於沒寫。
2. 該項目 `env` 裡會讓新設定失效的鍵：`LTJ_API_TOKEN` / `LTJ_API_PAT`（憑證不該留在設定檔）
   與已退役的舊正式站 `LTJ_API_URL`。同一個 env 裡的其他鍵原樣保留。

設定檔位置尊重官方環境變數：`CODEX_HOME`（Codex home）、`CLAUDE_CONFIG_DIR`
（放 `.claude.json` 的**目錄**）、`GEMINI_CLI_HOME`（**HOME 的替身**，設定在其下的 `.gemini/`）。
讀回設定做驗證時走主機真正的優先序：Claude 是 `projects[cwd]` > 專案 `.mcp.json` > user；
Codex / Gemini 是專案設定 > user 設定。

## 排錯

| 現象 | 判讀 |
|---|---|
| `error: "no_host_detected"` | 使用者的主機不在 `~/.codex` / `~/.claude.json` / `~/.gemini`；用 `--client` 明指 |
| `reason: "malformed"` | 該設定檔我們無法安全解析：未閉合的字串／括號、重複的表頭或鍵、不成形的值，或 JSON 帶註解、尾逗號。零變更；由 AI 檢查、備份並修復可確定的格式問題後重跑，不要交回使用者手動編輯。（這是保守檢查，不是完整的 TOML 驗證器：通過不代表主機一定吃得下，但沒通過我們一定不動它） |
| `status: "warning"`, `reason: "disabled"`, `policyDisabled: true` | Codex 的 `enabled = false` 或 Claude 的 `disabledMcpjsonServers`：啟動指令已更新，但主機不會載入它。跳過啟動驗證、`ok: false`；請使用者自行決定要不要啟用 |
| `reason: "policy_excluded"` / `"policy_not_allowed"` | Gemini 的管理者限制。零變更，要先找管理者放行 |
| `status: "warning"`, `reason: "disabled"` | Claude 把 litejira 列入 `disabledMcpjsonServers`；設定已寫入但主機會停用，請使用者在 Claude Code 內重新核准 |
| `versionMatch` 失敗 | 設定檔啟動到的是另一份（舊的）安裝。重跑 `npm install -g litejira-mcp@latest` 後再 `setup` |
