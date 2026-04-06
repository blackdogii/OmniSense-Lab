/**
 * 實驗：系統主控台（腳位診斷、波形、p5）
 */

import { omni, PINS_CONFIG, TOUCH_Y_MAX, MA_WINDOW, FLOATING_ADC_IDS } from '../../web/core/state.js';
import { clearBleQueue, resetFloatingBuffers, setAfterProcessCallback } from '../../web/core/events.js';
import { u32Delta } from '../../web/core/unpacker.js';
import { computeTouchModeMask } from '../../web/core/touchMask.js';
import { applyDeviceConfig } from '../../web/core/configApply.js';
import * as ble from '../../web/core/ble.js';

const ANALOG_FOUR_IDS = [0, 1, 3, 4];
const G2_ID = 2;
/** 具「一般／上拉／觸控」三態的類比腳（含 G2） */
const ANALOG_MODE_IDS = [0, 1, 2, 3, 4];
const DIGITAL_IDS = [5, 6, 7, 8];
const DIGITAL_PULL_BITS = 0x1e0;

const MODE_ICON = { normal: 'gauge', pullup: 'magnet', touch: 'fingerprint' };
const MODE_TITLE = { normal: '一般（類比）', pullup: '上拉', touch: '觸控' };

const WAVE_RGB = [
    [34, 211, 238],
    [99, 102, 241],
    [251, 191, 36],
    [52, 211, 153],
    [244, 114, 182],
    [16, 185, 129],
    [59, 130, 246],
    [168, 85, 247],
    [249, 115, 22]
];

let omniP5 = null;
let rootEl = null;

function createKalman1D(processNoise, measNoise) {
    let x = null;
    let P = 1;
    const Q = processNoise;
    const R = measNoise;
    return function (z) {
        if (x === null) x = z;
        P = P + Q;
        const K = P / (P + R);
        x = x + K * (z - x);
        P = (1 - K) * P;
        return Math.round(x);
    };
}

function createMovingAverage(windowSize) {
    const buf = [];
    return function (z) {
        buf.push(z);
        if (buf.length > windowSize) buf.shift();
        let s = 0;
        for (let i = 0; i < buf.length; i++) s += buf[i];
        return Math.round(s / buf.length);
    };
}

function rebuildChannelFilters() {
    const mode = document.getElementById('filterSelect')?.value || 'kalman';
    omni.channelFilters = PINS_CONFIG.map((p) => {
        if (p.type === 'digital') return (z) => z;
        if (mode === 'none') return (z) => z;
        if (mode === 'ma') return createMovingAverage(MA_WINDOW);
        return createKalman1D(4, 64);
    });
}

function gpioNum(logicalId) {
    return PINS_CONFIG[logicalId].gpio;
}

function getAnalogModeKey(id) {
    if (omni.channelMode[id] === 'touch') return 'touch';
    if ((omni.pullupMask >> id) & 1) return 'pullup';
    return 'normal';
}

function setModeButtonIcon(modeBtn, id) {
    if (!modeBtn) return;
    const key = getAnalogModeKey(id);
    modeBtn.innerHTML = `<i data-lucide="${MODE_ICON[key]}" class="w-[18px] h-[18px]"></i>`;
    modeBtn.title = MODE_TITLE[key];
    if (window.lucide) window.lucide.createIcons();
}

function cycleAnalogMode(id) {
    const key = getAnalogModeKey(id);
    if (key === 'normal') {
        omni.channelMode[id] = 'adc';
        omni.pullupMask |= 1 << id;
    } else if (key === 'pullup') {
        omni.channelMode[id] = 'touch';
        omni.pullupMask |= 1 << id;
    } else {
        omni.channelMode[id] = 'adc';
        omni.pullupMask &= ~(1 << id);
    }
    omni.pullupMask &= 0x01ff;
    omni.pullupMask |= DIGITAL_PULL_BITS;
    setModeButtonIcon(document.getElementById(`mode-${id}`), id);
    updateCardTitles();
    updateWaveTitle();
    markDirty();
}

function markDirty() {
    const si = document.getElementById('syncIndicator');
    if (si) si.innerText = '⚠️ 設定已變更，請按「應用配置」';
}

function updateCardTitles() {
    for (let id = 0; id < 9; id++) {
        const t = document.getElementById(`card-title-${id}`);
        const u = document.getElementById(`card-unit-${id}`);
        if (!t || !u) continue;
        const g = gpioNum(id);
        if (DIGITAL_IDS.includes(id)) {
            t.textContent = `GPIO ${g} · 數位`;
            u.textContent = '0／4095';
        } else if (omni.channelMode[id] === 'touch') {
            t.textContent = `GPIO ${g} · 觸控`;
            u.textContent = '積分 0–4095';
        } else {
            t.textContent = `GPIO ${g} · 類比`;
            u.textContent = (omni.pullupMask >> id) & 1 ? '12-bit（上拉）' : '12-bit';
        }
    }
}

function updateWaveTitle() {
    const el = document.getElementById('waveSectionTitle');
    if (!el) return;
    el.textContent = '即時感測波形';
}

function buildCsvText() {
    const gpioHeader = PINS_CONFIG.map((p) => `GPIO${p.gpio}`);
    const header = ['timestamp_us', ...gpioHeader];
    const lines = [header.join(',')];
    for (let r = 0; r < omni.packetHistory.length; r++) {
        const pkt = omni.packetHistory[r];
        const row = [pkt.tsUs];
        for (let i = 0; i < 9; i++) {
            row.push(pkt.values[i] != null ? pkt.values[i] : '');
        }
        lines.push(row.join(','));
    }
    return '\ufeff' + lines.join('\n');
}

async function exportCsv(ev) {
    if (ev) ev.preventDefault();
    if (omni.packetHistory.length === 0) {
        alert('尚無資料可匯出，請先連線並接收資料。');
        return;
    }
    const csv = buildCsvText();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const baseName = `OmniSense_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    const file = new File([blob], baseName, { type: 'text/csv' });
    const si = document.getElementById('syncIndicator');

    try {
        if (window.showSaveFilePicker) {
            const handle = await window.showSaveFilePicker({
                suggestedName: baseName,
                types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }]
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            if (si) si.innerText = '已儲存 CSV';
            return;
        }
    } catch (e) {
        if (e && e.name === 'AbortError') return;
        console.warn('showSaveFilePicker', e);
    }

    try {
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: 'OmniSense Lab CSV', text: '匯出感測資料' });
            if (si) si.innerText = '已開啟系統分享';
            return;
        }
    } catch (e) {
        if (e && e.name === 'AbortError') return;
        console.warn('navigator.share', e);
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = baseName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    requestAnimationFrame(() => {
        URL.revokeObjectURL(url);
        a.remove();
    });
    if (si) si.innerText = '已觸發下載';
}

function clearWaveform(ev) {
    if (ev) ev.preventDefault();
    clearBleQueue();
    omni.packetHistory.length = 0;
    resetFloatingBuffers();
    rebuildChannelFilters();
    const el = document.getElementById('syncIndicator');
    if (el) el.innerText = '已清除波形緩衝';
}

async function apply() {
    if (!ble.getRxChar()) return;
    const f = parseInt(document.getElementById('freqRange').value, 10);
    const r = parseInt(document.getElementById('resSelect').value, 10);
    const am = omni.activeMask & 0x01ff;
    const pu = ((omni.pullupMask & 0x01ff) | DIGITAL_PULL_BITS) & 0x01ff;
    omni.pullupMask = pu;
    const tm = computeTouchModeMask();
    await applyDeviceConfig({ freq: f, res: r, activeMask: am, pullupMask: pu, touchMask: tm });
    omni.lastFreq = f;
    omni.lastRes = r;
    const si = document.getElementById('syncIndicator');
    if (si) si.innerText = '⚡ 同步完成';
    updateWaveTitle();
}

function syncPinButtonStyle(id, active) {
    const btn = document.getElementById(`btn-${id}`);
    if (!btn) return;
    const isDig = DIGITAL_IDS.includes(id);
    const colorClass = isDig
        ? 'bg-emerald-600 border-emerald-500 text-white shadow-md shadow-emerald-900/20'
        : id === G2_ID
          ? 'bg-amber-500 border-amber-400 text-white shadow-md shadow-amber-900/20'
          : 'bg-cyan-500 border-cyan-400 text-white shadow-md shadow-cyan-900/20';
    btn.className = `pin-btn min-h-[40px] min-w-[2.75rem] px-2.5 rounded-lg border text-[11px] font-bold shrink-0 transition-transform active:scale-95 ${
        active ? colorClass : 'border-slate-600 text-slate-500 bg-slate-800/60'
    }`;
}

function updateCardVisibility(id) {
    const card = document.getElementById(`card-${id}`);
    if (!card) return;
    const active = (omni.activeMask >> id) & 1;
    card.classList.toggle('hidden', !active);
}

function syncPinUiFromState() {
    for (let id = 0; id < 9; id++) {
        const active = (omni.activeMask >> id) & 1;
        syncPinButtonStyle(id, active);
        updateCardVisibility(id);
        if (ANALOG_MODE_IDS.includes(id)) {
            setModeButtonIcon(document.getElementById(`mode-${id}`), id);
        }
    }
}

function togglePin(id) {
    omni.activeMask ^= 1 << id;
    omni.activeMask &= 0x01ff;
    if (DIGITAL_IDS.includes(id)) {
        omni.channelMode[id] = 'dig';
    }
    const active = (omni.activeMask >> id) & 1;
    syncPinButtonStyle(id, active);
    updateCardVisibility(id);
    markDirty();
}

function loadP5() {
    if (window.p5) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.4.0/p5.js';
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('p5 load failed'));
        document.head.appendChild(s);
    });
}

function wireP5() {
    const packetHistory = omni.packetHistory;
    omniP5 = new window.p5((p) => {
        p.setup = () => {
            const par = document.getElementById('canvasParent');
            if (!par) return;
            p.createCanvas(par.offsetWidth, par.offsetHeight).parent(par);
            p.noLoop();
        };
        p.draw = () => {
            p.background(10, 15, 30);
            if (packetHistory.length < 2) return;
            const t0 = packetHistory[0].tsUs >>> 0;
            const t1 = packetHistory[packetHistory.length - 1].tsUs >>> 0;
            let tw = u32Delta(t1, t0);
            if (tw === 0) tw = 1;
            const plotTop = 8;
            const plotBottom = p.height - 8;
            p.strokeWeight(2);
            for (let i = 0; i < 9; i++) {
                if (!((omni.activeMask >> i) & 1)) continue;
                const [cr, cg, cb] = WAVE_RGB[i];
                p.stroke(cr, cg, cb);
                p.noFill();
                p.beginShape();
                const yMax = omni.channelMode[i] === 'touch' ? TOUCH_Y_MAX : 4095;
                for (let k = 0; k < packetHistory.length; k++) {
                    const pkt = packetHistory[k];
                    if (pkt.values[i] == null) continue;
                    const dx = u32Delta(pkt.tsUs >>> 0, t0);
                    const x = p.map(dx, 0, tw, 0, p.width);
                    const y = p.map(pkt.values[i], 0, yMax, plotBottom, plotTop);
                    p.vertex(x, y);
                }
                p.endShape();
            }
        };
    });
}

function onFrameAfterProcess() {
    if (omni.currentViewId !== 'dashboard') return;
    if (omniP5) omniP5.redraw();
}

let dataListener = null;

function attachDataListener() {
    if (dataListener) return;
    dataListener = (ev) => {
        if (omni.currentViewId !== 'dashboard') return;
        const lowFps = omni.measuredFps < 30;
        omni.domFrame++;
        const ch = ev.detail.channels;
        for (let i = 0; i < 9; i++) {
            if (!ch[i]) continue;
            if (lowFps && ((omni.domFrame + i) & 1)) continue;
            const card = document.getElementById(`card-${i}`);
            if (card && card.classList.contains('hidden')) continue;
            const el = document.getElementById(`val-${i}`);
            if (el) el.innerText = ch[i].filtered;
            const hint = document.getElementById(`float-hint-${i}`);
            if (!hint) continue;
            if (omni.channelMode[i] === 'touch') {
                hint.classList.remove('hidden');
                hint.innerText = '觸控';
                hint.className = 'text-[8px] text-cyan-400/90 mt-1 min-h-[1rem]';
            } else if (FLOATING_ADC_IDS.has(i) && ch[i].floating) {
                hint.classList.remove('hidden');
                hint.innerText = '可能懸空';
                hint.className = 'text-[8px] text-amber-400/90 mt-1 min-h-[1rem]';
            } else {
                hint.classList.add('hidden');
            }
        }
    };
    window.addEventListener('omnisense:data', dataListener);
}

function detachDataListener() {
    if (dataListener) {
        window.removeEventListener('omnisense:data', dataListener);
        dataListener = null;
    }
}

function buildAnalogRow(id) {
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between gap-1.5';
    const activeBtn = document.createElement('button');
    activeBtn.type = 'button';
    activeBtn.id = `btn-${id}`;
    activeBtn.textContent = `G${gpioNum(id)}`;
    activeBtn.title = '開啟／關閉';
    activeBtn.onclick = () => togglePin(id);

    const modeBtn = document.createElement('button');
    modeBtn.type = 'button';
    modeBtn.id = `mode-${id}`;
    modeBtn.className =
        'mode-cycle-btn flex items-center justify-center w-10 h-10 rounded-lg border border-slate-600 bg-slate-800/95 text-slate-100 hover:bg-slate-700/80 active:scale-95 transition-transform shrink-0';
    modeBtn.onclick = () => cycleAnalogMode(id);
    setModeButtonIcon(modeBtn, id);

    row.appendChild(activeBtn);
    row.appendChild(modeBtn);
    return row;
}

function initDashboardUi() {
    omni.pullupMask = (omni.pullupMask & 0x01ff) | DIGITAL_PULL_BITS;
    DIGITAL_IDS.forEach((id) => {
        omni.channelMode[id] = 'dig';
    });

    const a4 = document.getElementById('pins-analog-four');
    ANALOG_FOUR_IDS.forEach((id) => {
        a4.appendChild(buildAnalogRow(id));
    });

    const g2 = document.getElementById('pins-g2');
    g2.appendChild(buildAnalogRow(G2_ID));

    const dig = document.getElementById('pins-digital');
    DIGITAL_IDS.forEach((id) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.id = `btn-${id}`;
        b.textContent = `G${gpioNum(id)}`;
        b.title = '開啟／關閉（數位）';
        b.className =
            'pin-btn min-h-[40px] rounded-lg border border-slate-600 text-[11px] font-bold active:scale-95 transition-transform';
        b.onclick = () => togglePin(id);
        dig.appendChild(b);
    });

    const cards = document.getElementById('dataCards');
    for (let id = 0; id < 9; id++) {
        const c = document.createElement('div');
        c.id = `card-${id}`;
        c.className = 'glass-card p-3 sm:p-4 rounded-xl sm:rounded-2xl transition-all';
        c.innerHTML = `<p id="card-title-${id}" class="text-[9px] font-black text-slate-500 uppercase">GPIO ${gpioNum(id)}</p><p id="val-${id}" class="text-xl sm:text-2xl font-mono font-bold text-slate-100">---</p><p id="card-unit-${id}" class="text-[8px] text-slate-600 mt-0.5">—</p><p id="float-hint-${id}" class="text-[8px] text-amber-400/90 mt-1 min-h-[1rem] hidden"></p>`;
        cards.appendChild(c);
    }

    syncPinUiFromState();
    updateCardTitles();
    updateWaveTitle();
    if (window.lucide) window.lucide.createIcons();
    rebuildChannelFilters();
    document.getElementById('filterSelect').onchange = () => {
        rebuildChannelFilters();
        const si = document.getElementById('syncIndicator');
        if (si) si.innerText = '已切換濾波';
    };
    document.getElementById('applyBtn').addEventListener('click', apply, { passive: false });
    document.getElementById('clearBtn').addEventListener('click', clearWaveform, { passive: false });
    document.getElementById('exportBtn').addEventListener('click', exportCsv, { passive: false });
    document.getElementById('freqRange').addEventListener('input', (e) => {
        document.getElementById('freqLabel').innerText = e.target.value;
    });
}

export async function mount(root) {
    rootEl = root;
    omni.currentViewId = 'dashboard';
    const htmlUrl = new URL('./ui.html', import.meta.url);
    const r = await fetch(htmlUrl);
    root.innerHTML = await r.text();
    initDashboardUi();
    await loadP5();
    wireP5();
    attachDataListener();
    setAfterProcessCallback(onFrameAfterProcess);
    window.touchThreshold = omni.touchThreshold;
}

export async function onConnected() {
    rebuildChannelFilters();
    resetFloatingBuffers();
    await apply();
}

export async function unmount() {
    detachDataListener();
    setAfterProcessCallback(null);
    if (omniP5) {
        omniP5.remove();
        omniP5 = null;
    }
    if (rootEl) {
        rootEl.innerHTML = '';
        rootEl = null;
    }
}
