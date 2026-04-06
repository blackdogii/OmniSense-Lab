/*
 * 專案：OmniSense Lab
 * 作者：小威老師
 * 說明：SensorEngine 類別宣告。
 * 硬體：ESP32-C3（採樣由 esp_timer 週期觸發，時間戳為 micros()）
 * 授權：見儲存庫 LICENSE（學術／非商業免費；商業須另行授權）
 */
#ifndef SENSOR_ENGINE_H
#define SENSOR_ENGINE_H

#include "Config.h"
#include "esp_timer.h"

class SensorEngine {
public:
    static void init();
    /** 依 g_sysConfig.pullupMask 設定九路 GPIO 為 INPUT 或 INPUT_PULLUP */
    static void applyPinPullups();
    /**
     * 依 g_sysConfig.sampleRate 建立／重啟週期採樣計時器（esp_timer）。
     * 變更採樣率或連線設定後須呼叫。
     */
    static void restartSamplingTimer();
    /**
     * 若計時器已產生一筆樣本則取出（供 loop 內 BLE notify），時間戳為 micros()。
     */
    static bool takePending(uint16_t* outputData, uint8_t& count, uint32_t& timestampUs);

    /**
     * RC 充放電式軟體觸控：腳位先放電再內建上拉充電，回傳升緣所需時間（微秒）。
     * 僅供診斷／教學；請勿與需穩定 ADC 採樣之同一腳位並行高頻輪詢。
     */
    static uint16_t readSoftwareTouch(uint8_t gpioPin);
    /** 切換觸控通道或關閉觸控模式時清空中位數緩衝 */
    static void resetTouchMedian();

private:
    static esp_timer_handle_t s_timer;
};

#endif
