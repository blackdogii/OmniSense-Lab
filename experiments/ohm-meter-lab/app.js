/**
 * Ohm-Meter-Lab — 電阻鑑定師：精準之路（Ohmic Master）
 * 分壓模型：V = Vcc·R_x/(R_x+R_pullup)；上行為 0–4095 比例讀值（名義對應 Vcc=3.3V）。
 * 舊韌體仍可直接使用；燒錄含 ADC 校正／過採樣之韌體可再提升讀值與電阻換算穩定度。
 */

import { omni } from '../../web/core/state.js';
import { applyDeviceConfig } from '../../web/core/configApply.js';
import { computeTouchModeMask } from '../../web/core/touchMask.js';
import * as ble from '../../web/core/ble.js';

const CH_ADC = 2;
const ADC_MAX = 4095;
const ADC_SAFE_LO = 500;
const ADC_SAFE_HI = 3500;
/** 與韌體 kDividerVddNomMv、分壓假設一致（mV） */
const VCC_MV = 3300;
const STORAGE_KEY = 'omnisense_ohm_meter_lab_v2';

const PRESET_ACTIVE = 1 << CH_ADC;
const PRESET_PULLUP = 1 << CH_ADC;
const PRESET_MODES = ['adc', 'adc', 'adc', 'adc', 'adc', 'dig', 'dig', 'dig', 'dig'];

/** 三種量程：標稱上拉電阻實體（G2 內建上拉約 10kΩ 量程；校準可更新 R_pullup） */
const RANGE_MODES = [
    { id: '10k', label: '低阻程 · 10kΩ 上拉', rPuNom: 10e3 },
    { id: '100k', label: '中阻程 · 100kΩ 上拉', rPuNom: 100e3 },
    { id: '1M', label: '高阻程 · 1MΩ 上拉', rPuNom: 1e6 }
];

let rootEl = null;
let styleLink = null;
let dataHandler = null;
let vizP5 = null;

let lastAdc = 0;
let rangeId = '10k';

/** @type {Record<string, { rPuCal: number | null, samples: { r: number; adc: number }[] }>} */
let labByRange = {
    '10k': { rPuCal: null, samples: [] },
    '100k': { rPuCal: null, samples: [] },
    '1M': { rPuCal: null, samples: [] }
};

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

function getRange() {
    return RANGE_MODES.find((m) => m.id === rangeId) || RANGE_MODES[0];
}

function rPuEffective() {
    const L = labByRange[rangeId];
    const nom = getRange().rPuNom;
    return L.rPuCal != null && Number.isFinite(L.rPuCal) ? L.rPuCal : nom;
}

/** Map uplink code (0–4095) to equivalent pin voltage in mV (nominal full-scale = Vcc). */
function adcToMv(adc) {
    return (adc / ADC_MAX) * VCC_MV;
}

/**
 * Divider: V = Vcc * R_x / (R_x + R_pullup) => R_x = R_pullup * V / (Vcc - V).
 * With V/Vcc = adc/ADC_MAX: R_x = R_pullup * adc / (ADC_MAX - adc).
 */
function rxIdeal(adc, rPu) {
    if (adc <= 0 || adc >= ADC_MAX) return NaN;
    return (rPu * adc) / (ADC_MAX - adc);
}

function rxDisplay(adc) {
    return rxIdeal(adc, rPuEffective());
}

/** R_pullup = R_known * (Vcc - V) / V per calibration point */
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

/** Theoretical monotonic curve (ADC code vs R): adc = ADC_MAX * R / (R + R_pullup) */
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

function loadStorage() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            tryMigrateFromV1();
            return;
        }
        const o = JSON.parse(raw);
        if (o.labByRange && typeof o.labByRange === 'object') {
            for (const id of Object.keys(labByRange)) {
                if (o.labByRange[id]) labByRange[id] = normalizeLabEntry(o.labByRange[id]);
            }
        }
        if (o.rangeId && RANGE_MODES.some((m) => m.id === o.rangeId)) rangeId = o.rangeId;
    } catch {
        /* ignore */
    }
}

/** Legacy key v1: drop quadratic poly, keep samples / rPuCal */
function tryMigrateFromV1() {
    try {
        const raw = localStorage.getItem('omnisense_ohm_meter_lab_v1');
        if (!raw) return;
        const o = JSON.parse(raw);
        if (o.labByRange && typeof o.labByRange === 'object') {
            for (const id of Object.keys(labByRange)) {
                if (!o.labByRange[id]) continue;
                const row = o.labByRange[id];
                labByRange[id] = normalizeLabEntry({
                    rPuCal: row.rPuCal,
                    samples: row.samples
                });
            }
        }
        if (o.rangeId && RANGE_MODES.some((m) => m.id === o.rangeId)) rangeId = o.rangeId;
        saveStorage();
    } catch {
        /* ignore */
    }
}

function saveStorage() {
    try {
        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({ version: 2, rangeId, labByRange })
        );
    } catch {
        /* ignore */
    }
}

function exportJson() {
    const blob = new Blob([JSON.stringify({ version: 2, rangeId, labByRange }, null, 2)], {
        type: 'application/json'
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ohm-meter-lab-calibration.json';
    a.click();
    URL.revokeObjectURL(a.href);
}

function updateMeasureUi() {
    const adc = lastAdc;
    const rPu = rPuEffective();
    const rx = rxDisplay(adc);
    const vMv = adcToMv(adc);
    const elR = rootEl?.querySelector('#ohm-rx-val');
    const elRaw = rootEl?.querySelector('#ohm-adc-raw');
    const elWarn = rootEl?.querySelector('#ohm-warn');
    if (elR) elR.textContent = formatOhm(rx);
    if (elRaw) {
        elRaw.textContent = `換算電壓 ≈ ${vMv.toFixed(1)} mV（名義 ${VCC_MV} mV 滿刻度）· 比例讀值 ${adc.toFixed(0)} · R_pullup′ = ${formatOhm(rPu)}`;
    }

    if (!elWarn) return;
    elWarn.classList.remove('ohm-warn--ok', 'hidden');
    if (adc < ADC_SAFE_LO) {
        const x = boundaryRAt(ADC_SAFE_LO, rPu);
        elWarn.textContent = `量程提示：讀值 < ${ADC_SAFE_LO} → 電阻 < ${formatOhm(x)}（易飽和，請換高阻程或檢查接線）`;
        elWarn.classList.remove('ohm-warn--ok');
    } else if (adc > ADC_SAFE_HI) {
        const x = boundaryRAt(ADC_SAFE_HI, rPu);
        elWarn.textContent = `量程提示：讀值 > ${ADC_SAFE_HI} → 電阻 > ${formatOhm(x)}（易飽和，請換低阻程）`;
        elWarn.classList.remove('ohm-warn--ok');
    } else {
        elWarn.textContent = '讀值在建議窗內（500–3500）。';
        elWarn.classList.add('ohm-warn--ok');
    }
}

function renderLabTable() {
    const tb = rootEl?.querySelector('#ohm-samples-body');
    if (!tb) return;
    const samples = labByRange[rangeId].samples;
    tb.innerHTML = samples
        .map(
            (row, i) =>
                `<tr><td>${i + 1}</td><td>${row.r}</td><td>${adcToMv(row.adc).toFixed(1)}</td><td>${row.adc.toFixed(0)}</td></tr>`
        )
        .join('');
}

function updateLabOut() {
    const L = labByRange[rangeId];
    const out = rootEl?.querySelector('#ohm-lab-out');
    if (!out) return;
    const lines = [];
    const nom = getRange().rPuNom;
    lines.push(`分壓模型：V = ${VCC_MV} mV × R_x / (R_x + R_pullup)；採樣點反推 R_pullup = R_已知 × (Vcc − V) / V。`);
    if (L.samples.length) {
        const est = estimateRPuFromSamples(L.samples, nom);
        lines.push(`由目前採樣點估算之平均 R_pullup ≈ ${formatOhm(est)}（標稱量程 ${formatOhm(nom)}）。`);
    }
    if (L.rPuCal != null && Number.isFinite(L.rPuCal)) {
        lines.push(`已套用儲存之 R_pullup′ = ${formatOhm(L.rPuCal)}。`);
    } else {
        lines.push('尚未套用校準：測量使用標稱量程電阻；完成採樣後按「套用分壓校準」。');
    }
    out.textContent = lines.join('\n');
}

function onData(ev) {
    if (omni.currentViewId !== 'ohm-meter-lab') return;
    const ch = ev.detail.channels[CH_ADC];
    if (!ch) return;
    lastAdc = ch.filtered;
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
            const samples = labByRange[rangeId].samples;
            const rPuPlot = rPuEffective();
            const pad = 36;
            const w = p.width - pad * 2;
            const h = p.height - pad * 2;
            if (samples.length === 0) {
                p.fill(100, 116, 139);
                p.textAlign(p.CENTER, p.CENTER);
                p.textSize(12);
                p.text('於「The Lab」記錄採樣點後顯示 R–ADC 圖', p.width / 2, p.height / 2);
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
            p.text('R_x (Ω)', pad + w / 2, p.height - 8);
            p.push();
            p.translate(12, pad + h / 2);
            p.rotate(-p.HALF_PI);
            p.text('換算讀值 0–4095', 0, 0);
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

function wireUi() {
    RANGE_MODES.forEach((m) => {
        rootEl?.querySelector(`[data-range="${m.id}"]`)?.addEventListener('click', () => {
            rangeId = m.id;
            rootEl?.querySelectorAll('.ohm-mode-btn').forEach((b) => {
                b.classList.toggle('ohm-mode-btn--on', b.getAttribute('data-range') === rangeId);
            });
            saveStorage();
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
        labByRange[rangeId].samples.push({ r: v, adc: lastAdc });
        saveStorage();
        renderLabTable();
        updateLabOut();
        vizP5?.redraw();
    });

    rootEl?.querySelector('#ohm-clear-samples')?.addEventListener('click', () => {
        labByRange[rangeId].samples = [];
        labByRange[rangeId].rPuCal = null;
        saveStorage();
        renderLabTable();
        updateLabOut();
        vizP5?.redraw();
    });

    rootEl?.querySelector('#ohm-fit')?.addEventListener('click', () => {
        const L = labByRange[rangeId];
        const pts = L.samples;
        if (pts.length < 1) {
            window.alert('請至少記錄 1 個採樣點（建議 3 個以上以平均 R_pullup）。');
            return;
        }
        const meanPu = estimateRPuFromSamples(pts, getRange().rPuNom);
        if (!Number.isFinite(meanPu) || meanPu <= 0) {
            window.alert('無法由採樣點計算 R_pullup（檢查電壓是否過近 0 或滿刻度）。');
            return;
        }
        L.rPuCal = meanPu;
        saveStorage();
        updateLabOut();
        updateMeasureUi();
        vizP5?.redraw();
        if (pts.length < 3) {
            window.alert('已套用平均 R_pullup；採樣點較少時誤差較大，建議再記錄幾點後重算。');
        }
    });

    rootEl?.querySelector('#ohm-export')?.addEventListener('click', exportJson);

    rootEl?.querySelector('#ohm-import')?.addEventListener('change', (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        const r = new FileReader();
        r.onload = () => {
            try {
                const o = JSON.parse(String(r.result));
                if (o.labByRange) {
                    labByRange = {
                        '10k': emptyLabEntry(),
                        '100k': emptyLabEntry(),
                        '1M': emptyLabEntry()
                    };
                    for (const id of Object.keys(labByRange)) {
                        if (o.labByRange[id]) {
                            labByRange[id] = normalizeLabEntry(o.labByRange[id]);
                        }
                    }
                }
                if (o.rangeId && RANGE_MODES.some((m) => m.id === o.rangeId)) rangeId = o.rangeId;
                saveStorage();
                rootEl?.querySelectorAll('.ohm-mode-btn').forEach((b) => {
                    b.classList.toggle('ohm-mode-btn--on', b.getAttribute('data-range') === rangeId);
                });
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
    omni.channelMode = [...PRESET_MODES];
    omni.activeMask = PRESET_ACTIVE & 0x01ff;
    omni.pullupMask = PRESET_PULLUP & 0x01ff;
    await applyDeviceConfig({
        freq: omni.lastFreq,
        res: omni.lastRes,
        activeMask: omni.activeMask,
        pullupMask: omni.pullupMask,
        touchMask: computeTouchModeMask()
    });
    const si = document.getElementById('syncIndicator');
    if (si) si.innerText = '⚡ Ohm-Meter：G2 ADC + 上拉';
}

function buildDom(root) {
    const modeBtns = RANGE_MODES.map(
        (m) =>
            `<button type="button" class="ohm-mode-btn ${m.id === rangeId ? 'ohm-mode-btn--on' : ''}" data-range="${m.id}">${m.label}</button>`
    ).join('');
    root.innerHTML = `
<div class="ohm-root">
  <div class="ohm-hero">
    <div class="ohm-title">Ohmic Master</div>
    <p class="ohm-sub">電阻鑑定師：精準之路 · 校準專家 · G2 分壓量測<br>物理模型：V = ${VCC_MV} mV × R_x ÷ (R_x + R_pullup)；裝置送上來的是 0–4095 比例讀值（對應接腳電壓）。現有韌體即可量測與校準；若日後更新韌體，可再享有 eFuse ADC 表與過採樣等強化。</p>
  </div>
  <div class="ohm-tabs">
    <button type="button" class="ohm-tab ohm-tab--active" data-tab="m">測量</button>
    <button type="button" class="ohm-tab" data-tab="lab">The Lab（校準）</button>
  </div>
  <div class="ohm-panel ohm-panel--visible" data-panel="m">
    <div class="ohm-mode-row">${modeBtns}</div>
    <div class="ohm-readout">
      <div class="ohm-readout-label">鑑定讀數 R_x（分壓公式 · R_pullup′）</div>
      <div class="ohm-readout-val" id="ohm-rx-val">—</div>
      <div class="ohm-readout-raw" id="ohm-adc-raw"></div>
    </div>
    <div class="ohm-warn ohm-warn--ok" id="ohm-warn">連線後顯示讀值。</div>
    <p class="ohm-formula">量程安全：比例讀值 &lt;${ADC_SAFE_LO} 或 &gt;${ADC_SAFE_HI} 時顯示邊界電阻提示。The Lab 以多點平均反推並儲存 R_pullup（取代拋物線擬合）。</p>
  </div>
  <div class="ohm-panel" data-panel="lab">
    <p>多點採樣：接好已知電阻與量程上拉，待讀值穩定後輸入 R_已知，按「記錄」。再按「套用分壓校準」將各點反推之 R_pullup 取平均並儲存（G2 內建上拉預設對應低阻程約 10kΩ，可由校準更新）。</p>
    <div class="ohm-lab-grid">
      <div class="ohm-input-row">
        <label for="ohm-known-r">已知 R (Ω)</label>
        <input type="number" id="ohm-known-r" min="1" step="any" placeholder="1000">
        <button type="button" class="ohm-btn" id="ohm-record">記錄</button>
      </div>
      <table class="ohm-table">
        <thead><tr><th>#</th><th>R 已知 (Ω)</th><th>V 換算 (mV)</th><th>比例讀值</th></tr></thead>
        <tbody id="ohm-samples-body"></tbody>
      </table>
      <div class="ohm-input-row">
        <button type="button" class="ohm-btn" id="ohm-fit">套用分壓校準（平均 R_pullup）</button>
        <button type="button" class="ohm-btn" id="ohm-clear-samples">清除本量程採樣</button>
      </div>
      <pre class="ohm-lab-out" id="ohm-lab-out"></pre>
      <div class="ohm-input-row">
        <button type="button" class="ohm-btn" id="ohm-export">匯出校準 JSON</button>
        <label class="ohm-btn" style="cursor:pointer;display:inline-block;">
          匯入 JSON
          <input type="file" id="ohm-import" accept="application/json,.json" style="display:none">
        </label>
      </div>
    </div>
    <div class="ohm-canvas-host" id="ohm-canvas-host"></div>
  </div>
</div>`;
    const host = root.querySelector('#ohm-canvas-host');
    const labImport = root.querySelector('#ohm-import');
    const labSpan = root.querySelector('.ohm-file span');
    labSpan?.addEventListener('click', () => labImport?.click());
}

export async function init(root) {
    injectCss();
    await loadP5();
    rootEl = root;
    omni.currentViewId = 'ohm-meter-lab';
    loadStorage();
    buildDom(root);
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
