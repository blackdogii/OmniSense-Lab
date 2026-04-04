<!--
  專案：OmniSense Lab
  作者：小威老師
  說明：本檔為專案說明與使用方式。
  硬體：ESP32-C3 底座韌體與 Web 主控台
  授權：見 LICENSE
-->

# OmniSense Lab

## 專案目標

在**一般教室**即可操作：師生只需 **手機**（或平板／筆電）、瀏覽器透過 **Web Bluetooth** 連線，搭配 **自製感測器** 與本專案之 **ESP32-C3 底座韌體**，就能進行實驗與資料視覺化，無須專用實驗室軟體或複雜架線門檻。

---

無線感測實驗平台：以 **ESP32-C3** 為「搖桿／萬用底座」韌體，透過 **BLE** 串流多通道資料；**Web（PWA）** 負責連線、設定、波形與濾波。**長期目標**是底座韌體協定穩定後以 **Web 端迭代** 教學與實驗內容（詳見儲存庫內 `.cursorrules`）。

---

## 功能概覽

| 項目 | 說明 |
|------|------|
| 韌體 | 9 個邏輯通道：0–4 為 **ADC**（GPIO 0–4），5–8 為 **數位輸入**（GPIO 8、9、20、21）；依 `activeMask` 取樣並以固定二進位格式上行 |
| Web | Web Bluetooth 連線、`p5.js` 即時波形、解析度／取樣頻率設定、**移動平均／卡爾曼（1D）** 濾波（數位通道不濾波）、PWA |
| 通訊 | 服務 `FFE0`；Notify `FFE1`（資料）、Write `FFE2`（指令）；廣播名稱 `OmniSense-Base` |

---

## 儲存庫結構

```
OmniSense-Lab/
├── OmniSense_Main/          # Arduino 韌體
│   ├── OmniSense_Main.ino
│   ├── Config.h             # UUID、腳位表、指令碼、系統設定
│   ├── SensorEngine.*       # 取樣（ADC + digitalRead）
│   ├── BitPacker.*          # BLE 上行封包
│   └── CommandHandler.*     # BLE 下行指令
├── index.html               # 主控台（Web Bluetooth + p5.js）
├── manifest.json / sw.js    # PWA
├── LICENSE                  # 學術／非商業免費；商業須授權
└── README.md
```

---

## 硬體與腳位（與 `Config.h` 一致）

- **類比**：邏輯通道 0–4 → GPIO **0、1、2、3、4**
- **數位**：邏輯通道 5–8 → GPIO **8、9、20、21**（韌體將 HIGH／LOW 對應為 4095／0 供圖表使用）
- **ESP32-C3**：請避免將 **GPIO 18、19** 當一般 GPIO（多為 USB）；其餘依模組官方腳位圖為準。

---

## 韌體建置（Arduino IDE）

1. 安裝 **esp32** 開發板支援（Espressif），目標晶片選 **ESP32-C3**。
2. 開啟 `OmniSense_Main/OmniSense_Main.ino`。
3. 建議：**USB CDC On Boot** 啟用；分區依韌體大小選擇（必要時選較大 APP 分區）。
4. 編譯並上傳。

---

## Web 主控台使用方式

1. **Web Bluetooth** 需在支援的瀏覽器（例如 Chrome／Edge）使用，且須在 **HTTPS** 或 **localhost** 等安全情境下開啟頁面。
2. 以本機開發為例：在專案根目錄啟動靜態伺服器後，用瀏覽器開啟對應網址（例如 `http://localhost:8080`），再透過「連結裝置」連到 `OmniSense-Base`。
3. 調整取樣頻率、解析度、腳位遮罩後按 **「應用配置」** 同步至裝置。

範例（若已安裝 Python）：

```bash
python -m http.server 8080
```

---

## BLE 協定摘要（凍結版）

**下行 `CMD_SET_CONFIG`（0x01）**，6 bytes：

`[0x01, mask_hi, mask_lo, rate_hi, rate_lo, resolution]`

- `activeMask`：9 通道，bit0–bit8；韌體會與 `0x01FF` 做 AND。

**上行**：標頭 `0xAA` → 16-bit mask（大端）→ 解析度 1 byte → `uint32` 時間戳（小端）→ 依啟用通道與解析度壓縮的樣本 → XOR checksum。細節以 `BitPacker.cpp` 與 `index.html` 的 `unpack` 為準。

---

## 開發原則（簡述）

- **韌體**：硬體讀取與二進位協定；量產後視為 **v1 凍結**，非必要不為教案改版重刷。
- **Web**：實驗 UI、濾波、匯出、文案與教學流程優先在此迭代。

更完整的邊界與檢查清單見 **`.cursorrules`**。

---

## 授權

本專案採 **學術與非商業免費使用**、**商業利用須另行書面／正式授權** 之條款，全文見根目錄 **[LICENSE](LICENSE)**。

- **免費**：各級學校與非營利教學、學術研究、個人非營利學習等，於符合條款前提下得免費使用、修改與散布（須保留著作權聲明等要求，以 `LICENSE` 為準）。
- **商業**：營利導向之整合、銷售、收費服務等，請先洽 **商業授權**（可透過本儲存庫 **GitHub Issues** 聯絡維護者）。

**免責聲明**：`LICENSE` 為專案釋出條款之摘要說明；正式權利義務以 `LICENSE` 內文為準。若需正式法務審閱，請諮詢專業法律顧問。
