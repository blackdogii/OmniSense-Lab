/*
 * 專案：OmniSense Lab
 * 作者：小威老師
 * 說明：多通道取樣時序、ADC 與數位腳位讀取；內建上拉由 pullupMask 控制。
 * 硬體：ESP32-C3（ADC 衰減、GPIO 模式）
 * 授權：見儲存庫 LICENSE（學術／非商業免費；商業須另行授權）
 */
#include "SensorEngine.h"
#include "Config.h"

uint32_t SensorEngine::lastMicros = 0;

void SensorEngine::applyPinPullups() {
    uint16_t m = g_sysConfig.pullupMask & 0x01FF;
    for (int i = 0; i < NUM_ADC_CHANNELS; i++) {
        int pin = ADC_PINS[i];
        if ((m >> i) & 1) {
            pinMode(pin, INPUT_PULLUP);
        } else {
            pinMode(pin, INPUT);
        }
        analogSetPinAttenuation(pin, ADC_11db);
    }
    for (int i = 0; i < NUM_DIGITAL_CHANNELS; i++) {
        int logical = NUM_ADC_CHANNELS + i;
        int pin = DIGITAL_PINS[i];
        if ((m >> logical) & 1) {
            pinMode(pin, INPUT_PULLUP);
        } else {
            pinMode(pin, INPUT);
        }
    }
}

void SensorEngine::init() {
    analogReadResolution(12);
    applyPinPullups();
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
