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
             * 8B 新協定：[0x01][ActiveMask_hi][ActiveMask_lo][PullupMask_hi][PullupMask_lo][Rate_hi][Rate_lo][Res]
             * 6B 舊協定：維持既有行為，不修改 pullupMask（向下相容）
             */
            if (len >= 8) {
                g_sysConfig.activeMask = ((uint16_t)data[1] << 8) | data[2];
                g_sysConfig.activeMask &= 0x01FF;
                g_sysConfig.pullupMask = ((uint16_t)data[3] << 8) | data[4];
                g_sysConfig.pullupMask &= 0x01FF;
                g_sysConfig.sampleRate = ((uint16_t)data[5] << 8) | data[6];
                g_sysConfig.resolution = (BitDepth)data[7];
                SensorEngine::applyPinPullups();
                Serial.printf(
                    "Config 8B: mask=0x%03X pullup=0x%03X rate=%dHz res=%d\n",
                    g_sysConfig.activeMask, g_sysConfig.pullupMask,
                    g_sysConfig.sampleRate, (int)g_sysConfig.resolution);
            } else if (len >= 6) {
                g_sysConfig.activeMask = ((uint16_t)data[1] << 8) | data[2];
                g_sysConfig.activeMask &= 0x01FF;
                g_sysConfig.sampleRate = ((uint16_t)data[3] << 8) | data[4];
                g_sysConfig.resolution = (BitDepth)data[5];
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
