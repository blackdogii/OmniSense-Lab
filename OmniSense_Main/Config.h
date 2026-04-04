#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h>

/**
 * OmniSense Lab - Global Configuration
 * 邏輯通道 0–4：GPIO 0–4 類比輸入（ADC）
 * 邏輯通道 5–8：GPIO 8, 9, 20, 21 數位輸入（與 index.html 之 PINS_CONFIG 對齊）
 */

#define SERVICE_UUID           "FFE0"
#define CHARACTERISTIC_UUID_TX "FFE1"
#define CHARACTERISTIC_UUID_RX "FFE2"

/** 類比腳位（邏輯通道 0..4） */
const int ADC_PINS[] = {0, 1, 2, 3, 4};
/** 數位腳位（邏輯通道 5..8 → 索引 0..3） */
const int DIGITAL_PINS[] = {8, 9, 20, 21};

const int NUM_ADC_CHANNELS = 5;
const int NUM_DIGITAL_CHANNELS = 4;
const int MAX_CHANNELS = 9;

#define PACKET_HEADER 0xAA
#define MAX_MTU 247

#define CMD_SET_CONFIG 0x01
#define CMD_CALIBRATE  0x02
#define CMD_REBOOT     0xFF

enum BitDepth {
    BIT_8 = 0,
    BIT_12 = 1,
    BIT_16 = 2
};

struct SystemConfig {
    uint16_t activeMask;  /**< 最多 9 通道，bit0..bit8 */
    uint16_t sampleRate;
    BitDepth resolution;
    bool isRunning;
};

extern SystemConfig g_sysConfig;

#endif
