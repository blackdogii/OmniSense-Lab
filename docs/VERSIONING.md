# OmniSense Lab 版本編號規格

單一真相來源（程式內實際字串與常數）在 **`firmware/OmniSense_Main/Config.h`**：

- `OMNISENSE_VERSION`：完整字串，例如 **`0.2.2`**（與網頁 `OMNISENSE_WEB_VERSION` 必須相同）。
- `OMNISENSE_VER_X`：板級／產品代號（測試板為 **0**）。
- `OMNISENSE_VER_FW`：韌體修訂（修改 `firmware/OmniSense_Main` 內 `.ino` / `.cpp` / `.h` 並發布韌體時 +1）。
- `OMNISENSE_VER_WEB`：網頁修訂（修改 `web/` 下 `index.html`、`shell.js`、`sw.js`、`manifest` 等並發布網頁時 +1）。
- `OMNISENSE_VERSION_CODE`：16-bit，`(OMNISENSE_VER_FW << 8) | OMNISENSE_VER_WEB`（除錯／`firmwareVersionField`）。

## 遞增規則

| 變更範圍 | 調整 |
|---------|------|
| 僅韌體 | `OMNISENSE_VER_FW` +1，並更新 `OMNISENSE_VERSION` 字串 |
| 僅網頁 | `OMNISENSE_VER_WEB` +1，並更新 `OMNISENSE_VERSION` 字串 |
| 同一次釋出兩邊都改 | `OMNISENSE_VER_FW` 與 `OMNISENSE_VER_WEB` 各 +1，並更新字串 |

## 同步檢查清單

1. 更新 `firmware/OmniSense_Main/Config.h` 中上述常數與 `OMNISENSE_VERSION`。
2. 更新 `web/core/state.js` 內 `OMNISENSE_VER_*` 與 `OMNISENSE_WEB_VERSION`（須與 `OMNISENSE_VERSION` 一致）。
3. 發布網頁時建議遞增 `web/sw.js` 的 `CACHE_NAME`，避免 Service Worker 快取舊版。
4. 根目錄 `projects.json` 與 `web/projects.json` 應保持內容一致（後者方便僅部署 `web/` 目錄時載入索引）。

---

*檔案標頭註明目前釋出字串（例如 0.3.3）。*
