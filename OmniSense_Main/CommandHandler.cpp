#include "CommandHandler.h"

void CommandHandler::processCommand(const uint8_t* data, size_t len) {
    if (len < 1) return;
    uint8_t cmdId = data[0];
    switch (cmdId) {
        case CMD_SET_CONFIG:
            if (len >= 6) {
                g_sysConfig.activeMask = ((uint16_t)data[1] << 8) | data[2];
                g_sysConfig.activeMask &= 0x01FF;
                g_sysConfig.sampleRate = ((uint16_t)data[3] << 8) | data[4];
                g_sysConfig.resolution = (BitDepth)data[5];
                Serial.printf("Config Updated: Mask=0x%03X, Rate=%dHz, Res=%d\n",
                              g_sysConfig.activeMask, g_sysConfig.sampleRate, (int)g_sysConfig.resolution);
            }
            break;
        case CMD_REBOOT:
            ESP.restart();
            break;
    }
}
