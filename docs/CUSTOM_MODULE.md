# 自訂實驗模組（外部卡帶）

教師或第三方可在**不改韌體**的前提下，自行託管一個 **ES module**（JavaScript），由 OmniSense Lab 主程式以網址動態載入。詳細 BLE 與事件規格見 **[PROTOCOL.md](./PROTOCOL.md)**。

## 適用情境

- 學校將教材部署在 **GitHub Pages、Lovable 匯出、自有 HTTPS 主機** 等。
- 使用 **AI 輔助開發**（如 Cursor、Lovable）時，請一併提供本文件與 `PROTOCOL.md` 作為系統提示的依據。

## 使用者操作（Shell）

1. 開啟 **「自訂實驗」**分頁。
2. 貼上模組的 **完整 `https://…`（或開發時 `http://localhost/…`）網址**。
3. 確認瀏覽器已透過主控台完成 **Web Bluetooth 連線**（與官方實驗相同）。

## 模組必須滿足

| 項目 | 說明 |
|------|------|
| **協定** | 僅使用 `window` 上的 **`omnisense:data`** 事件（別名 `omnisense-data`）取得資料；**不要**在模組內直接操作 GATT。 |
| **匯出** | 必須 `export async function mount(root)`，`root` 為 Shell 配置的容器（對應畫面主區）。 |
| **釋放資源** | 建議實作 **`unmount()` 或 `cleanup()`**：移除事件監聽、停止動畫／`p5.remove()`、關閉 `AudioContext` 等。切換實驗時 Shell 會擇一呼叫。 |
| **可選** | `export async function onConnected()`：在 BLE 已連線時由 Shell 呼叫（例如下發腳位與取樣）。 |
| **網路** | 模組 URL 須為 **`http:` 或 `https:`**；託管端須對 **OmniSense Lab 網頁來源**允許 **CORS**，並以適合 ES module 的方式提供（例如 `Content-Type: application/javascript`）。 |

載入失敗時，介面常見提示包含：**CORS、非 ES module、網址錯誤**。

## 資料怎麼讀

監聽事件即可，**不必**為了讀數而 `import` 本專案的 `web/core`：

```javascript
function onData(ev) {
  const { channels } = ev.detail;
  // channels 為長度 9 的陣列，索引 0–8 對應 G0–G8；未啟用者為 null
  const ch2 = channels[2];
  if (ch2) {
    const v = ch2.filtered; // 0–4095（12-bit 語意見 PROTOCOL.md）
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

- 匯出 `async function mount(root)`，在 `root` 內建立簡潔 UI（例如顯示電壓換算：3.3×(filtered/4095)）。
- 匯出 `async function cleanup()`，移除 `omnisense:data` 的監聽。
- 僅透過 `window.addEventListener('omnisense:data', …)` 讀取 `event.detail.channels`；通道索引與 0–4095 語意見專案文件 PROTOCOL.md。
- 不要使用 Web Bluetooth API；不要假設與官方實驗同一個 import 路徑。

## 相關文件

- [PROTOCOL.md](./PROTOCOL.md) — UUID、封包、`omnisense:data` 的 `detail` 欄位
- [WIRING_GUIDE.md](./WIRING_GUIDE.md) — 腳位與接線
