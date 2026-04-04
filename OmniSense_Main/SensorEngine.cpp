#include "SensorEngine.h"

uint32_t SensorEngine::lastMicros = 0;

void SensorEngine::init() {
    analogReadResolution(12);
    for (int i = 0; i < NUM_DIGITAL_CHANNELS; i++) {
        pinMode(DIGITAL_PINS[i], INPUT);
    }
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
                if (i < NUM_ADC_CHANNELS) {
                    outputData[count++] = (uint16_t)analogRead(ADC_PINS[i]);
                } else {
                    int di = i - NUM_ADC_CHANNELS;
                    bool hi = digitalRead(DIGITAL_PINS[di]) == HIGH;
                    outputData[count++] = hi ? 4095u : 0u;
                }
            }
        }
        return true;
    }
    return false;
}
