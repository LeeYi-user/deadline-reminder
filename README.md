# Deadline 提醒（App）

可以安裝到手機／電腦的 Deadline 提醒 App。用 Chrome 開 https://leeyi-user.github.io/deadline-reminder/ → ⋮ → 加到主畫面 → 安裝。

- 介面和程式都在這裡（`index.html`、`app.js`、`app.css`），由 `sw.js` 快取，開啟不用等網路。
- 資料不在這裡：清單存在使用者自己的 Google 日曆「Deadlines」，App 透過使用者自己的 Google Apps Script（隱藏的 iframe）同步，需要登入擁有者的 Google 帳號。
- 離線時的變更會先存在裝置上，連線後自動同步。
