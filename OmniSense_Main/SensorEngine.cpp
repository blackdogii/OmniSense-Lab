/*
 * 專案：OmniSense Lab
 * 作者：小威老師
 * 說明：多通道取樣時序、ADC 與數位腳位讀取。
 * 硬體：ESP32-C3（ADC 衰減、GPIO 模式）
 * 授權：見儲存庫 LICENSE（學術／非商業免費；商業須另行授權）
 */
#include "SensorEngine.h"
#include "Config.h"

uint32_t SensorEngine::lastMicros = 0;

void SensorEngine::init() {
    analogReadResolution(12);
    for (int i = 0; i < NUM_ADC_CHANNELS; i++) {
        analogSetPinAttenuation(ADC_PINS[i], ADC_11db);
    }
    for (int i = 0; i < NUM_DIGITAL_CHANNELS; i++) {
        int pin = DIGITAL_PINS[i];
        // GPIO 20、21 懸空易亂跳：內建上拉穩定在 HIGH（讀數對應 4095）
        if (pin == 20 || pin == 21) {
            pinMode(pin, INPUT_PULLUP);
        } else {
            pinMode(pin, INPUT);
        }
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
