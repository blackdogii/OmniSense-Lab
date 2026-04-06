/*
 * 專案：OmniSense Lab
 * 作者：小威老師
 * 說明：多通道取樣由 esp_timer 週期觸發；時間戳為 micros()；ADC 上拉可於每次讀取後以 gpio_pullup_en 強制維持。
 *       軟體觸控：1ms 窗內 RC 循環計次，回傳 (1000−count) 分數 0–1000；可選 ADC 門檻；7 抽樣中位數濾波。
 * 硬體：ESP32-C3（ADC 衰減、GPIO 模式）
 * 授權：見儲存庫 LICENSE（學術／非商業免費；商業須另行授權）
 */
#include "SensorEngine.h"
#include "Config.h"
#include "driver/gpio.h"
#include "esp_timer.h"
#include <algorithm>
#include <cstring>

esp_timer_handle_t SensorEngine::s_timer = nullptr;

static uint16_t s_out[MAX_CHANNELS];
static uint8_t s_count = 0;
static uint32_t s_tsUs = 0;
static volatile bool s_pending = false;
static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;

/** 各邏輯通道觸控：7 點中位數（滑動窗） */
static uint16_t s_touchWin[MAX_CHANNELS][7];
static uint8_t s_touchFill[MAX_CHANNELS];

static int physicalPinFromLogical(int logical) {
    if (logical < 0 || logical >= MAX_CHANNELS) return -1;
    if (logical < NUM_ADC_CHANNELS) return ADC_PINS[logical];
    return DIGITAL_PINS[logical - NUM_ADC_CHANNELS];
}

static bool gpioIsAdcCapable(int pin) {
    for (int i = 0; i < NUM_ADC_CHANNELS; i++) {
        if (ADC_PINS[i] == pin) {
            return true;
        }
    }
    return false;
}

/**
 * 固定 TOUCH_CYCLE_WINDOW_US 內，重複：放電 → 上拉充電 → 等待越過門檻。
 * 完成一次循環則 cycles++。回傳原始計次（未做 1000−count）。
 */
static uint32_t countTouchCycles(int pin) {
    const uint32_t t0 = micros();
    const uint32_t win = TOUCH_CYCLE_WINDOW_US;
    uint32_t cycles = 0;
    while ((micros() - t0) < win) {
        pinMode(pin, OUTPUT);
        digitalWrite(pin, LOW);
        delayMicroseconds(2);
        pinMode(pin, INPUT_PULLUP);
#if OMNISENSE_TOUCH_ANALOG_CHARGE
        if (gpioIsAdcCapable(pin)) {
            while (analogRead(pin) < TOUCH_ANALOG_THRESHOLD) {
                if ((micros() - t0) >= win) {
                    return cycles;
                }
            }
        } else {
            while (digitalRead(pin) == LOW) {
                if ((micros() - t0) >= win) {
                    return cycles;
                }
            }
        }
#else
        while (digitalRead(pin) == LOW) {
            if ((micros() - t0) >= win) {
                return cycles;
            }
        }
#endif
        cycles++;
    }
    return cycles;
}

static uint16_t touchScoreFromCycles(uint32_t cycles) {
    int32_t s = 1000 - static_cast<int32_t>(cycles);
    if (s < 0) {
        s = 0;
    }
    if (s > 1000) {
        s = 1000;
    }
    return static_cast<uint16_t>(s);
}

static uint16_t touchMedianPushCh(int ch, uint16_t v) {
    if (ch < 0 || ch >= MAX_CHANNELS) {
        return v;
    }
    uint16_t* w = s_touchWin[ch];
    uint8_t& f = s_touchFill[ch];
    if (f < 7) {
        w[f++] = v;
    } else {
        memmove(w, w + 1, 6 * sizeof(uint16_t));
        w[6] = v;
    }
    uint16_t b[7];
    const uint8_t n = f;
    memcpy(b, w, n * sizeof(uint16_t));
    std::sort(b, b + n);
    return b[n / 2];
}

uint16_t SensorEngine::readSoftwareTouch(uint8_t gpioPin) {
    const uint32_t c = countTouchCycles(gpioPin);
    return touchScoreFromCycles(c);
}

void SensorEngine::resetTouchMedian() {
    memset(s_touchFill, 0, sizeof(s_touchFill));
    memset(s_touchWin, 0, sizeof(s_touchWin));
}

static void sensorTimerCb(void* /*arg*/) {
    if (!g_sysConfig.isRunning || g_sysConfig.sampleRate == 0) {
        return;
    }

    const uint32_t ts = micros();
    uint16_t tmp[MAX_CHANNELS];
    uint8_t cnt = 0;

    for (int i = 0; i < MAX_CHANNELS; i++) {
        if ((g_sysConfig.activeMask >> i) & 0x01) {
            if ((g_sysConfig.touchModeMask >> i) & 1) {
                const int pin = physicalPinFromLogical(i);
                if (pin >= 0) {
                    const uint16_t med = touchMedianPushCh(
                        i, SensorEngine::readSoftwareTouch(static_cast<uint8_t>(pin)));
                    tmp[cnt++] = med;
                    if ((g_sysConfig.pullupMask >> i) & 1) {
                        gpio_pullup_en(static_cast<gpio_num_t>(pin));
                    }
                }
            } else if (i < NUM_ADC_CHANNELS) {
                const int pin = ADC_PINS[i];
                tmp[cnt++] = static_cast<uint16_t>(analogRead(pin));
                if ((g_sysConfig.pullupMask >> i) & 1) {
                    gpio_pullup_en(static_cast<gpio_num_t>(pin));
                }
            } else {
                const int di = i - NUM_ADC_CHANNELS;
                const bool hi = digitalRead(DIGITAL_PINS[di]) == HIGH;
                tmp[cnt++] = hi ? 4095u : 0u;
            }
        }
    }

    portENTER_CRITICAL(&s_mux);
    memcpy(s_out, tmp, cnt * sizeof(uint16_t));
    s_count = cnt;
    s_tsUs = ts;
    s_pending = true;
    portEXIT_CRITICAL(&s_mux);
}

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

void SensorEngine::restartSamplingTimer() {
    if (s_timer != nullptr) {
        esp_timer_stop(s_timer);
    }
    if (g_sysConfig.sampleRate == 0) {
        return;
    }
    uint64_t period_us = 1000000ULL / static_cast<uint64_t>(g_sysConfig.sampleRate);
    if (period_us < 50) {
        period_us = 50;
    }
    if (s_timer != nullptr) {
        esp_timer_start_periodic(s_timer, period_us);
    }
}

bool SensorEngine::takePending(uint16_t* outputData, uint8_t& count, uint32_t& timestampUs) {
    portENTER_CRITICAL(&s_mux);
    if (!s_pending) {
        portEXIT_CRITICAL(&s_mux);
        return false;
    }
    memcpy(outputData, s_out, s_count * sizeof(uint16_t));
    count = s_count;
    timestampUs = s_tsUs;
    s_pending = false;
    portEXIT_CRITICAL(&s_mux);
    return true;
}

void SensorEngine::init() {
    analogReadResolution(12);
    applyPinPullups();

    if (s_timer == nullptr) {
        esp_timer_create_args_t cfg = {};
        cfg.callback = &sensorTimerCb;
        cfg.arg = nullptr;
        cfg.dispatch_method = ESP_TIMER_TASK;
        cfg.name = "omni_sens";
        esp_timer_create(&cfg, &s_timer);
    }
    restartSamplingTimer();
}
