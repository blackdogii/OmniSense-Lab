/**
 * OmniSense Lab — 跨模組共享狀態（由主控台實驗寫入；events 讀取）
 * 版本見 docs/VERSIONING.md
 */

export const PINS_CONFIG = [
    { id: 0, gpio: 0, type: 'analog' },
    { id: 1, gpio: 1, type: 'analog' },
    { id: 2, gpio: 2, type: 'support' },
    { id: 3, gpio: 3, type: 'analog' },
    { id: 4, gpio: 4, type: 'analog' },
    { id: 5, gpio: 8, type: 'digital' },
    { id: 6, gpio: 9, type: 'digital' },
    { id: 7, gpio: 20, type: 'digital' },
    { id: 8, gpio: 21, type: 'digital' }
];

export const omni = {
    activeMask: 0x0001,
    pullupMask: 0x0180,
    channelMode: PINS_CONFIG.map((pc) => (pc.type === 'digital' ? 'dig' : 'adc')),
    touchThreshold: 2200,
    channelFilters: [],
    packetHistory: [],
    currentViewId: 'dashboard',
    domFrame: 0,
    measuredFps: 60,
    /** 最後一次成功套用至裝置的取樣參數（供其他實驗在未開主控台時寫入） */
    lastFreq: 50,
    lastRes: 1
};

export const BLE_QUEUE_CAP = 80;
export const MAX_PACKETS = 200;
export const MA_WINDOW = 8;

export const FLOATING_ADC_IDS = new Set([0, 1, 3, 4]);
export const FLOAT_WIN = 16;
export const FLOAT_SPAN_THRESH = 120;

/** 與韌體、index 顯示一致（見 Config.h） */
export const OMNISENSE_VER_X = 0;
export const OMNISENSE_VER_FW = 3;
export const OMNISENSE_VER_WEB = 3;
export const OMNISENSE_WEB_VERSION = `${OMNISENSE_VER_X}.${OMNISENSE_VER_FW}.${OMNISENSE_VER_WEB}`;
export const OMNISENSE_VERSION_CODE = (OMNISENSE_VER_FW << 8) | OMNISENSE_VER_WEB;

export const TOUCH_Y_MAX = 4095;
