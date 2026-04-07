/**
 * Ohm-Meter-Lab — 電阻鑑定師：精準之路（Ohmic Master）
 * 分壓：R_x = R_pu × ADC / (4095 − ADC) · 三量程 · 校準實驗室 · 二次擬合（最小二乘）
 */

import { omni } from '../../web/core/state.js';
import { applyDeviceConfig } from '../../web/core/configApply.js';
import { computeTouchModeMask } from '../../web/core/touchMask.js';
import * as ble from '../../web/core/ble.js';

const CH_ADC = 2;
const ADC_MAX = 4095;
const ADC_SAFE_LO = 500;
const ADC_SAFE_HI = 3500;
const STORAGE_KEY = 'omnisense_ohm_meter_lab_v1';

const PRESET_ACTIVE = 1 << CH_ADC;
const PRESET_PULLUP = 1 << CH_ADC;
const PRESET_MODES = ['adc', 'adc', 'adc', 'adc', 'adc', 'dig', 'dig', 'dig', 'dig'];

/** 三種量程：標稱上拉電阻（實體需對應接線／跳線） */
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

/** @type {{ rPuCal: number | null, poly: { a: number; b: number; c: number; rMin: number; rSpan: number } | null, samples: { r: number; adc: number }[] }} */
let labByRange = {
    '10k': { rPuCal: null, poly: null, samples: [] },
    '100k': { rPuCal: null, poly: null, samples: [] },
    '1M': { rPuCal: null, poly: null, samples: [] }
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

/** R_x = R_pu × ADC / (4095 − ADC) */
function rxIdeal(adc, rPu) {
    if (adc <= 0 || adc >= ADC_MAX) return NaN;
    return (rPu * adc) / (ADC_MAX - adc);
}

function rxDisplay(adc) {
    const L = labByRange[rangeId];
    if (L.poly && L.poly.rSpan != null) {
        const R = solveRFromQuadratic(adc, L.poly);
        if (R > 0 && Number.isFinite(R)) return R;
    }
    return rxIdeal(adc, rPuEffective());
}

/** 邊界電阻：ADC=500 / 3500 時之理論 R */
function boundaryRAt(adcGate, rPu) {
    if (adcGate <= 0 || adcGate >= ADC_MAX) return NaN;
    return (rPu * adcGate) / (ADC_MAX - adcGate);
}

function formatOhm(r) {
    if (!Number.isFinite(r) || r <= 0) return '—';
    if (r >= 1e6) return `${(r / 1e6).toFixed(3)} MΩ`;
    if (r >= 1e3) return `${(r / 1e3).toFixed(3)} kΩ`;
    return `${r.toFixed(1)} Ω`;
}

/** 最小二乘：ADC ≈ a·u² + b·u + c，u = (R − rMin) / rSpan（避免 R 跨數量級時病態） */
function fitQuadraticLeastSquares(xs, ys) {
    const n = xs.length;
    if (n < 3) return null;
    const rMin = Math.min(...xs);
    const rMax = Math.max(...xs);
    const rSpan = Math.max(rMax - rMin, 1e-9);
    const us = xs.map((x) => (x - rMin) / rSpan);
    let s4 = 0,
        s3 = 0,
        s2 = 0,
        s1 = 0,
        s0 = n;
    let t2 = 0,
        t1 = 0,
        t0 = 0;
    for (let i = 0; i < n; i++) {
        const x = us[i];
        const y = ys[i];
        const x2 = x * x;
        const x3 = x2 * x;
        const x4 = x2 * x2;
        s4 += x4;
        s3 += x3;
        s2 += x2;
        s1 += x;
        t2 += y * x2;
        t1 += y * x;
        t0 += y;
    }
    const sol = solve3x3(
        [s4, s3, s2, t2],
        [s3, s2, s1, t1],
        [s2, s1, s0, t0]
    );
    if (!sol) return null;
    return { a: sol[0], b: sol[1], c: sol[2], rMin, rSpan };
}

function solve3x3(row0, row1, row2) {
    const A = [
        [row0[0], row0[1], row0[2], row0[3]],
        [row1[0], row1[1], row1[2], row1[3]],
        [row2[0], row2[1], row2[2], row2[3]]
    ];
    for (let col = 0; col < 3; col++) {
        let piv = col;
        for (let r = col + 1; r < 3; r++) {
            if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
        }
        if (Math.abs(A[piv][col]) < 1e-12) return null;
        if (piv !== col) [A[col], A[piv]] = [A[piv], A[col]];
        const div = A[col][col];
        for (let j = col; j < 4; j++) A[col][j] /= div;
        for (let r = 0; r < 3; r++) {
            if (r === col) continue;
            const f = A[r][col];
            for (let j = col; j < 4; j++) A[r][j] -= f * A[col][j];
        }
    }
    return [A[0][3], A[1][3], A[2][3]];
}

/** ADC = a·u² + b·u + c，u=(R−rMin)/rSpan ⇒ 求 R>0 */
function solveRFromQuadratic(adc, poly) {
    const { a, b, c, rMin, rSpan } = poly;
    const span = rSpan != null && rSpan > 0 ? rSpan : 1;
    const base = rMin != null ? rMin : 0;
    if (Math.abs(a) < 1e-14) {
        if (Math.abs(b) < 1e-14) return NaN;
        const u = (adc - c) / b;
        return base + u * span;
    }
    const disc = b * b - 4 * a * (c - adc);
    if (disc < 0) return NaN;
    const s = Math.sqrt(disc);
    const u1 = (-b + s) / (2 * a);
    const u2 = (-b - s) / (2 * a);
    const cands = [u1, u2]
        .filter((u) => Number.isFinite(u))
        .map((u) => base + u * span)
        .filter((r) => r > 0);
    if (!cands.length) return NaN;
    return cands.reduce((x, y) => (x < y ? x : y));
}

/** 舊版 poly（無 rSpan）自採樣重新擬合 */
function migratePolyFromSamples(L) {
    if (!L.samples || L.samples.length < 3) return;
    if (L.poly && L.poly.rSpan != null) return;
    const xs = L.samples.map((s) => s.r);
    const ys = L.samples.map((s) => s.adc);
    const poly = fitQuadraticLeastSquares(xs, ys);
    L.poly = poly;
}

function estimateRPuFromSamples(samples, rPuNom) {
    if (!samples.length) return rPuNom;
    const est = [];
    for (const p of samples) {
        const { r, adc } = p;
        if (adc <= 0 || adc >= ADC_MAX) continue;
        est.push((r * (ADC_MAX - adc)) / adc);
    }
    if (!est.length) return rPuNom;
    return est.reduce((a, b) => a + b, 0) / est.length;
}

function loadStorage() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const o = JSON.parse(raw);
        if (o.labByRange && typeof o.labByRange === 'object') {
            for (const id of Object.keys(labByRange)) {
                if (o.labByRange[id]) {
                    labByRange[id].rPuCal =
                        o.labByRange[id].rPuCal != null ? Number(o.labByRange[id].rPuCal) : null;
                    labByRange[id].poly = o.labByRange[id].poly || null;
                    labByRange[id].samples = Array.isArray(o.labByRange[id].samples)
                        ? o.labByRange[id].samples.map((s) => ({ r: Number(s.r), adc: Number(s.adc) }))
                        : [];
                }
            }
        }
        if (o.rangeId && RANGE_MODES.some((m) => m.id === o.rangeId)) rangeId = o.rangeId;
        for (const id of Object.keys(labByRange)) migratePolyFromSamples(labByRange[id]);
    } catch {
        /* ignore */
    }
}

function saveStorage() {
    try {
        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({ version: 1, rangeId, labByRange })
        );
    } catch {
        /* ignore */
    }
}

function exportJson() {
    const blob = new Blob([JSON.stringify({ version: 1, rangeId, labByRange }, null, 2)], {
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
    const elR = rootEl?.querySelector('#ohm-rx-val');
    const elRaw = rootEl?.querySelector('#ohm-adc-raw');
    const elWarn = rootEl?.querySelector('#ohm-warn');
    if (elR) elR.textContent = formatOhm(rx);
    if (elRaw) elRaw.textContent = `ADC raw = ${adc.toFixed(0)} · R_pu′ = ${formatOhm(rPu)}`;

    if (!elWarn) return;
    elWarn.classList.remove('ohm-warn--ok', 'hidden');
    if (adc < ADC_SAFE_LO) {
        const x = boundaryRAt(ADC_SAFE_LO, rPu);
        elWarn.textContent = `量程提示：ADC < ${ADC_SAFE_LO} → 電阻 < ${formatOhm(x)}（易飽和，請換高阻程或檢查接線）`;
        elWarn.classList.remove('ohm-warn--ok');
    } else if (adc > ADC_SAFE_HI) {
        const x = boundaryRAt(ADC_SAFE_HI, rPu);
        elWarn.textContent = `量程提示：ADC > ${ADC_SAFE_HI} → 電阻 > ${formatOhm(x)}（易飽和，請換低阻程）`;
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
                `<tr><td>${i + 1}</td><td>${row.r}</td><td>${row.adc.toFixed(0)}</td></tr>`
        )
        .join('');
}

function updateLabOut() {
    const L = labByRange[rangeId];
    const out = rootEl?.querySelector('#ohm-lab-out');
    if (!out) return;
    let txt = '';
    if (L.samples.length >= 2) {
        txt += `反推 R_pu(平均) ≈ ${formatOhm(estimateRPuFromSamples(L.samples, getRange().rPuNom))}\n`;
    }
    if (L.poly && L.poly.rSpan != null) {
        const p = L.poly;
        txt += `二次擬合（u=(R−${p.rMin.toFixed(0)})/${p.rSpan.toExponential(2)}）ADC ≈ ${p.a.toExponential(4)}·u² + ${p.b.toExponential(4)}·u + ${p.c.toFixed(2)}\n`;
    } else {
        txt += '二次擬合：至少 3 個採樣點後按「擬合」。\n';
    }
    out.textContent = txt.trim();
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
            const poly = labByRange[rangeId].poly;
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
            if (poly && poly.rSpan != null) {
                for (let rr = rMin; rr <= rMax; rr += (rMax - rMin) / 20 || 1) {
                    const u = (rr - poly.rMin) / poly.rSpan;
                    const y = poly.a * u * u + poly.b * u + poly.c;
                    aMin = Math.min(aMin, y);
                    aMax = Math.max(aMax, y);
                }
            }
            rMin *= 0.85;
            rMax *= 1.15;
            aMin = Math.max(0, aMin - 100);
            aMax = Math.min(ADC_MAX, aMax + 100);
            const sx = (r) => pad + ((r - rMin) / Math.max(rMax - rMin, 1e-9)) * w;
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
            p.text('ADC', 0, 0);
            p.pop();

            p.stroke(56, 189, 248, 120);
            p.strokeWeight(1);
            for (let i = 0; i <= 4; i++) {
                const gx = pad + (i * w) / 4;
                p.line(gx, pad, gx, pad + h);
            }
            if (poly && poly.rSpan != null && rMax > rMin) {
                p.stroke(167, 139, 250, 200);
                p.strokeWeight(2);
                p.noFill();
                p.beginShape();
                const steps = 48;
                for (let i = 0; i <= steps; i++) {
                    const rr = rMin + (i / steps) * (rMax - rMin);
                    const u = (rr - poly.rMin) / poly.rSpan;
                    const ad = poly.a * u * u + poly.b * u + poly.c;
                    if (ad >= 0 && ad <= ADC_MAX) p.vertex(sx(rr), sy(ad));
                }
                p.endShape();
            }
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
        labByRange[rangeId].poly = null;
        labByRange[rangeId].rPuCal = null;
        saveStorage();
        renderLabTable();
        updateLabOut();
        vizP5?.redraw();
    });

    rootEl?.querySelector('#ohm-fit')?.addEventListener('click', () => {
        const L = labByRange[rangeId];
        const pts = L.samples;
        if (pts.length < 3) {
            window.alert('二次擬合至少需要 3 個採樣點（建議 5 個點）。');
            return;
        }
        const xs = pts.map((p) => p.r);
        const ys = pts.map((p) => p.adc);
        const poly = fitQuadraticLeastSquares(xs, ys);
        if (!poly) {
            window.alert('擬合失敗（矩陣奇異），請檢查採樣點是否過於重複。');
            return;
        }
        L.poly = poly;
        L.rPuCal = estimateRPuFromSamples(pts, getRange().rPuNom);
        saveStorage();
        updateLabOut();
        updateMeasureUi();
        vizP5?.redraw();
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
                        '10k': { rPuCal: null, poly: null, samples: [] },
                        '100k': { rPuCal: null, poly: null, samples: [] },
                        '1M': { rPuCal: null, poly: null, samples: [] }
                    };
                    for (const id of Object.keys(labByRange)) {
                        if (o.labByRange[id]) {
                            labByRange[id].rPuCal = o.labByRange[id].rPuCal ?? null;
                            labByRange[id].poly = o.labByRange[id].poly ?? null;
                            labByRange[id].samples = Array.isArray(o.labByRange[id].samples)
                                ? o.labByRange[id].samples.map((s) => ({
                                      r: Number(s.r),
                                      adc: Number(s.adc)
                                  }))
                                : [];
                            migratePolyFromSamples(labByRange[id]);
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
    <p class="ohm-sub">電阻鑑定師：精準之路 · 校準專家 · G2 分壓量測<br>公式：R_x = R_pu × ADC ÷ (4095 − ADC)</p>
  </div>
  <div class="ohm-tabs">
    <button type="button" class="ohm-tab ohm-tab--active" data-tab="m">測量</button>
    <button type="button" class="ohm-tab" data-tab="lab">The Lab（校準）</button>
  </div>
  <div class="ohm-panel ohm-panel--visible" data-panel="m">
    <div class="ohm-mode-row">${modeBtns}</div>
    <div class="ohm-readout">
      <div class="ohm-readout-label">鑑定讀數 R_x（擬合優先）</div>
      <div class="ohm-readout-val" id="ohm-rx-val">—</div>
      <div class="ohm-readout-raw" id="ohm-adc-raw"></div>
    </div>
    <div class="ohm-warn ohm-warn--ok" id="ohm-warn">連線後顯示讀值。</div>
    <p class="ohm-formula">量程安全：ADC&lt;${ADC_SAFE_LO} 或 &gt;${ADC_SAFE_HI} 時顯示邊界電阻提示。多項式擬合後以反解 R 優先。</p>
  </div>
  <div class="ohm-panel" data-panel="lab">
    <p>多點採樣：調整待測電阻至穩定，輸入已知 R，按「記錄」。至少 3 點可做二次擬合（建議 5 點）。</p>
    <div class="ohm-lab-grid">
      <div class="ohm-input-row">
        <label for="ohm-known-r">已知 R (Ω)</label>
        <input type="number" id="ohm-known-r" min="1" step="any" placeholder="1000">
        <button type="button" class="ohm-btn" id="ohm-record">記錄</button>
      </div>
      <table class="ohm-table">
        <thead><tr><th>#</th><th>R 已知 (Ω)</th><th>ADC</th></tr></thead>
        <tbody id="ohm-samples-body"></tbody>
      </table>
      <div class="ohm-input-row">
        <button type="button" class="ohm-btn" id="ohm-fit">多項式擬合（最小二乘）</button>
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
