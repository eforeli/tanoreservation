# TANO 生產資料庫備份與還原 Runbook

## 範圍與安全原則

- 專案：Supabase `tano_reservation`（正式環境）。
- 備份來源：每天由 GitHub Actions 以**唯讀匯出**方式備份角色、應用資料表結構及資料。
- 時間：每天 **03:17（台灣時間）**；可從 Actions 手動觸發。
- 備份儲存：GitHub Actions **Artifact**，僅上傳 **GPG AES-256 加密**的備份壓縮包與校驗碼。保留 30 天。
- GitHub repo 是**公開的**，因此所有備份都必須先加密。備份金鑰**不得存於原始碼、Issue、PR、聊天內容或 Artifact**。
- **重要：GitHub 可能在公開 Repository 連續 60 天沒有程式庫活動後，自動停用排程工作流程。** 如果上線後很少改程式，這是營運上不可接受的盲點。**建議將這個 Repo 改為 Private，或將備份工作流程獨立搬到 Private Repo，再完成首次備份驗收。** 單靠目前公開 Repo 的 Schedule 不能保證長期自動備份。
- 這是**每日快照**，不是即時備份／PITR。最多可能遺失兩次備份間的訂位更新（約 24 小時，另加上排程延遲）。
- GitHub Artifacts 會到期。**每月**應另外下載一份加密檔到可信任的獨立儲存空間（例如離線加密硬碟或受控雲端硬碟）。不可只依賴 GitHub。
- Supabase 平台管理的 `auth`、`storage` schema / 身分驗證帳號與 Storage 物件**不保證包含於 CLI 正常匯出**。若需完整災難復原，必須另行規劃身分驗證帳號與 Storage 物件的備份。本系統目前的主要營運資料在 `public` schema。

## 一次性啟用（**必做**）

1. 在 Supabase 正式專案的 **Connect** 畫面取得 **Session pooler** 的 Postgres 連線字串（通常是 `postgresql://postgres.<project-ref>:...@...pooler.supabase.com:5432/postgres`）。GitHub Actions runner 主要使用 IPv4，通常不適合直接用 IPv6 的 Direct URL。
2. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**，新增兩筆：
   - `TANO_BACKUP_DB_URL`：**正式 Supabase** 的 Session pooler 連線字串（包含已 URL-encode 的資料庫密碼）。**不要填測試資料庫**。
   - `TANO_BACKUP_PASSPHRASE`：至少 24 字元的**全新、隨機、唯一**加密密語，建議由密碼管理器產生 32 字元以上並**另存於密碼管理器**；不要使用資料庫密碼。
3. GitHub → **Actions → TANO encrypted daily database backup → Run workflow**，選 `main` 手動執行一次。
4. 確認 Workflow **Success**，且該次執行產生名稱類似 `tano-db-encrypted-<run-id>` 的 Artifact。
5. **下載一份加密 Artifact**，依下方步驟在新的隔離資料庫還原，成功驗證後才能稱為「具備可還原的備份機制」。不要在正式資料庫直接試還原。
6. **把 Repo 設為 Private，或把備份排程移到 Private Repo**，避免公開 Repository 閒置 60 天後自動停用定時備份。

> Secrets 尚未設定時，工作流程會失敗並提示缺少設定；不能視為已啟用。不要把任何連線金鑰或備份密語貼進對話。

## 下載與檢查備份

1. GitHub → Actions → 選擇成功的 **TANO encrypted daily database backup** 執行紀錄 → Artifacts → 下載 ZIP。
2. 解開 ZIP，應看到 `.tar.gz.gpg` 和 `.sha256` 檔案。
3. 在安全的電腦上，進入檔案目錄，驗證：`sha256sum -c tano-supabase-*.sha256`（Mac 可使用 `shasum -a 256` 自行核對）。
4. 使用 GnuPG 解密（會要求輸入密語）：

```bash
mkdir -p restored
gpg --decrypt tano-supabase-YYYYMMDDTHHMMSSZ.tar.gz.gpg | tar -xz -C restored
ls -l restored/roles.sql restored/schema.sql restored/data.sql
```

請勿把解密後的 `.sql` 檔提交到 GitHub。SQL 內含顧客姓名、電話與訂位資料，應存放在有磁碟加密的電腦中，完成後安全清理。

## 還原流程（**只在空白測試專案演練**）

1. 在 Supabase **新建獨立的測試還原 Project**，切勿直接覆蓋目前 `tano_reservation`。
2. 從新專案的 Connect 取得新資料庫連線（`NEW_DB_URL`）；切勿填正式環境連線。
3. 確保目標資料庫仍是**未匯入 TANO tables 的空白專案**，先依 [Supabase 官方備份還原文件](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore) 檢查權限及相容性，再執行：

```bash
# 需先在 shell 安全地設定 NEW_DB_URL；不要寫入腳本或 GitHub
psql --single-transaction --set ON_ERROR_STOP=1 \
  --file restored/roles.sql \
  --file restored/schema.sql \
  --command 'SET session_replication_role = replica' \
  --file restored/data.sql \
  --dbname "$NEW_DB_URL"
```

4. 確認所有 `public` tables、訂位數量、桌位規則與營業時間正確；重新建立測試用 Supabase Auth 管理員，加入測試 `admin_users`，並確認登入及訂位流程。
5. 還原可能需要手動重設 Auth 身分、專案金鑰、Storage、擴充套件及其他 Supabase Project 設定。
6. **若測試未成功，不可宣稱備份可還原。** 先修復還原程序，再演練，最後再應用到真正緊急情況。

## 故障復原原則

- **單筆誤刪**：優先在隔離資料庫還原，檢查後只回填需要的紀錄；不要直接回滾整個正式 DB。
- **整個 Project 損毀**：先建立新的 Supabase Project，在新專案還原與驗證，重新建立 Auth 管理員，最後切換 Vercel 環境變數並部署。資料庫連線與 service role 不可放在前端。
- **每日監控**：至少每週檢查 GitHub Actions 備份狀態；任何連續失敗須立即處理。
- **定期演練**：每季至少一次完整還原測試，並記錄結果。免費方案並非 Supabase 自動每日備份服務。

## 安全注意事項

- **不會自動還原正式資料庫**。還原是需要人工審核的高風險操作。
- 公開 GitHub Repo 中**只允許加密後的 Artifact**；不要採用將明文 SQL 自動 commit 的做法。
- 每次下載加密檔後應妥善管理解密金鑰；加密密語遺失代表加密備份無法解密。
- 若 Repo 之後改成私人，也仍建議保留加密。
