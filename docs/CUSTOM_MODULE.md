# 自訂實驗模組（外部卡帶）

教師或第三方可在**不改韌體**的前提下，自行託管一個 **ES module**（JavaScript），由 OmniSense Lab 主程式以網址動態載入。詳細 BLE 與事件規格見 **[PROTOCOL.md](./PROTOCOL.md)**。

## 適用情境

- 學校將教材部署在 **GitHub Pages、Lovable 匯出、自有 HTTPS 主機** 等。
- 使用 **AI 輔助開發**（如 Cursor、Lovable）時，請一併提供本文件與 `PROTOCOL.md` 作為系統提示的依據。

## 提供給其它 AI／共筆者的檔案包

若要把「規格＋範例」一併貼給其它 AI，建議準備：

| 層級 | 檔案 | 說明 |
|------|------|------|
| **最小集**（只讀 `omnisense:data`） | [CUSTOM_MODULE.md](./CUSTOM_MODULE.md)、[PROTOCOL.md](./PROTOCOL.md)、[WIRING_GUIDE.md](./WIRING_GUIDE.md) | 足以實作多數遊戲／實驗 UI，不依賴本儲庫相對路徑 `import`。 |
| **補充**（寫 `onConnected` 並下發腳位／取樣） | [web/core/configApply.js](../web/core/configApply.js)、[web/core/ble.js](../web/core/ble.js) | 供**複製** `CMD_SET_CONFIG` 組字節與 `writeConfig` 用法；外部模組**不可**使用 `import '../../web/core/...'`。 |
| **選配** | [web/core/state.js](../web/core/state.js) 內 `PINS_CONFIG`、任一官方 `experiments/<id>/app.js`（節錄） | 與 WIRING_GUIDE 對照邏輯通道；範例可降低幻覺。 |

## 使用者操作（Shell）

1. 開啟 **「自訂實驗」**分頁。
2. 貼上模組的 **完整 `https://…`（或開發時 `http://localhost/…`）網址**。
3. 確認瀏覽器已透過主控台完成 **Web Bluetooth 連線**（與官方實驗相同）。

## 模組必須滿足

| 項目 | 說明 |
|------|------|
| **協定** | 僅使用 `window` 上的 **`omnisense:data`** 事件（別名 `omnisense-data`）取得資料；**不要**在模組內直接操作 GATT。 |
| **匯出** | 必須 **`export async function mount(root)`**。Shell **只**檢查並呼叫 `mount`；若僅 export `init` 而無 `mount`，自訂實驗**載入會失敗**。 |
| **釋放資源** | 建議實作 **`cleanup()` 或 `unmount()`**：移除事件監聽、停止動畫／`p5.remove()`、關閉 `AudioContext` 等。切換實驗時 Shell **會優先呼叫 `cleanup()`**，否則才呼叫 `unmount()`。 |
| **可選** | `export async function onConnected()`：在 BLE 已連線時由 Shell 呼叫（例如下發腳位與取樣）。 |
| **網路** | 模組 URL 須為 **`http:` 或 `https:`**；託管端須對 **OmniSense Lab 網頁來源**允許 **CORS**，並以適合 ES module 的方式提供（例如 `Content-Type: application/javascript`）。 |

載入失敗時，介面常見提示包含：**CORS、非 ES module、網址錯誤**。

## 資料怎麼讀

監聽事件即可，**不必**為了讀數而 `import` 本專案的 `web/core`：

```javascript
function onData(ev) {
  const { channels, mask } = ev.detail;
  // channels：長度 9；索引 0–8 為邏輯通道（實體腳位見 WIRING_GUIDE）；未啟用者為 null
  // mask：當前封包啟用了哪些位元（與韌體 activeMask 一致），可與 channels 對照
  const ch2 = channels[2];
  if (ch2) {
    const v = ch2.filtered; // 0–4095；另有 raw、floating（見 PROTOCOL.md）
  }
}
```

進階（下發設定、佇列寫入 RX）可自本儲庫複製邏輯或改以 **絕對網址** `import` 已部署的 `web/core/*.js`（託管端與瀏覽器皆須允許跨來源載入模組；實務上較繁，**優先建議以事件＋主控台手動同步設定**）。

## 與「官方實驗」路徑的差異

| | 官方 `experiments/<id>/app.js` | 自訂網址模組 |
|--|-------------------------------|--------------|
| 載入方式 | 同網域相對路徑 | 使用者輸入的絕對 URL |
| `import '../../web/core/...'` | 可用 | 不可用（路徑相對於**你的**模組位址） |
| 建議資料來源 | `omnisense:data` | 同左 |

## 給 AI／教案編寫者的提示詞範例（可貼用並微調）

請在 **HTTPS 可訪問**的單一 `.js` 檔中，實作 OmniSense Lab 的外部實驗模組：

- **必須**匯出 `async function mount(root)`，在 `root` 內建立 UI（**不可**只匯出 `init` 而無 `mount`）。
- 匯出 `async function cleanup()`（建議），移除 `omnisense:data` 的監聽；亦可用 `unmount()`。
- 僅透過 `window.addEventListener('omnisense:data', …)` 讀取 `event.detail`（含 `channels`、`mask` 等）；語意見 **PROTOCOL.md**，腳位見 **WIRING_GUIDE.md**。
- 不要使用 Web Bluetooth API；不要 `import` 本專案相對路徑 `web/core/...`（自訂模組網域不同會失敗）。若要下發設定，請自 **configApply.js／ble.js** 複製組封包邏輯到模組內，或請使用者在主控台先調好。

## 相關文件

- [PROTOCOL.md](./PROTOCOL.md) — UUID、封包、`omnisense:data` 的 `detail` 欄位
- [WIRING_GUIDE.md](./WIRING_GUIDE.md) — 腳位與接線
