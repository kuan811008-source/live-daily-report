# 直播團隊每日回報系統（後端 + 主管彙整儀表板）

運營／小編／群控 每日填寫回報，自動彙整到主管後台，並接月度考核（軸一執行／軸二互助／職責扣分）。

## 特色
- **填寫端**（`/`）：四態勾選、IP 自動帶門檻、即時完成率、互助事蹟、主管扣分；可送出到後台、也可離線存本機 / 列印 PDF / 匯出 JSON。
- **主管端**（`/admin.html`，密碼保護）：全團隊每日填答一覽、每人月度彙總（平均完成率／互助件數／扣分合計）、CSV 匯出、刪除。
- **儲存**：libsql。本機自動用 `file:local.db`（SQLite 檔）；線上設 `TURSO_DATABASE_URL` 即用 **Turso 雲端**，永久保存。同一人同一天再送出會覆蓋。

## 本機啟動
```bash
cd live-daily-report
npm install        # 第一次需要（安裝 @libsql/client）
node server.js     # 或 npm start
```
- 填寫表單：http://localhost:4321
- 主管後台：http://localhost:4321/admin.html （預設密碼 `admin123`）

## 環境變數
| 變數 | 預設 | 說明 |
|------|------|------|
| `PORT` | `4321` | 服務埠 |
| `ADMIN_PASSWORD` | `admin123` | 主管後台密碼（請改掉） |
| `TURSO_DATABASE_URL` | （無）→ `file:local.db` | Turso 連線字串；設了就用雲端 |
| `TURSO_AUTH_TOKEN` | （無） | Turso 權杖 |

## 接月度考核
主管後台「月度彙總」每人一列直接給出三個數字：
- **平均每日完成率 → 軸一執行**
- **互助件數 → 軸二互助**
- **本月扣分合計（封頂 −30）→ 職責扣分**

把這三個數字填入 `行政版考核制度_最終版.xlsx` 同引擎對應欄即可。

## 部署到 Render（持久化用 Turso，免費）
1. **建 Turso 資料庫**（一次性）：`turso db create live-report` → `turso db show live-report --url`（得 URL）、`turso db tokens create live-report`（得 token）。表會在第一次啟動時自動建立。
2. **推上 GitHub**：見下方「Git」。
3. **Render → New → Web Service** → 連到此 repo（會自動讀 `render.yaml`）。
4. 在 Render 的 **Environment** 填：`ADMIN_PASSWORD`、`TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN`。
5. Deploy 完成後即得對外網址（`https://live-daily-report.onrender.com`）。

> 注意：Render 免費方案磁碟是暫存的，務必設定 Turso 環境變數，資料才會永久保存。

## Git（首次）
```bash
cd live-daily-report
git init && git add . && git commit -m "init"
gh auth login                         # 登入你的 GitHub（kuan811008-source）
gh repo create live-daily-report --private --source=. --push
```

## 給全團隊／手機使用
- **同一區網（不部署）**：員工手機連 `http://你電腦的IP:4321` 即可填寫。
- **對外**：部署到 Render 後給網址即可，手機開網址就能填。

## 檔案
```
live-daily-report/
  server.js              # 後端（http + libsql；零框架）
  public/index.html      # 填寫表單
  public/admin.html      # 主管彙整儀表板
  render.yaml            # Render 部署設定
  Procfile               # 啟動指令
  package.json
  local.db               # 本機資料（自動產生，已 gitignore）
```
