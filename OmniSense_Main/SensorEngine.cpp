#include "SensorEngine.h"

uint32_t SensorEngine::lastMicros = 0;

void SensorEngine::init() {
    analogReadResolution(12);
    lastMicros = micros();
}

bool SensorEngine::update(uint16_t* outputData, uint8_t& count, uint32_t& timestamp) {
    if (g_sysConfig.sampleRate == 0) return false;
    uint32_t currentMicros = micros();
    uint32_t interval = 1000000 / g_sysConfig.sampleRate;

    if (currentMicros - lastMicros >= interval) {
        lastMicros = currentMicros;
        timestamp = millis();
        count = 0;
        for (int i = 0; i < MAX_CHANNELS; i++) {
            if ((g_sysConfig.activeMask >> i) & 0x01) {
                outputData[count++] = (uint16_t)analogRead(ADC_PINS[i]);
            }
        }
        return true;
    }
    return false;
}
