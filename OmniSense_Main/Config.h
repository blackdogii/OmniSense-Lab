/*
 * 專案：OmniSense Lab
 * 說明：韌體全域設定（整合版：解決 iPhone 掃描並補回遺失常數）
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 版本（字串格式 x.y.z，與倉庫根目錄 index.html 內 OMNISENSE_WEB_VERSION 必須完全一致）
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *   x — 板級／產品代號。測試板為 0；是否改為 1、2… 由您決定。
 *   y — 韌體修訂（本資料夾 OmniSense_Main 內 .ino / .cpp / 韌體用 .h）：
 *       每次「發布一版韌體」並修改上述檔案時，將 y 加 1，並更新下方 OMNISENSE_VERSION。
 *   z — 網頁／軟體修訂（index.html、sw.js、manifest 等瀏覽器端）：
 *       每次「發布一版網頁」並修改上述檔案時，將 z 加 1，並更新下方 OMNISENSE_VERSION。
 * 僅改韌體時：y+1。僅改網頁時：z+1。同一次釋出若兩邊都改，則 y 與 z 都 +1。
 * 更新步驟：調整 OMNISENSE_VER_X / _FW / _WEB 與字串 → 同步改 index.html → 燒錄／部署。
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */
#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h>

// --- BLE 核心設定 (修正編譯歧義與廣播空間) ---
#define SERVICE_UUID           (uint16_t)0xFFE0
#define CHARACTERISTIC_UUID_TX (uint16_t)0xFFE1
#define CHARACTERISTIC_UUID_RX (uint16_t)0xFFE2

#define BLE_DEVICE_NAME "Omni01"

/** x：測試板 = 0（由您決定是否遞增） */
#define OMNISENSE_VER_X   0
/** y：韌體修訂，每次韌體釋出 +1 */
#define OMNISENSE_VER_FW  1
/** z：網頁修訂，每次網頁釋出 +1 */
#define OMNISENSE_VER_WEB 1

/** 完整版本字串（務必與 index.html 之 OMNISENSE_WEB_VERSION 相同） */
#define OMNISENSE_VERSION    "0.1.1"
#define OMNISENSE_FW_VERSION OMNISENSE_VERSION

/**
 * 16-bit 對齊碼：高 8 bits = y，低 8 bits = z（x 僅在字串中；除錯／firmwareVersionField）
 */
#define OMNISENSE_VERSION_CODE (((uint16_t)(OMNISENSE_VER_FW) << 8) | (uint16_t)(OMNISENSE_VER_WEB))

/** 軟體觸控：1ms 內充放電循環計次；可選 ADC 判斷充電完成（約 0.8V @ 12-bit） */
#ifndef OMNISENSE_TOUCH_ANALOG_CHARGE
#define OMNISENSE_TOUCH_ANALOG_CHARGE 1
#endif
#define TOUCH_CYCLE_WINDOW_US   1000u
#define TOUCH_ANALOG_THRESHOLD  1000

// --- 通訊協定常數 (補回遺失定義) ---
#define PACKET_HEADER 0xAA
#define MAX_MTU 247

#define CMD_SET_CONFIG 0x01
#define CMD_CALIBRATE  0x02
#define CMD_REBOOT     0xFF

// --- 腳位與頻道設定 (補回遺失定義) ---
const int ADC_PINS[] = {0, 1, 2, 3, 4};
const int DIGITAL_PINS[] = {8, 9, 20, 21};

const int NUM_ADC_CHANNELS = 5;      // 補回此行
const int NUM_DIGITAL_CHANNELS = 4;  // 補回此行
const int MAX_CHANNELS = 9;

// --- 系統枚舉與結構 ---
enum BitDepth { BIT_8 = 0, BIT_12 = 1, BIT_16 = 2 };

/**
 * activeMask / pullupMask：各 9 通道用 bit0..bit8（與 index.html 邏輯通道一致）
 * pullupMask：1=INPUT_PULLUP，0=INPUT（ESP32-C3 內建弱上拉）
 */
struct SystemConfig {
    uint16_t activeMask;
    uint16_t pullupMask;
    uint16_t sampleRate;
    BitDepth resolution;
    bool isRunning;
    /** bit0..8：該邏輯通道為軟體觸控（計次分數 0–1000，經中位數濾波後填入 payload） */
    uint16_t touchModeMask;
    /** 與 OMNISENSE_VERSION_CODE（y 高八位、z 低八位）一致，僅供除錯／對齊 */
    uint16_t firmwareVersionField;
};

extern SystemConfig g_sysConfig;

#endif