/*
 * OmniSense Lab — CommandHandler（BLE 下行指令）
 * 目前釋出：0.2.2 · 版本規則：docs/VERSIONING.md
 * 作者：小威老師 · 授權：見倉庫 LICENSE
 */
#ifndef COMMAND_HANDLER_H
#define COMMAND_HANDLER_H

#include "Config.h"

class CommandHandler {
public:
    static void processCommand(const uint8_t* data, size_t len);
};

#endif
