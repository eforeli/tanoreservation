# 訂位系統 — 可部署 MVP

Next.js 15 / TypeScript / Supabase Postgres + Auth / Vercel。依據 PRD v1.4。

## 準備帳號

1. GitHub（免費）：儲存程式碼。
2. Supabase（免費方案）：建立 Project、取得 Project URL、公開 anon/publishable key、**server-only** service_role key。
3. Vercel：連線 GitHub 專案。**注意：Hobby 非供餐廳商業正式營運使用，正式上線要使用合規的付費方案或改部署平台。**
4. Node.js 20.9+；建議 Node 22。

## 資料庫部署

1. Supabase → SQL Editor → 貼上 `supabase/migrations/001_initial.sql` → Run。
2. Supabase → Authentication → Users，新增管理員 Email/密碼（或邀請管理員）。
3. 複製該帳號 UUID；在 SQL Editor 執行：

```sql
insert into public.admin_users(user_id) values ('把管理員的-auth.users-id-放這裡');
```

**注意**：未執行這一步，登入成功後也無法操作後台；不要開放公開註冊。

## 本機執行

```bash
cp .env.example .env.local
# 填入三個 Supabase 變數（service_role 絕不使用 NEXT_PUBLIC_ 前綴）
npm install
npm run dev
```

開啟 `http://localhost:3000/reserve`（客人）、`http://localhost:3000/admin`（管理員）。

```bash
npm run test
npm run typecheck
npm run build
```

## GitHub / Vercel 部署

1. 使用私人 GitHub Repo，上傳專案**不要上傳 `.env.local`**。
2. Vercel → Add New → Project → Import Git Repository，Framework 選 Next.js。
3. Settings → Environment Variables 分別填入 `.env.example` 的三個值；設定 Production、Preview 各自資料庫，避免測試資料污染正式資料。
4. Deploy；在部署後的 `/reserve` 與 `/admin` 測試。
5. LINE 官方帳號「我要預約」連結指向 `https://你的網域/reserve`。
6. 若原始 TANO 官網也是 Vercel 部署，避免直接假設可共用路由：可先使用 `booking.你的網域` 子網域或本專案 Vercel 網址，再決定是否整併原網站。

## 技術說明

- 公開 `/api/availability` 只返回時間，不公開桌號或個資。
- 公開建立訂位直接呼叫 DB RPC；RPC 以營業日 advisory transaction lock 序列化分桌及新增。
- 跨桌共享椅資源以每個事件邊界檢查最大同時占用，採用餐 90 分鐘；餐桌占用 110 分鐘。
- 後台 Supabase Auth 登入 + `admin_users` 白名單，每一 API 呼叫都重新驗證 token。
- 全部業務資料表 RLS 開啟且 anon/authenticated 沒有 table 存取權，service role 僅存 Server。
- API 時間與資料庫採 UTC ISO，營運計算以 Asia/Taipei。
- 管理員取消保留歷史，管理員修改失敗回滾，鎖桌與既有訂位衝突會回傳警告。

## 第一版限制／尚須上線前補齊

- **安全**：尚未整合真正的伺服器端限流、CAPTCHA / WAF、異常通知；公開 POST 不應在未配置防濫用措施前直接對外營業。
- **備份**：免費 Supabase 無保證每日自動備份；必須建立可還原的站外備份並演練。
- **E2E 測試**：附純演算法測試；需在 Supabase staging 測試兩人同時訂最後一桌、權限、長時間鎖桌、取消和改期。
- **營運決策**：30 天預約、2 小時前截止、每時段 2 組、最晚入席距結束 90 分鐘、額外椅僅計用餐 90 分鐘，都是 PRD 待決策預設值。
- **狀態**：completed/no_show 預設視為不占用庫存，僅 confirmed/seated 占用。提早標記 completed 有超賣風險，請營運確認。
- **管理後台**：已含訂位列表、新增／編輯／取消、每日桌況、鎖桌／解除、訂位參數與特殊休假；週營業時間編輯、按桌強制改派、完整操作歷史 UI 尚未完成。
- **資料保護**：上線前補正式個資告知與保留期間、取消政策、管理員使用規範。
- **設定變更**：縮減椅數或變更時間長度可能使既有訂位不符合新政策，尚未有自動衝突報表；需先人工盤點。
- **跨日鎖桌**：目前鎖桌依開始日期鎖定交易，若建立跨多天封鎖，必須補跨日期鎖定與衝突測試後才適合正式使用。

> 這是原始碼上傳版本，尚未部署或完成整合測試；請勿直接開放真實客人訂位。
