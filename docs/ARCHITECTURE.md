# OmniSense Lab — 網頁架構與實驗模組慣例

## 目錄與邊界

- **Shell**：`web/shell.js`、`web/index.html` — 導覽、BLE、動態載入實驗。
- **核心**：`web/core/*` — BLE、解包、狀態、事件迴圈；**實驗模組不得直接操作 GATT**。
- **卡帶**：`experiments/<id>/` — `app.js`（必備）、**可選** `style.css`、`config.json`（與 `projects.json` 合併）。

## 模組介面（Shell 契約）

- `export async function mount(root)` — 將 UI 掛入 `root`（通常為 `#view-container`）。
- `export async function cleanup()` 或 `unmount()` — 移除監聽、停止動畫／`p5.remove()`、`AudioContext` 等。
- **可選** `export async function onConnected()` — BLE 已連線時套用腳位／預設。
- 資料僅透過 `window` 的 `CustomEvent('omnisense:data', { detail })`（見 `docs/PROTOCOL.md`）。

## 程式風格

- **ES modules**；相對路徑指向 `web/core` 時使用 `../../web/core/...`（自 `experiments/<id>/app.js`）。
- 常數大寫、`const` 優先；非同期錯誤 `try/catch` 或 `console.warn`，避免吞掉例外。
- DOM 與畫布：實驗專用 class 建議前綴（例如 `mbt-`）以免與 Shell 衝突。
- 效能：行動裝置上 `p5` 可用 `noLoop()` + 在資料事件內 `redraw()`，離開時務必 `remove()`。

## 硬體預設

- 目錄級 `config.json` 可含 `hardwarePreset`，與 `web/projects.json` 條目 deep merge（後者優先或依 Shell 實作）。
- 下行設定格式見 `docs/PROTOCOL.md` 的 `CMD_SET_CONFIG`。
