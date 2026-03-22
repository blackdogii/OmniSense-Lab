#include "CommandHandler.h"

void CommandHandler::processCommand(const uint8_t* data, size_t len) {
    if (len < 1) return;
    uint8_t cmdId = data[0];
    switch (cmdId) {
        case CMD_SET_CONFIG: 
            if (len >= 5) {
                g_sysConfig.activeMask = data[1];
                g_sysConfig.sampleRate = (data[2] << 8) | data[3];
                g_sysConfig.resolution = (BitDepth)data[4];
                Serial.printf("Config Updated: Mask=0x%02X, Rate=%dHz, Res=%d\n", 
                               g_sysConfig.activeMask, g_sysConfig.sampleRate, g_sysConfig.resolution);
            }
            break;
        case CMD_REBOOT:
            ESP.restart();
            break;
    }
}
