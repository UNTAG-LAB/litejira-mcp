# 發版（npm publish）

一句話：**推一個正式版 tag，剩下的 GitHub Actions 全包**——測試、打包、隔離安裝啟動、發布、發布後再驗一次公開安裝。
本機不需要打任何 npm 指令，也不需要任何 npm token。

- Workflow：`.github/workflows/publish.yml`
- 判斷邏輯：`scripts/release-verify.cjs`（單測在 `test/release-verify.test.js`）

---

## 一次性設定：npm trusted publisher（只做一次，之後每次發版全自動）

到 npmjs.com → 套件 `litejira-mcp` → **Settings → Trusted publisher → GitHub Actions**，填**完全一致**的三個值：

| 欄位 | 值 |
| --- | --- |
| Organization / owner | `UNTAG-LAB` |
| Repository | `litejira-mcp` |
| Workflow filename | `publish.yml` |

存檔後，這個 workflow 就能直接 `npm publish`（走 OIDC，沒有長效 token）。
建議同時把套件的 publish 存取設成「只允許 trusted publisher」，這樣任何人用個人 token 都推不上去。

> 設定完成前第一次跑會在 `npm publish` 這步失敗（401/403）；補上設定後用 workflow_dispatch 重跑同一個 tag 即可，
> 前面通過的驗證會重跑一次，不會重複發布。

---

## 每次發版怎麼做

1. 主線（`main`）上把 `package.json` 的 `version` 改成新版本並合併。
2. 在**該 commit** 上打 tag 並推送：tag 必須是 `vX.Y.Z`，且**要和 `package.json` 的版本一致**。
3. 看 Actions 的 `publish` 跑完（綠燈＝已發布且公開安裝驗證通過）。
4. 用 `gh release create` 補 GitHub Release 說明，供網站更新公告連結；workflow 不碰 Release。
5. 將已公開驗證的版本交給網站唯一發布者，同步正式更新公告及未讀紅點，完成下列公告驗收。

重跑：Actions → `publish` → **Run workflow**，填要重跑的 tag（例 `v3.1.1`）。

## 發布後同步網站更新公告

每次新 MCP 版本通過 npm 公開安裝驗證後，都必須交付網站更新公告。不要把候選版本、尚未通過驗證的功能或只有測試通過的修改寫成已發布。

交接給網站唯一發布者的資料包含：

- 套件名稱與確切版本、正式發布日期（註明時區）。
- 3–5 條簡短的使用者可見變更；說明使用者現在能做什麼及必要的升級步驟。
- GitHub Release、來源 commit、成功發布工作流程的連結，以及公開安裝驗證與適用的實際功能驗收證據。

網站依自己的整合、CI、Dev 與正式發布流程更新公告，不由 MCP 發布者另開重複的網站發布。即使網站版號不變，**每次新公告仍須使用遞增、唯一的公告 id**，讓已看過前一則公告的人也能收到新的未讀紅點。同版本發布工作流程重跑且公告內容未變時，沿用既有公告，避免製造重複通知。

網站發布者須實際確認：正式公告包含正確的 MCP 版本與 Release 連結；尚未看過新公告的使用者能看到紅點並由入口開啟公告；閱讀後紅點消失，重整仍保留已讀狀態；下一個公告 id 能再次觸發未讀提示。只通過公告資料的 CI 檢查，不等於完成這些畫面驗收。

發布交接記錄應分開標示「npm 已發布且驗證」與「網站公告／紅點已發布且驗證」。網站公告尚未完成時，保留追蹤事項，不重發相同 npm 版本，也不宣稱整個公告流程已完成。交接證據不得包含 PAT、Token 或憑證檔內容。

## 管線做了哪些事

**verify（ubuntu + windows，Node 24，矩陣並跑）**

1. `preflight`：tag 是正式版 `vX.Y.Z`（預發布 / 建置後綴 / 前導零一律擋）、tag 對得上 `package.json`、
   `files` 列的檔案都在、沒有 runtime 相依，且**這個 commit 必須在 `origin/main` 上**（不讓側枝偷發版）。
2. `npm test`：全測試（本套件無相依也刻意沒有 lockfile，所以不跑 `npm ci`）。
3. `npm pack`：產出要發布的 tgz。
4. `pack-verify`：把 tgz **裝到一個臨時目錄**，然後**真的啟動** MCP server 跑唯讀 smoke
   （initialize / tools/list / prompts/list / 讀 `litejira://meta` / `searchTickets`）。
   不需要真權杖：伺服器打的是本機 loopback stub。守的是「測試全過、裝起來卻啟不動」這一類缺陷。

**publish（ubuntu，`id-token: write` 只開在這個 job）**

5. 同樣的 preflight + `npm pack`（checkout 同一個 tag）。
6. `publish-precheck`：確認 `npm >= 11.5.1`（Node 24 內建即符合，這裡只檢查不安裝），
   並查 registry 是否已有同版本：
   - 沒有且版本高於目前 latest → 發布；較舊版本直接拒絕，避免倒退。
   - 有，且與本地 tgz 的 integrity 一致 → **跳過發布**（重跑安全）。
   - 有，但不一致 → **明確失敗**，不覆寫已發布的版本。
7. `npm publish <tgz> --access public --provenance`：憑證走 OIDC trusted publisher，
   workflow 裡**沒有** `NODE_AUTH_TOKEN`。
8. `registry-verify`：有限退避（約 2 分鐘內）確認 registry 上的 integrity 與本地 tgz 一致、
   `dist-tags.latest` 已指向本版或更新版（重跑舊版不會倒退 latest），再從 registry **隔離安裝這個版本**跑一次同樣的唯讀 smoke
   ——確保「別人 `npm install` 拿到的那份」真的裝得起來、啟得動。

權限：workflow 預設 `contents: read`；`id-token: write` 只在 publish job。
`concurrency` 對整個套件串行執行且**不取消進行中的 run**（發布中途被砍最危險）。

## 本機可跑的驗證

```
npm test                                    # 含發版邏輯單測 test/release-verify.test.js
node scripts/release-verify.cjs smoke-dir --tag v<目前版本> --dir .   # 只跑唯讀 smoke（不需權杖、不連外）
```

`preflight` / `pack-verify` / `publish-precheck` / `registry-verify` 也可在本機跑，
但 `preflight` 會 `git fetch origin main`，後兩者會連 registry；發版本身請交給 workflow。

## 已知限制

- **去重比對假設 `npm pack` 對同一個 commit 產出位元組相同的 tgz。** 若某次重跑因打包差異而
  integrity 對不上已發布的同版，`publish-precheck` 會直接失敗（刻意不覆寫）。
  處理方式：確認 registry 上那一版就是你要的，然後**改用新版本號**重新發版。
- 發布後的 registry 一致性檢查有時間上限（約 2 分鐘）。若 registry 傳播特別慢而逾時，
  套件其實已發布，重跑同一個 tag 即可（會走「已存在且一致 → 跳過發布」路徑）。
- smoke 是**唯讀**的，且打本機 stub：它證明「裝得起來、啟得動、協定通」，
  不證明對正式站的資料語意。要對真站驗證請另跑 `scripts/smoke-stdio-readonly.cjs`（需自備 PAT）。
