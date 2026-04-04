/*
 * 專案：OmniSense Lab
 * 說明：韌體全域設定（整合版：解決 iPhone 掃描並補回遺失常數）
 */
#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h>

// --- BLE 核心設定 (修正編譯歧義與廣播空間) ---
#define SERVICE_UUID           (uint16_t)0xFFE0
#define CHARACTERISTIC_UUID_TX (uint16_t)0xFFE1
#define CHARACTERISTIC_UUID_RX (uint16_t)0xFFE2

#define BLE_DEVICE_NAME "Omni01"

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

struct SystemConfig {
    uint16_t activeMask;
    uint16_t sampleRate;
    BitDepth resolution;
    bool isRunning;
};

extern SystemConfig g_sysConfig;

#endif