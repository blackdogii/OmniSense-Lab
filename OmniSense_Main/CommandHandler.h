/*
 * 專案：OmniSense Lab
 * 作者：小威老師
 * 說明：BLE 下行指令解析（設定／重開機等）。
 * 版本：見 Config.h 之 OMNISENSE_VERSION（x.y.z）。
 * 硬體：ESP32-C3
 * 授權：見儲存庫 LICENSE（學術／非商業免費；商業須另行授權）
 */
#ifndef COMMAND_HANDLER_H
#define COMMAND_HANDLER_H

#include "Config.h"

class CommandHandler {
public:
    static void processCommand(const uint8_t* data, size_t len);
};

#endif
