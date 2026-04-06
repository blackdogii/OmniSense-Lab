/**
 * 資料管線：BLE 佇列 → 解包 → 濾波 → packetHistory → 派發 omnisense:data
 */

import { unpack } from './unpacker.js';
import {
    omni,
    BLE_QUEUE_CAP,
    MAX_PACKETS,
    FLOATING_ADC_IDS,
    FLOAT_WIN,
    FLOAT_SPAN_THRESH
} from './state.js';

const bleIncoming = [];

const floatRawBuf = Array.from({ length: 9 }, () => []);

export function resetFloatingBuffers() {
    for (let i = 0; i < 9; i++) floatRawBuf[i].length = 0;
}

function stabilizeFloatingAnalog(raw, id) {
    if (!FLOATING_ADC_IDS.has(id)) return { v: raw, floating: false };
    const buf = floatRawBuf[id];
    buf.push(raw);
    if (buf.length > FLOAT_WIN) buf.shift();
    if (buf.length < 3) return { v: raw, floating: false };
    const sorted = [...buf].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const span = sorted[sorted.length - 1] - sorted[0];
    const floating = span > FLOAT_SPAN_THRESH;
    return { v: med, floating };
}

export function pushBlePacket(raw) {
    bleIncoming.push(raw);
    while (bleIncoming.length > BLE_QUEUE_CAP) bleIncoming.shift();
}

export function clearBleQueue() {
    bleIncoming.length = 0;
}

export function processBleQueue() {
    while (bleIncoming.length > 0) {
        const raw = bleIncoming.shift();
        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        const d = unpack(view);
        if (!d) continue;

        const channelSnapshot = Array(9).fill(null);
        let vIdx = 0;
        const { channelMode, channelFilters, touchThreshold } = omni;

        for (let i = 0; i < 9; i++) {
            if ((d.mask >> i) & 1) {
                const rawV = d.values[vIdx++];
                if (channelMode[i] === 'touch') {
                    channelSnapshot[i] = { raw: rawV, filtered: rawV, floating: false };
                } else {
                    const { v: pre, floating } = stabilizeFloatingAnalog(rawV, i);
                    const val = channelFilters[i] ? channelFilters[i](pre) : pre;
                    channelSnapshot[i] = { raw: rawV, filtered: val, floating };
                }
            }
        }

        const row = { tsUs: d.ts, values: Array(9).fill(null) };
        for (let i = 0; i < 9; i++) {
            if (channelSnapshot[i]) row.values[i] = channelSnapshot[i].filtered;
        }
        omni.packetHistory.push(row);
        if (omni.packetHistory.length > MAX_PACKETS) omni.packetHistory.shift();

        omni.domFrame++;

        const detail = {
            ts: d.ts,
            tsUs: d.ts,
            mask: d.mask,
            channels: channelSnapshot,
            channelMode: [...channelMode],
            touchThreshold
        };

        window.dispatchEvent(new CustomEvent('omnisense:data', { detail }));
        window.dispatchEvent(new CustomEvent('omnisense-data', { detail }));
    }
}

/** rAF 每幀後呼叫（供主控台波形等） */
let afterProcessCallback = null;
export function setAfterProcessCallback(fn) {
    afterProcessCallback = fn;
}

let fpsRafCount = 0;
let fpsLastTick = 0;

export function startEventLoop() {
    fpsLastTick = performance.now();
    function tick(now) {
        requestAnimationFrame(tick);
        fpsRafCount++;
        const t = now !== undefined ? now : performance.now();
        if (t - fpsLastTick >= 500) {
            omni.measuredFps = (fpsRafCount * 1000) / (t - fpsLastTick);
            fpsRafCount = 0;
            fpsLastTick = t;
        }
        processBleQueue();
        if (afterProcessCallback) afterProcessCallback();
    }
    requestAnimationFrame(tick);
}
