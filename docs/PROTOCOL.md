# BLE 通訊協定（Web ↔ ESP32-C3）

> 實作參考：`firmware/OmniSense_Main/BitPacker.cpp`、`CommandHandler.cpp`；網頁：`web/core/unpacker.js`、`web/core/configApply.js`。

## 服務與特徵（16-bit UUID）

| 項目 | UUID |
|------|------|
| Service | `0xFFE0` |
| TX（Notify 上行） | `0xFFE1` |
| RX（Write 下行） | `0xFFE2` |

Web Bluetooth 字串格式：`0000ffe0-0000-1000-8000-00805f9b34fb` 等。

## 下行：`CMD_SET_CONFIG`（0x01）

### 10 位元組（建議）

| 偏移 | 內容 |
|------|------|
| 0 | `0x01` |
| 1–2 | `activeMask` 高／低（9 通道 bit0–8，常與 `0x01FF` 交集） |
| 3–4 | `pullupMask`（1=INPUT_PULLUP） |
| 5–6 | `sampleRate`（Hz，uint16） |
| 7 | `resolution`：`0`=8-bit，`1`=12-bit，`2`=16-bit |
| 8–9 | `touchModeMask`（16-bit，bit i=1 表示該邏輯通道為觸控模式） |

韌體會將 `touchModeMask` 與 `activeMask` 交集後寫入 `g_sysConfig`。

### 6／8 位元組舊格式

韌體仍支援較短封包；不足 10 位元組時 `touchModeMask` 視為 0。

## 上行：感測封包（BitPacker）

位元組布局（含 checksum 前綴長度由韌體 `BitPacker::pack` 決定）：

| 偏移 | 欄位 |
|------|------|
| 0 | 標頭 `0xAA` |
| 1–2 | `activeMask`（啟用通道，決定 payload 順序） |
| 3 | `resolution`（與下行相同枚舉） |
| 4–7 | `timestamp` = 裝置 `micros()`，**uint32 小端序**（前端還原為微秒時間軸） |
| 8+ | 依啟用通道數量與解析度打包之樣本 |
| 末 | XOR checksum |

### 通道順序

依邏輯通道 `i = 0…8` 由低到高，僅打包 `mask` 中 bit 為 1 的通道，順序與 `i` 遞增一致。

### 12-bit 打包（`resolution == 1`）

每兩個 12-bit 值共用 3 個位元組（見 `BitPacker.cpp` 與 `unpacker.js`）。

### 數值語意

- **一般 ADC／數位**：0–4095（12-bit 類比；數位以 0／4095 表示低／高）。
- **觸控模式**（`touchModeMask` 對應位為 1）：韌體送 **0–4095**  
  - ADC 腳：類比積分讀值。  
  - 非 ADC 腳：上升時間換算至 0–4095（與類比同量綱）。  
  - 教學直觀：**未觸摸時數值偏高，觸摸時波形「下掉」**（網頁可用閾值判斷觸發）。

## 瀏覽器事件

解析與濾波後，核心會發出：

- `omnisense:data` — `detail` 含 `tsUs`、`mask`、`channels`（每通道 `{ raw, filtered, floating }`）、`channelMode`、`touchThreshold` 等。
- `omnisense-data` — 同上，舊別名相容。

實驗模組應只依賴上述事件，不直接存取 GATT。

## 卡帶式實驗模組（動態載入）

Shell 以動態 `import()` 載入 `experiments/<id>/app.js`（官方）或使用者提供的 **http(s) ES 模組 URL**（自訂）。`web/core/ble.js` 與事件迴圈**不因切換實驗而重設**，連線維持時會持續解析上行封包並派發 `omnisense:data`。

模組建議實作：

- `export async function mount(root)` — 將 UI 掛在 Shell 的 `#view-container`。
- `export async function unmount()` 或 `cleanup()` — 釋放資源（移除 `omnisense:data` 監聽、`p5.remove()`、關閉 AudioContext／Oscillator 等）。切換實驗或返回列表時 Shell 會擇一呼叫。
- 可選：`export async function onConnected()` — 在 BLE 已連線時由 Shell 呼叫（例如套用實驗預設腳位）。

`detail.channels` 為 **9 個邏輯通道**（與本文件通道順序一致）；未啟用之通道在 `channels` 中為 `null`。自訂模組若需跨網域載入，伺服器須允許 **CORS**，並以 `Content-Type: application/javascript`（或標準 ES module）提供檔案。
