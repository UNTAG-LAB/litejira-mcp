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
4. （選用）用 `gh release create` 補 GitHub Release 說明；workflow 不碰 Release。

重跑：Actions → `publish` → **Run workflow**，填要重跑的 tag（例 `v3.1.1`）。

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
