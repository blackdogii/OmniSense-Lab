/*
 * 專案：OmniSense Lab
 * 作者：小威老師
 * 說明：SensorEngine 類別宣告。
 * 硬體：ESP32-C3
 * 授權：見儲存庫 LICENSE（學術／非商業免費；商業須另行授權）
 */
#ifndef SENSOR_ENGINE_H
#define SENSOR_ENGINE_H

#include "Config.h"

class SensorEngine {
public:
    static void init();
    /** 依 g_sysConfig.pullupMask 設定九路 GPIO 為 INPUT 或 INPUT_PULLUP */
    static void applyPinPullups();
    static bool update(uint16_t* outputData, uint8_t& count, uint32_t& timestamp);
private:
    static uint32_t lastMicros;
};

#endif
