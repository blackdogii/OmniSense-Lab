/*
 * OmniSense Lab — SensorEngine（esp_timer 採樣、觸控類比積分／計時換算）
 * 目前釋出：0.2.2（見 Config.h、docs/VERSIONING.md）
 * 作者：小威老師 · 授權：見倉庫 LICENSE
 */
#include "SensorEngine.h"
#include "Config.h"
#include "driver/gpio.h"
#include "esp_timer.h"
#include <algorithm>
#include <cstring>
#include "esp_cpu.h" // 必須引入此標頭檔以使用 CPU 計時器

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

/** 非 ADC 腳：上升時間 dt（µs）換算為 0–4095，與類比讀值同量綱（dt 大→觸碰→數值低） */
static uint16_t touchRiseTimeTo4095(uint32_t dtUs) {
    const uint32_t capUs = 5000u;
    if (dtUs > capUs) {
        dtUs = capUs;
    }
    uint32_t sub = (dtUs * 4095u) / capUs;
    if (sub > 4095u) {
        sub = 4095u;
    }
    return static_cast<uint16_t>(4095u - sub);
}

uint16_t SensorEngine::readSoftwareTouch(uint8_t gpioPin) {
    pinMode(gpioPin, OUTPUT);
    digitalWrite(gpioPin, LOW);
    delayMicroseconds(TOUCH_DISCHARGE_US); // 徹底放電 

    // --- 關鍵修正：進入臨界區防止中斷干擾 ---
    portENTER_CRITICAL(&s_mux);
    
    // 啟動計時 (使用 160MHz 的 CPU 週期)
    uint32_t start = esp_cpu_get_cycle_count();
    
    pinMode(gpioPin, INPUT_PULLUP); // 開始充電 

    // 極速輪詢暫存器 (避開 digitalRead 的延遲)
    // GPIO_IN_REG 解析度遠高於 micros()
    while (((REG_READ(GPIO_IN_REG) >> gpioPin) & 1) == 0) {
        if (esp_cpu_get_cycle_count() - start > 80000) break; // 0.5ms 超時保護
    }
    
    uint32_t dt = esp_cpu_get_cycle_count() - start;
    portEXIT_CRITICAL(&s_mux);

    pinMode(gpioPin, INPUT); // 恢復輸入模式 

    // 將 CPU 週期映射到 0-4095
    // 沒摸時 dt 小 (數值接近 4095)；摸了之後 dt 變大 (數值往下降)
    const uint32_t max_cycles = 5000; // 根據實際波形微調此閾值
    if (dt > max_cycles) dt = max_cycles;
    return static_cast<uint16_t>(4095 - (dt * 4095 / max_cycles));
}
    
    uint32_t dt_cycles = esp_cpu_get_cycle_count() - start_cycles;
    pinMode(gpioPin, INPUT);
    
    // 由於我們改用 cycle 計數，數值會比 micros 大很多，需要重新定義轉換比例
    // 假設未觸碰約 500 cycles，觸碰後可能達 2000 cycles
    // 你可以根據 OmniSense 儀表板觀測到的實際 raw data 來微調這個映射常數
    const uint32_t capCycles = 10000u; // 設定一個合理的上限值
    if (dt_cycles > capCycles) dt_cycles = capCycles;
    
    uint32_t sub = (dt_cycles * 4095u) / capCycles;
    if (sub > 4095u) sub = 4095u;
    
    // 讓數值行為與 ADC 邏輯一致：觸碰時 dt 變大，回傳值變小
    return static_cast<uint16_t>(4095u - sub);
}

void SensorEngine::resetTouchMedian() {
    memset(s_touchFill, 0, sizeof(s_touchFill));
    memset(s_touchWin, 0, sizeof(s_touchWin));
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

static void sensorTimerCb(void* /*arg*/) {
    if (!g_sysConfig.isRunning || g_sysConfig.sampleRate == 0) {
        return;
    }

    const uint32_t ts = micros();
    uint16_t tmp[MAX_CHANNELS];
    uint8_t cnt = 0;

    const uint16_t tm = g_sysConfig.touchModeMask;

    for (int i = 0; i < MAX_CHANNELS; i++) {
        if ((g_sysConfig.activeMask >> i) & 0x01) {
            if ((tm >> i) & 1) {
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
