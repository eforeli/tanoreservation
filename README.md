# TANO 訂位系統

Next.js + Supabase 訂位系統 MVP v0.1。包含公開訂位頁 `/reserve` 與管理後台 `/admin`。

> 開發測試版本，尚未通過正式商業上線驗收。

## 設定

1. `npm install`
2. 複製 `.env.example` 為 `.env.local`，填入 Supabase URL、anon key、service role key。
3. 在 Supabase SQL Editor 執行 `supabase/migrations/001_initial.sql`。
4. `npm run dev`，瀏覽 http://localhost:3000/reserve。
5. 依照專案規格建立 Supabase Auth 管理員，將 UUID 加入 `admin_users`。

**重要：** 請勿提交 `.env.local` 或任何真正的 service role key。
