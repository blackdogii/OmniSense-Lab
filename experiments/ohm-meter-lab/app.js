/**
 * Ohm-Meter-Lab — 電阻鑑定師（Ohmic Master）
 * 分壓：V = Vcc·R_x/(R_x+R_pullup)；上行 0–4095 比例讀值。
 */
import { omni, PINS_CONFIG } from '../../web/core/state.js';
import { applyDeviceConfig } from '../../web/core/configApply.js';
import { computeTouchModeMask } from '../../web/core/touchMask.js';
import * as ble from '../../web/core/ble.js';

/** G2：邏輯通道 2（內建 10kΩ 量測路徑） */
const CH_BUILTIN = 2;
/** 擴展模式可選邏輯通道（對應 G0、G1、G3、G4） */
const EXT_CHANNELS = [0, 1, 3, 4];

const ADC_MAX = 4095;
const ADC_SAFE_LO = 500;
const ADC_SAFE_HI = 3500;
const VCC_MV = 3300;
const STORAGE_KEY_V3 = 'omnisense_ohm_meter_lab_v3';
const STORAGE_KEY_V2 = 'omnisense_ohm_meter_lab_v2';

const PRESET_MODES = ['adc', 'adc', 'adc', 'adc', 'adc', 'dig', 'dig', 'dig', 'dig'];

/** 擴展模式：公式 R_pullup 標稱（外接上拉） */
const EXT_RANGE_MODES = [
    { id: '10k', label: '10 kΩ', rPuNom: 10e3 },
    { id: '100k', label: '100 kΩ', rPuNom: 100e3 },
    { id: '1M', label: '1 MΩ', rPuNom: 1e6 }
];

const ADC_ATTACH_MAX = 3480;
const ADC_REMOVE_MIN = 3680;
const SETTLE_NEED = 14;
const SETTLE_SPREAD_MAX = 10;
const SETTLE_BUF_MAX = 24;

let rootEl = null;
let styleLink = null;
let dataHandler = null;
let vizP5 = null;

let lastAdc = 0;

/** @type {'builtin' | 'extension'} */
let wiringMode = 'builtin';
/** 擴展模式腳位（邏輯通道 0|1|3|4） */
let extLogicalCh = 0;
let extRangeId = '10k';

/** @type {Record<string, { rPuCal: number | null, samples: { r: number; adc: number }[] }>} */
let labByKey = {};

let measurePhase = 'no_dut';
let settleBuf = [];
let lockedAdc = null;
let lockedRxVal = null;

function injectCss() {
    if (styleLink) return;
    styleLink = document.createElement('link');
    styleLink.rel = 'stylesheet';
    styleLink.href = new URL('./style.css', import.meta.url).href;
    document.head.appendChild(styleLink);
}

function loadP5() {
    if (window.p5) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.4.0/p5.js';
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('p5'));
        document.head.appendChild(s);
    });
}

function labKey() {
    if (wiringMode === 'builtin') return 'builtin';
    return `ext:${extLogicalCh}:${extRangeId}`;
}

function getLab() {
    const k = labKey();
    if (!labByKey[k]) labByKey[k] = emptyLabEntry();
    return labByKey[k];
}

function getRange() {
    if (wiringMode === 'builtin') {
        return { id: 'builtin', label: '內建 10kΩ', rPuNom: 10e3 };
    }
    return EXT_RANGE_MODES.find((m) => m.id === extRangeId) || EXT_RANGE_MODES[0];
}

function currentLogicalCh() {
    return wiringMode === 'builtin' ? CH_BUILTIN : extLogicalCh;
}

function logicalToGpio(logical) {
    const row = PINS_CONFIG.find((p) => p.id === logical);
    return row ? row.gpio : logical;
}

function rPuEffective() {
    const L = getLab();
    const nom = getRange().rPuNom;
    return L.rPuCal != null && Number.isFinite(L.rPuCal) ? L.rPuCal : nom;
}

function adcToMv(adc) {
    return (adc / ADC_MAX) * VCC_MV;
}

function rxIdeal(adc, rPu) {
    if (adc <= 0 || adc >= ADC_MAX) return NaN;
    return (rPu * adc) / (ADC_MAX - adc);
}

function rxDisplay(adc) {
    return rxIdeal(adc, rPuEffective());
}

function rPullupFromKnownRAndAdc(rKnown, adc) {
    const v = adcToMv(adc);
    if (!Number.isFinite(rKnown) || rKnown <= 0) return NaN;
    if (v <= 1 || v >= VCC_MV - 1) return NaN;
    return (rKnown * (VCC_MV - v)) / v;
}

function estimateRPuFromSamples(samples, rPuNom) {
    const est = [];
    for (const p of samples) {
        const rp = rPullupFromKnownRAndAdc(p.r, p.adc);
        if (Number.isFinite(rp) && rp > 0) est.push(rp);
    }
    if (!est.length) return rPuNom;
    return est.reduce((a, b) => a + b, 0) / est.length;
}

function theoreticalAdcFromR(rOhms, rPu) {
    if (!Number.isFinite(rOhms) || !Number.isFinite(rPu) || rOhms <= 0 || rPu <= 0) return NaN;
    const x = (ADC_MAX * rOhms) / (rOhms + rPu);
    return Math.max(0, Math.min(ADC_MAX, x));
}

function boundaryRAt(adcGate, rPu) {
    return rxIdeal(adcGate, rPu);
}

function formatOhm(r) {
    if (!Number.isFinite(r) || r <= 0) return '—';
    if (r >= 1e6) return `${(r / 1e6).toFixed(3)} MΩ`;
    if (r >= 1e3) return `${(r / 1e3).toFixed(3)} kΩ`;
    return `${r.toFixed(1)} Ω`;
}

function emptyLabEntry() {
    return { rPuCal: null, samples: [] };
}

function normalizeLabEntry(raw) {
    const e = emptyLabEntry();
    if (!raw || typeof raw !== 'object') return e;
    e.rPuCal = raw.rPuCal != null && Number.isFinite(Number(raw.rPuCal)) ? Number(raw.rPuCal) : null;
    e.samples = Array.isArray(raw.samples)
        ? raw.samples.map((s) => ({ r: Number(s.r), adc: Number(s.adc) })).filter((s) => Number.isFinite(s.r) && s.r > 0)
        : [];
    return e;
}

function ensureDefaultLabKeys() {
    if (!labByKey.builtin) labByKey.builtin = emptyLabEntry();
    for (const ch of EXT_CHANNELS) {
        for (const m of EXT_RANGE_MODES) {
            const k = `ext:${ch}:${m.id}`;
            if (!labByKey[k]) labByKey[k] = emptyLabEntry();
        }
    }
}

function migrateFromV2(raw) {
    try {
        const o = JSON.parse(raw);
        wiringMode = 'builtin';
        extLogicalCh = 0;
        extRangeId = EXT_RANGE_MODES.some((m) => m.id === o.rangeId) ? o.rangeId : '10k';
        const legacy = o.labByRange || {};
        labByKey = {
            builtin: normalizeLabEntry(legacy['10k'])
        };
        for (const rid of ['10k', '100k', '1M']) {
            labByKey[`ext:0:${rid}`] = normalizeLabEntry(legacy[rid]);
        }
        ensureDefaultLabKeys();
    } catch {
        labByKey = { builtin: emptyLabEntry() };
        ensureDefaultLabKeys();
    }
}

function tryMigrateFromV1() {
    try {
        const raw = localStorage.getItem('omnisense_ohm_meter_lab_v1');
        if (!raw) return;
        const o = JSON.parse(raw);
        const legacy = o.labByRange || {};
        labByKey = {
            builtin: normalizeLabEntry(legacy['10k'])
        };
        for (const rid of ['10k', '100k', '1M']) {
            labByKey[`ext:0:${rid}`] = normalizeLabEntry(legacy[rid]);
        }
        extRangeId =
            o.rangeId && EXT_RANGE_MODES.some((m) => m.id === o.rangeId) ? o.rangeId : '10k';
        wiringMode = 'builtin';
        extLogicalCh = 0;
        ensureDefaultLabKeys();
        saveStorage();
    } catch {
        /* ignore */
    }
}

function loadStorage() {
    try {
        const v3 = localStorage.getItem(STORAGE_KEY_V3);
        if (v3) {
            const o = JSON.parse(v3);
            labByKey = typeof o.labByKey === 'object' && o.labByKey ? { ...o.labByKey } : {};
            wiringMode = o.wiringMode === 'extension' ? 'extension' : 'builtin';
            extLogicalCh = EXT_CHANNELS.includes(Number(o.extLogicalCh)) ? Number(o.extLogicalCh) : 0;
            extRangeId = EXT_RANGE_MODES.some((m) => m.id === o.extRangeId) ? o.extRangeId : '10k';
            ensureDefaultLabKeys();
            return;
        }
        const v2 = localStorage.getItem(STORAGE_KEY_V2);
        if (v2) {
            migrateFromV2(v2);
            saveStorage();
            return;
        }
        tryMigrateFromV1();
        if (!Object.keys(labByKey).length) {
            labByKey = { builtin: emptyLabEntry() };
            ensureDefaultLabKeys();
        }
    } catch {
        labByKey = { builtin: emptyLabEntry() };
        ensureDefaultLabKeys();
    }
}

function saveStorage() {
    try {
        ensureDefaultLabKeys();
        localStorage.setItem(
            STORAGE_KEY_V3,
            JSON.stringify({
                version: 3,
                wiringMode,
                extLogicalCh,
                extRangeId,
                labByKey
            })
        );
    } catch {
        /* ignore */
    }
}

function exportJson() {
    const blob = new Blob(
        [JSON.stringify({ version: 3, wiringMode, extLogicalCh, extRangeId, labByKey }, null, 2)],
        { type: 'application/json' }
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ohm-meter-lab-calibration.json';
    a.click();
    URL.revokeObjectURL(a.href);
}

function resetMeasurePipeline() {
    measurePhase = 'no_dut';
    settleBuf = [];
    lockedAdc = null;
    lockedRxVal = null;
}

function stepMeasurePipeline(adc) {
    if (measurePhase === 'no_dut') {
        if (adc <= ADC_ATTACH_MAX) {
            measurePhase = 'settling';
            settleBuf = [adc];
        }
        return;
    }
    if (adc >= ADC_REMOVE_MIN) {
        resetMeasurePipeline();
        return;
    }
    if (measurePhase === 'settling') {
        settleBuf.push(adc);
        if (settleBuf.length > SETTLE_BUF_MAX) settleBuf.shift();
        if (settleBuf.length < SETTLE_NEED) return;
        const mn = Math.min(...settleBuf);
        const mx = Math.max(...settleBuf);
        if (mx - mn > SETTLE_SPREAD_MAX) return;
        const avg = settleBuf.reduce((a, b) => a + b, 0) / settleBuf.length;
        const rxTry = rxDisplay(avg);
        if (avg < 8 || avg > ADC_MAX - 8 || !Number.isFinite(rxTry)) return;
        lockedAdc = avg;
        lockedRxVal = rxTry;
        measurePhase = 'locked';
        return;
    }
}

function updateMeasureUi() {
    const adcLive = lastAdc;
    const rPu = rPuEffective();
    const vMvLive = adcToMv(adcLive);
    const elR = rootEl?.querySelector('#ohm-rx-val');
    const elRaw = rootEl?.querySelector('#ohm-adc-raw');
    const elWarn = rootEl?.querySelector('#ohm-warn');

    if (elR) {
        if (measurePhase === 'no_dut') elR.textContent = '—';
        else if (measurePhase === 'settling') {
            const n = settleBuf.length;
            elR.textContent = n >= 4 ? `${formatOhm(rxDisplay(settleBuf.reduce((a, b) => a + b, 0) / n))}（平均中）` : '…';
        } else elR.textContent = formatOhm(lockedRxVal);
    }

    if (elRaw) {
        if (measurePhase === 'no_dut') {
            elRaw.textContent = `ADC ${adcLive.toFixed(0)} · ${vMvLive.toFixed(0)} mV · R′${formatOhm(rPu)}`;
        } else if (measurePhase === 'settling') {
            elRaw.textContent = `${adcLive.toFixed(0)} · ${settleBuf.length}/${SETTLE_NEED}`;
        } else {
            const v = adcToMv(lockedAdc ?? 0);
            elRaw.textContent = `鎖定 ADC ${(lockedAdc ?? 0).toFixed(0)} · ${v.toFixed(0)} mV`;
        }
    }

    if (!elWarn) return;
    elWarn.classList.remove('ohm-warn--ok', 'hidden');

    if (measurePhase === 'no_dut') {
        elWarn.textContent = '接上待測電阻到量測腳與 GND。';
        elWarn.classList.remove('ohm-warn--ok');
        return;
    }

    const adcHint = measurePhase === 'locked' ? lockedAdc ?? adcLive : adcLive;
    if (!Number.isFinite(adcHint)) {
        elWarn.textContent = '…';
        return;
    }

    if (measurePhase === 'settling') {
        elWarn.textContent = '穩定中…';
        elWarn.classList.add('ohm-warn--ok');
        return;
    }

    if (adcHint < ADC_SAFE_LO) {
        const x = boundaryRAt(ADC_SAFE_LO, rPu);
        elWarn.textContent = `讀值偏低 → R < ${formatOhm(x)}（可改擴展／上拉）`;
        elWarn.classList.remove('ohm-warn--ok');
    } else if (adcHint > ADC_SAFE_HI) {
        const x = boundaryRAt(ADC_SAFE_HI, rPu);
        elWarn.textContent = `讀值偏高 → R > ${formatOhm(x)}（可改擴展／上拉）`;
        elWarn.classList.remove('ohm-warn--ok');
    } else {
        elWarn.textContent = '已鎖定。取下元件後重新量測。';
        elWarn.classList.add('ohm-warn--ok');
    }
}

function renderLabTable() {
    const tb = rootEl?.querySelector('#ohm-samples-body');
    if (!tb) return;
    const samples = getLab().samples;
    tb.innerHTML = samples
        .map(
            (row, i) =>
                `<tr><td>${i + 1}</td><td>${row.r}</td><td>${adcToMv(row.adc).toFixed(1)}</td><td>${row.adc.toFixed(0)}</td></tr>`
        )
        .join('');
}

function updateLabOut() {
    const L = getLab();
    const out = rootEl?.querySelector('#ohm-lab-out');
    if (!out) return;
    const nom = getRange().rPuNom;
    const lines = [];
    if (L.samples.length) {
        const est = estimateRPuFromSamples(L.samples, nom);
        lines.push(`估 R_pullup ≈ ${formatOhm(est)}（標稱 ${formatOhm(nom)}）`);
    }
    if (L.rPuCal != null && Number.isFinite(L.rPuCal)) {
        lines.push(`已套用 R_pullup′ = ${formatOhm(L.rPuCal)}`);
    } else {
        lines.push('未套用校準：使用標稱上拉。');
    }
    out.textContent = lines.join('\n');
}

function onData(ev) {
    if (omni.currentViewId !== 'ohm-meter-lab') return;
    const ch = ev.detail.channels[currentLogicalCh()];
    if (!ch) return;
    lastAdc = ch.filtered;
    stepMeasurePipeline(lastAdc);
    updateMeasureUi();
    vizP5?.redraw();
}

function mountP5(host) {
    const P = window.p5;
    vizP5 = new P((p) => {
        p.setup = () => {
            p.createCanvas(Math.max(280, host.clientWidth || 320), 240).parent(host);
            p.noLoop();
        };
        p.draw = () => {
            p.background(12, 18, 34);
            const samples = getLab().samples;
            const rPuPlot = rPuEffective();
            const pad = 36;
            const w = p.width - pad * 2;
            const h = p.height - pad * 2;
            if (samples.length === 0) {
                p.fill(100, 116, 139);
                p.textAlign(p.CENTER, p.CENTER);
                p.textSize(12);
                p.text('The Lab 記錄採樣後顯示', p.width / 2, p.height / 2);
                return;
            }
            const rs = samples.map((s) => s.r);
            const ads = samples.map((s) => s.adc);
            let rMin = Math.min(...rs);
            let rMax = Math.max(...rs);
            let aMin = Math.min(...ads);
            let aMax = Math.max(...ads);
            const rLo = Math.max(1, rMin * 0.85);
            const rHi = rMax * 1.15;
            const steps = 64;
            for (let i = 0; i <= steps; i++) {
                const rr = rLo + (i / steps) * Math.max(rHi - rLo, 1e-9);
                const ad = theoreticalAdcFromR(rr, rPuPlot);
                if (Number.isFinite(ad)) {
                    aMin = Math.min(aMin, ad);
                    aMax = Math.max(aMax, ad);
                }
            }
            aMin = Math.max(0, aMin - 80);
            aMax = Math.min(ADC_MAX, aMax + 80);
            const sx = (r) => pad + ((r - rLo) / Math.max(rHi - rLo, 1e-9)) * w;
            const sy = (ad) => pad + h - ((ad - aMin) / Math.max(aMax - aMin, 1e-9)) * h;

            p.stroke(51, 65, 85);
            p.line(pad, pad + h, pad + w, pad + h);
            p.line(pad, pad, pad, pad + h);
            p.fill(148, 163, 184);
            p.noStroke();
            p.textSize(9);
            p.text('R_x', pad + w / 2, p.height - 8);
            p.push();
            p.translate(12, pad + h / 2);
            p.rotate(-p.HALF_PI);
            p.text('ADC', 0, 0);
            p.pop();

            p.stroke(56, 189, 248, 120);
            p.strokeWeight(1);
            for (let i = 0; i <= 4; i++) {
                const gx = pad + (i * w) / 4;
                p.line(gx, pad, gx, pad + h);
            }

            p.stroke(167, 139, 250, 220);
            p.strokeWeight(2);
            p.noFill();
            p.beginShape();
            for (let i = 0; i <= steps; i++) {
                const rr = rLo + (i / steps) * (rHi - rLo);
                const ad = theoreticalAdcFromR(rr, rPuPlot);
                if (Number.isFinite(ad)) p.vertex(sx(rr), sy(ad));
            }
            p.endShape();

            p.fill(34, 211, 238);
            p.noStroke();
            for (let i = 0; i < samples.length; i++) {
                p.circle(sx(samples[i].r), sy(samples[i].adc), 7);
            }
        };
    }, host);
}

function refreshWiringUi() {
    const extPanel = rootEl?.querySelector('#ohm-ext-controls');
    const hint = rootEl?.querySelector('#ohm-builtin-hint');
    if (extPanel) extPanel.classList.toggle('hidden', wiringMode !== 'extension');
    if (hint) hint.classList.toggle('hidden', wiringMode !== 'builtin');

    rootEl?.querySelectorAll('[data-wiring]').forEach((b) => {
        const on = b.getAttribute('data-wiring') === wiringMode;
        b.classList.toggle('ohm-wiring-btn--on', on);
    });

    rootEl?.querySelectorAll('[data-ext-range]').forEach((b) => {
        b.classList.toggle('ohm-mode-btn--on', b.getAttribute('data-ext-range') === extRangeId);
    });

    const sel = rootEl?.querySelector('#ohm-ext-pin');
    if (sel && sel.value !== String(extLogicalCh)) sel.value = String(extLogicalCh);
}

function wireUi() {
    rootEl?.querySelectorAll('[data-wiring]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const w = btn.getAttribute('data-wiring');
            if (w !== 'builtin' && w !== 'extension') return;
            wiringMode = w;
            resetMeasurePipeline();
            saveStorage();
            refreshWiringUi();
            await applyPreset();
            updateMeasureUi();
            renderLabTable();
            updateLabOut();
            vizP5?.redraw();
        });
    });

    rootEl?.querySelector('#ohm-ext-pin')?.addEventListener('change', async (e) => {
        const v = parseInt(e.target.value, 10);
        if (!EXT_CHANNELS.includes(v)) return;
        extLogicalCh = v;
        resetMeasurePipeline();
        saveStorage();
        await applyPreset();
        updateMeasureUi();
        renderLabTable();
        updateLabOut();
        vizP5?.redraw();
    });

    EXT_RANGE_MODES.forEach((m) => {
        rootEl?.querySelector(`[data-ext-range="${m.id}"]`)?.addEventListener('click', async () => {
            extRangeId = m.id;
            resetMeasurePipeline();
            saveStorage();
            refreshWiringUi();
            await applyPreset();
            updateMeasureUi();
            renderLabTable();
            updateLabOut();
            vizP5?.redraw();
        });
    });

    rootEl?.querySelectorAll('.ohm-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            const id = tab.getAttribute('data-tab');
            rootEl?.querySelectorAll('.ohm-tab').forEach((t) => {
                t.classList.toggle('ohm-tab--active', t.getAttribute('data-tab') === id);
            });
            rootEl?.querySelectorAll('.ohm-panel').forEach((pan) => {
                pan.classList.toggle('ohm-panel--visible', pan.getAttribute('data-panel') === id);
            });
            vizP5?.redraw();
        });
    });

    rootEl?.querySelector('#ohm-record')?.addEventListener('click', () => {
        const inp = rootEl?.querySelector('#ohm-known-r');
        const v = parseFloat(inp?.value || '');
        if (!Number.isFinite(v) || v <= 0) {
            window.alert('請輸入有效的已知電阻值（Ω）。');
            return;
        }
        getLab().samples.push({ r: v, adc: lastAdc });
        saveStorage();
        renderLabTable();
        updateLabOut();
        vizP5?.redraw();
    });

    rootEl?.querySelector('#ohm-clear-samples')?.addEventListener('click', () => {
        const L = getLab();
        L.samples = [];
        L.rPuCal = null;
        saveStorage();
        renderLabTable();
        updateLabOut();
        vizP5?.redraw();
    });

    rootEl?.querySelector('#ohm-fit')?.addEventListener('click', () => {
        const L = getLab();
        const pts = L.samples;
        if (pts.length < 1) {
            window.alert('請至少記錄 1 個採樣點。');
            return;
        }
        const meanPu = estimateRPuFromSamples(pts, getRange().rPuNom);
        if (!Number.isFinite(meanPu) || meanPu <= 0) {
            window.alert('無法計算 R_pullup。');
            return;
        }
        L.rPuCal = meanPu;
        saveStorage();
        updateLabOut();
        updateMeasureUi();
        vizP5?.redraw();
        if (pts.length < 3) window.alert('採樣點較少時誤差大，建議多記錄幾點。');
    });

    rootEl?.querySelector('#ohm-export')?.addEventListener('click', exportJson);

    rootEl?.querySelector('#ohm-import')?.addEventListener('change', (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        const r = new FileReader();
        r.onload = () => {
            try {
                const o = JSON.parse(String(r.result));
                if (o.version === 3 && o.labByKey) {
                    labByKey = { ...o.labByKey };
                    wiringMode = o.wiringMode === 'extension' ? 'extension' : 'builtin';
                    extLogicalCh = EXT_CHANNELS.includes(Number(o.extLogicalCh)) ? Number(o.extLogicalCh) : 0;
                    extRangeId = EXT_RANGE_MODES.some((m) => m.id === o.extRangeId) ? o.extRangeId : '10k';
                } else if (o.labByRange) {
                    migrateFromV2(JSON.stringify(o));
                } else {
                    throw new Error('格式不符');
                }
                ensureDefaultLabKeys();
                saveStorage();
                resetMeasurePipeline();
                refreshWiringUi();
                void applyPreset();
                renderLabTable();
                updateLabOut();
                updateMeasureUi();
                vizP5?.redraw();
            } catch (err) {
                window.alert('匯入失敗：' + err);
            }
        };
        r.readAsText(f);
        const t = e.target;
        if (t) t.value = '';
    });
}

async function applyPreset() {
    if (!ble.getRxChar()) return;
    const ch = currentLogicalCh();
    const mask = (1 << ch) & 0x01ff;
    omni.channelMode = [...PRESET_MODES];
    omni.activeMask = mask;
    omni.pullupMask = wiringMode === 'builtin' ? mask : 0;
    await applyDeviceConfig({
        freq: omni.lastFreq,
        res: omni.lastRes,
        activeMask: omni.activeMask,
        pullupMask: omni.pullupMask,
        touchMask: computeTouchModeMask()
    });
    const si = document.getElementById('syncIndicator');
    const g = logicalToGpio(ch);
    const tag = wiringMode === 'builtin' ? '內建' : '擴展';
    if (si) si.innerText = `⚡ Ohm G${g}（${tag}）`;
}

function extPinOptionsHtml() {
    return EXT_CHANNELS.map((lc) => {
        const g = logicalToGpio(lc);
        return `<option value="${lc}">G${g}</option>`;
    }).join('');
}

function extRangeBtnsHtml() {
    return EXT_RANGE_MODES.map(
        (m) =>
            `<button type="button" class="ohm-mode-btn ${m.id === extRangeId ? 'ohm-mode-btn--on' : ''}" data-ext-range="${m.id}">${m.label}</button>`
    ).join('');
}

function buildDom(root) {
    root.innerHTML = `
<div class="ohm-root">
  <div class="ohm-hero">
    <div class="ohm-title">Ohmic Master</div>
  </div>
  <div class="ohm-tabs">
    <button type="button" class="ohm-tab ohm-tab--active" data-tab="m">測量</button>
    <button type="button" class="ohm-tab" data-tab="lab">The Lab</button>
  </div>
  <div class="ohm-panel ohm-panel--visible ohm-panel--compact" data-panel="m">
    <div class="ohm-wiring-row">
      <button type="button" class="ohm-wiring-btn ohm-wiring-btn--on" data-wiring="builtin">內建</button>
      <button type="button" class="ohm-wiring-btn" data-wiring="extension">擴展</button>
    </div>
    <p id="ohm-builtin-hint" class="ohm-hint">G2 · 10kΩ</p>
    <div id="ohm-ext-controls" class="hidden">
      <div class="ohm-input-row ohm-input-row--tight">
        <label for="ohm-ext-pin">腳位</label>
        <select id="ohm-ext-pin" class="ohm-select">${extPinOptionsHtml()}</select>
      </div>
      <div class="ohm-mode-row" id="ohm-ext-ranges">${extRangeBtnsHtml()}</div>
    </div>
    <div class="ohm-readout">
      <div class="ohm-readout-label">R<sub>x</sub></div>
      <div class="ohm-readout-val" id="ohm-rx-val">—</div>
      <div class="ohm-readout-raw" id="ohm-adc-raw"></div>
    </div>
    <div class="ohm-warn ohm-warn--ok" id="ohm-warn">連線後量測。</div>
  </div>
  <div class="ohm-panel" data-panel="lab">
    <p class="ohm-lab-lead">已知 R、讀值穩定後「記錄」，再「套用校準」。</p>
    <div class="ohm-lab-grid">
      <div class="ohm-input-row">
        <label for="ohm-known-r">R (Ω)</label>
        <input type="number" id="ohm-known-r" min="1" step="any" placeholder="1000">
        <button type="button" class="ohm-btn" id="ohm-record">記錄</button>
      </div>
      <table class="ohm-table">
        <thead><tr><th>#</th><th>R</th><th>mV</th><th>ADC</th></tr></thead>
        <tbody id="ohm-samples-body"></tbody>
      </table>
      <div class="ohm-input-row">
        <button type="button" class="ohm-btn" id="ohm-fit">套用校準</button>
        <button type="button" class="ohm-btn" id="ohm-clear-samples">清除</button>
      </div>
      <pre class="ohm-lab-out" id="ohm-lab-out"></pre>
      <div class="ohm-input-row">
        <button type="button" class="ohm-btn" id="ohm-export">匯出 JSON</button>
        <label class="ohm-btn" style="cursor:pointer;display:inline-block;">
          匯入
          <input type="file" id="ohm-import" accept="application/json,.json" style="display:none">
        </label>
      </div>
    </div>
    <div class="ohm-canvas-host" id="ohm-canvas-host"></div>
  </div>
</div>`;
}

export async function init(root) {
    injectCss();
    await loadP5();
    rootEl = root;
    omni.currentViewId = 'ohm-meter-lab';
    loadStorage();
    buildDom(root);
    refreshWiringUi();
    resetMeasurePipeline();
    mountP5(root.querySelector('#ohm-canvas-host'));
    wireUi();
    dataHandler = onData;
    window.addEventListener('omnisense:data', dataHandler);
    renderLabTable();
    updateLabOut();
    updateMeasureUi();
    if (window.lucide) window.lucide.createIcons();
}

export async function mount(root) {
    await init(root);
}

export async function onConnected() {
    if (typeof window !== 'undefined' && window.__omnisenseSkipExperimentDefaultPreset) return;
    await applyPreset();
}

export async function cleanup() {
    window.removeEventListener('omnisense:data', dataHandler);
    dataHandler = null;
    if (vizP5) {
        vizP5.remove();
        vizP5 = null;
    }
    if (styleLink?.parentNode) styleLink.remove();
    styleLink = null;
    if (rootEl) {
        rootEl.innerHTML = '';
        rootEl = null;
    }
}

export async function unmount() {
    await cleanup();
}
