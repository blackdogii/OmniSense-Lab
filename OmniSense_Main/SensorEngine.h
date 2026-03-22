#ifndef SENSOR_ENGINE_H
#define SENSOR_ENGINE_H

#include "Config.h"

class SensorEngine {
public:
    static void init();
    static bool update(uint16_t* outputData, uint8_t& count, uint32_t& timestamp);
private:
    static uint32_t lastMicros;
};

#endif
