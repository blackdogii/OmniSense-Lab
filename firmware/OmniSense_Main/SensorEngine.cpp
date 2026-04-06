/*
 * OmniSense Lab — SensorEngine（雙 ADC 腳位電荷轉移觸控實作）
 * 目前釋出：0.2.2 · 版本規則：docs/VERSIONING.md
 * 授權：見倉庫 LICENSE
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
         if (ADC_PINS[i] == pin) return true;
     }
     return false;
 }
 
 /** * 自動尋找一個與感測腳位不同的 ADC 腳位，作為電荷分享的 VDD_PIN 
  */
 static int getVddPinFor(int currentPin) {
     for (int i = 0; i < NUM_ADC_CHANNELS; i++) {
         if (ADC_PINS[i] != currentPin) return ADC_PINS[i];
     }
     return ADC_PINS[0]; // 預設安全退路
 }
 
 /** * 數位腳位的備用計時法 (若誤選數位腳位為觸控的退路) 
  */
 static uint16_t touchRiseTimeTo4095(uint32_t dtUs) {
     const uint32_t capUs = 5000u;
     if (dtUs > capUs) dtUs = capUs;
     uint32_t sub = (dtUs * 4095u) / capUs;
     if (sub > 4095u) sub = 4095u;
     return static_cast<uint16_t>(4095u - sub);
 }
 
 uint16_t SensorEngine::readSoftwareTouch(uint8_t gpioPin) {
     if (gpioIsAdcCapable(gpioPin)) {
         // ========== 核心演算法：雙腳位電荷轉移 ==========
         
         int vddPin = getVddPinFor(gpioPin);
         
         // 將 VDD_PIN 設定為內部上拉（提供高電位充電）
         pinMode(vddPin, INPUT_PULLUP);
         // 將 TOUCH_PIN 設定為內部下拉（提供放電路徑與基礎電位）
         pinMode(gpioPin, INPUT_PULLDOWN);
         
         // 為了維持系統穩定與 BLE 傳輸，這裡採用 30 次迴圈，
         // 並依靠 OmniSense 外部的 7 點中位數濾波來達到等同 100 次的雜訊抑制效果。
         const int ITERATIONS = 30; 
         uint32_t sum = 0;
         
         for (int i = 0; i < ITERATIONS; i++) {
             // 1. 空讀取 (Dummy Read)：對 VDD_PIN 執行 2 次 analogRead
             // 目的是切換 ADC 多工器，並將 ADC 內部的 12pF 採樣電容充飽至 3.3V
             analogRead(vddPin);
             analogRead(vddPin);
             
             // 2. 量測放電：瞬間切換到 TOUCH_PIN
             // 內部電容的電荷會與 TOUCH_PIN 的寄生電容（包含人體）分享。
             // 人體碰觸時電容變大，量測到的電壓值會因此降低。
             sum += analogRead(gpioPin);
         }
         
         // 恢復腳位狀態，避免影響其他可能正在進行 ADC 採樣的通道
         pinMode(vddPin, INPUT);
         pinMode(gpioPin, INPUT);
         
         // 回傳算術平均值
         return (uint16_t)(sum / ITERATIONS);
         
     } else {
         // ========== 數位腳位備用方案 ==========
         pinMode(gpioPin, OUTPUT);
         digitalWrite(gpioPin, LOW);
         delayMicroseconds(50);
         pinMode(gpioPin, INPUT_PULLUP);
         const uint32_t t0 = micros();
         const uint32_t tmax = 8000u;
         while (digitalRead(gpioPin) == LOW) {
             if ((micros() - t0) > tmax) {
                 pinMode(gpioPin, INPUT);
                 return 0;
             }
         }
         const uint32_t dt = micros() - t0;
         pinMode(gpioPin, INPUT);
         return touchRiseTimeTo4095(dt);
     }
 }
 
 void SensorEngine::resetTouchMedian() {
     memset(s_touchFill, 0, sizeof(s_touchFill));
     memset(s_touchWin, 0, sizeof(s_touchWin));
 }
 
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
     if (g_sysConfig.sampleRate == 0) return;
     
     uint64_t period_us = 1000000ULL / static_cast<uint64_t>(g_sysConfig.sampleRate);
     if (period_us < 50) period_us = 50;
     
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