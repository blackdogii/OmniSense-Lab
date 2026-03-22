#ifndef COMMAND_HANDLER_H
#define COMMAND_HANDLER_H

#include "Config.h"

class CommandHandler {
public:
    static void processCommand(const uint8_t* data, size_t len);
};

#endif
