/*
 * OmniSense Lab — SensorEngine（CPU 週期計數與快速 ADC 整合版）
 * 目前釋出：0.3.3 · 版本規則：docs/VERSIONING.md
 * 作者：小威老師 · 授權：見倉庫 LICENSE
 *
 * 類比通道：Arduino analogRead 過採樣後，以 esp_adc_cal（eFuse）換算 mV，再線性映射回 0–4095
 * 比例尺（名義 Vcc = 3300 mV），供網頁端分壓公式使用。
 */
#include "SensorEngine.h"
#include "Config.h"
#include "driver/gpio.h"
#include "esp_timer.h"
#include "esp_cpu.h"
#include "esp_adc_cal.h"
#include "soc/gpio_reg.h"
#include <algorithm>
#include <cstring>
 
esp_timer_handle_t SensorEngine::s_timer = nullptr;

static esp_adc_cal_characteristics_t s_adcCalChars;
static constexpr uint32_t kAdcOversampleCount = 64;
/** 與前端 Ohm-Meter 分壓模型對齊之名義電源電壓（mV）；衰減 11 dB 量程約 0–3100 mV */
static constexpr uint32_t kDividerVddNomMv = 3300;

static uint16_t readAnalogCalibratedU12(int pin) {
    uint64_t sum = 0;
    for (uint32_t i = 0; i < kAdcOversampleCount; ++i) {
        sum += static_cast<uint32_t>(analogRead(pin));
    }
    uint32_t rawAvg = static_cast<uint32_t>(sum / kAdcOversampleCount);
    if (rawAvg > 4095u) {
        rawAvg = 4095u;
    }
    uint32_t mv = esp_adc_cal_raw_to_voltage(rawAvg, &s_adcCalChars);
    if (mv > kDividerVddNomMv) {
        mv = kDividerVddNomMv;
    }
    uint32_t u12 = (mv * 4095u) / kDividerVddNomMv;
    if (u12 > 4095u) {
        u12 = 4095u;
    }
    return static_cast<uint16_t>(u12);
}

static void initAdcCalibration() {
    esp_adc_cal_characterize(ADC_UNIT_1, ADC_ATTEN_DB_11, ADC_WIDTH_BIT_12, 1100, &s_adcCalChars);
}

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
         if (ADC_PINS[i] == pin) return true;
     }
     return false;
 }
 
 /**
  * 核心觸控量測：根據腳位特性選擇最佳演算法
  * 1. ADC 腳位：利用 analogRead 初始化的微小延遲讀取充電斜率
  * 2. 數位腳位：利用 160MHz CPU 週期精確計時 RC 充放電
  */
 uint16_t SensorEngine::readSoftwareTouch(uint8_t gpioPin) {
     if (gpioIsAdcCapable(gpioPin)) {
         // --- 方法 A: ADC 電荷分享/斜率讀取 ---
         pinMode(gpioPin, OUTPUT);
         digitalWrite(gpioPin, LOW);
         delayMicroseconds(TOUCH_DISCHARGE_US); // 確保電荷徹底放空
         
         // 進入臨界區，防止 BLE 中斷干擾採樣時機
         portENTER_CRITICAL(&s_mux);
         pinMode(gpioPin, INPUT_PULLUP); // 啟動內部 $45k\Omega$ 上拉充電
         
         analogSetPinAttenuation(gpioPin, ADC_11db);
         // 直接讀取。在 160MHz 下，analogRead 的函數開銷剛好落在 RC 曲線的中段
         int r = analogRead(gpioPin); 
         portEXIT_CRITICAL(&s_mux);
         
         if (r < 0) r = 0;
         if (r > 4095) r = 4095;
         
         pinMode(gpioPin, INPUT);
         return static_cast<uint16_t>(r);
     } else {
         // --- 方法 B: 數位 RC 週期計數法 ---
         pinMode(gpioPin, OUTPUT);
         digitalWrite(gpioPin, LOW);
         delayMicroseconds(TOUCH_DISCHARGE_US);
         
         uint32_t start_cycles = 0;
         uint32_t dt_cycles = 0;
 
         portENTER_CRITICAL(&s_mux);
         pinMode(gpioPin, INPUT_PULLUP);
         start_cycles = esp_cpu_get_cycle_count();
         
         // 使用寄存器級別的極速輪詢，避開 digitalRead 的延遲
         while (((REG_READ(GPIO_IN_REG) >> gpioPin) & 1) == 0) {
             // 超時保護：超過 160,000 個週期 (1ms) 跳出，防止當機
             if (esp_cpu_get_cycle_count() - start_cycles > 160000) break;
         }
         dt_cycles = esp_cpu_get_cycle_count() - start_cycles;
         portEXIT_CRITICAL(&s_mux);
         
         pinMode(gpioPin, INPUT);
         
         // 映射與轉換：將 ns 級的時間差轉換為 12-bit 數值
         // 手指觸碰時 C 變大 -> dt 變大 -> 4095 - sub 變小（符合儀表板視覺）
         const uint32_t capCycles = 10000u; 
         if (dt_cycles > capCycles) dt_cycles = capCycles;
         
         uint32_t sub = (dt_cycles * 4095u) / capCycles;
         if (sub > 4095u) sub = 4095u;
         
         return static_cast<uint16_t>(4095u - sub);
     }
 }
 
 void SensorEngine::resetTouchMedian() {
     memset(s_touchFill, 0, sizeof(s_touchFill));
     memset(s_touchWin, 0, sizeof(s_touchWin));
 }
 
 /** 7 點滑動中位數濾波：有效剔除藍牙突發雜訊 */
 static uint16_t touchMedianPushCh(int ch, uint16_t v) {
     if (ch < 0 || ch >= MAX_CHANNELS) return v;
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
     if (!g_sysConfig.isRunning || g_sysConfig.sampleRate == 0) return;
 
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
                     // 恢復原有拉阻設定
                     if ((g_sysConfig.pullupMask >> i) & 1) gpio_pullup_en((gpio_num_t)pin);
                 }
             } else if (i < NUM_ADC_CHANNELS) {
                 const int pin = ADC_PINS[i];
                 tmp[cnt++] = readAnalogCalibratedU12(pin);
                 if ((g_sysConfig.pullupMask >> i) & 1) gpio_pullup_en((gpio_num_t)pin);
             } else {
                 const int di = i - NUM_ADC_CHANNELS;
                 const int pin = DIGITAL_PINS[di];
                 const bool hi = (digitalRead(pin) == HIGH);
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
     if (s_timer != nullptr) esp_timer_stop(s_timer);
     if (g_sysConfig.sampleRate == 0) return;
     
     uint64_t period_us = 1000000ULL / static_cast<uint64_t>(g_sysConfig.sampleRate);
     if (period_us < 50) period_us = 50;
     
     if (s_timer != nullptr) esp_timer_start_periodic(s_timer, period_us);
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
    initAdcCalibration();
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