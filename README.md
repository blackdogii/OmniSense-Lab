<!--
  OmniSense Lab — 專案說明（作者：小威老師 · 授權見 LICENSE）
-->

# OmniSense Lab

## 專案目標

在**一般教室**即可操作：師生以手機／平板／筆電透過 **Web Bluetooth** 連線 **ESP32-C3** 底座，進行多通道感測、波形與插件式實驗（主控台、電子琴、魔法弓箭等），無須專用實驗室軟體。

## 儲存庫結構（插件式）

```
OmniSense-Lab/
├── firmware/OmniSense_Main/   # Arduino 韌體（穩定版；協定見 docs/PROTOCOL.md）
├── web/                       # PWA 殼層：index.html、shell.js、core/（BLE／解包／事件）
├── experiments/               # 實驗插件：各子資料夾一實驗 + app.js
├── projects.json              # 實驗選單索引（與 web/projects.json 同步）
├── docs/                      # PRD、PROTOCOL、WIRING、VERSIONING
├── index.html                 # 導向 web/index.html
└── LICENSE
```

- **核心與實驗解耦**：`web/core/` 負責連線與 `omnisense:data` 事件；實驗僅實作 `mount` / `unmount` / 可選 `onConnected`。
- **韌體**：請於 Arduino IDE 開啟 **`firmware/OmniSense_Main/OmniSense_Main.ino`**（若根目錄仍有舊資料夾 `OmniSense_Main`，請改以 `firmware/` 下為準並刪除重複）。

## Web 使用方式

1. 使用 **Chrome／Edge** 等支援 Web Bluetooth 的瀏覽器，頁面須在 **HTTPS** 或 **localhost**。
2. 建議在**專案根目錄**啟動靜態伺服器後開啟 **`http://localhost:埠/web/index.html`**（根目錄 `index.html` 會轉址）。

```bash
python -m http.server 8080
# 瀏覽器開啟 http://localhost:8080/web/index.html
```

## 文件

| 檔案 | 說明 |
|------|------|
| [docs/PRD.md](docs/PRD.md) | 需求與願景 |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | BLE 指令、封包、觸控數值定義 |
| [docs/WIRING_GUIDE.md](docs/WIRING_GUIDE.md) | 腳位與接線建議 |
| [docs/VERSIONING.md](docs/VERSIONING.md) | 版本號與同步方式 |

## 新增實驗（擴充流程）

1. 在 `experiments/` 建立新資料夾（例如 `gravity-car/`）。
2. 新增 `app.js`，匯出 `mount(root)`、`unmount()`，可選 `onConnected()`。
3. 在 **`projects.json` 與 `web/projects.json`** 各新增一筆實驗描述（兩者內容一致）。
4. 不必修改 `web/core/` 或韌體（除非協定或硬體能力變更）。

## 授權

見根目錄 **[LICENSE](LICENSE)**。商業利用請依授權條款另行取得授權。
