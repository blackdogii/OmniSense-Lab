/*
 * 專案：OmniSense Lab
 * 作者：小威老師
 * 說明：CommandHandler 實作。
 * 硬體：ESP32-C3
 * 授權：見儲存庫 LICENSE（學術／非商業免費；商業須另行授權）
 */
#include "CommandHandler.h"
#include "Config.h"
#include "SensorEngine.h"

void CommandHandler::processCommand(const uint8_t* data, size_t len) {
    if (len < 1) return;
    uint8_t cmdId = data[0];
    switch (cmdId) {
        case CMD_SET_CONFIG:
            /*
             * 10B：[0x01][AM_hi][AM_lo][PU_hi][PU_lo][Rate_hi][Rate_lo][Res][TouchMask_hi][TouchMask_lo]
             *       TouchMask：bit=1 該通道為軟體觸控（payload 為 µs）
             * 8B：同上前 8 位元組，TouchMask 視為 0
             * 6B 舊協定：維持既有行為
             */
            if (len >= 8) {
                g_sysConfig.activeMask = ((uint16_t)data[1] << 8) | data[2];
                g_sysConfig.activeMask &= 0x01FF;
                g_sysConfig.pullupMask = ((uint16_t)data[3] << 8) | data[4];
                g_sysConfig.pullupMask &= 0x01FF;
                g_sysConfig.sampleRate = ((uint16_t)data[5] << 8) | data[6];
                g_sysConfig.resolution = (BitDepth)data[7];
                if (len >= 10) {
                    g_sysConfig.touchModeMask = ((uint16_t)data[8] << 8) | data[9];
                } else {
                    g_sysConfig.touchModeMask = 0;
                }
                g_sysConfig.touchModeMask &= 0x01FF;
                g_sysConfig.touchModeMask &= g_sysConfig.activeMask;
                SensorEngine::resetTouchMedian();
                SensorEngine::applyPinPullups();
                SensorEngine::restartSamplingTimer();
                Serial.printf(
                    "Config: mask=0x%03X pullup=0x%03X touch=0x%03X rate=%dHz res=%d\n",
                    g_sysConfig.activeMask, g_sysConfig.pullupMask, g_sysConfig.touchModeMask,
                    g_sysConfig.sampleRate, (int)g_sysConfig.resolution);
            } else if (len >= 6) {
                g_sysConfig.activeMask = ((uint16_t)data[1] << 8) | data[2];
                g_sysConfig.activeMask &= 0x01FF;
                g_sysConfig.sampleRate = ((uint16_t)data[3] << 8) | data[4];
                g_sysConfig.resolution = (BitDepth)data[5];
                g_sysConfig.touchModeMask = 0;
                SensorEngine::resetTouchMedian();
                SensorEngine::restartSamplingTimer();
                Serial.printf(
                    "Config 6B (legacy): mask=0x%03X rate=%dHz res=%d (pullup 不變)\n",
                    g_sysConfig.activeMask, g_sysConfig.sampleRate, (int)g_sysConfig.resolution);
            }
            break;
        case CMD_REBOOT:
            ESP.restart();
            break;
    }
}
