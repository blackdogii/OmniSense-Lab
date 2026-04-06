/**
 * Magic Bow Quality Tester — 導電弓弦品質卡帶
 * G0：觸控（架構上為 0–4095；韌體觸控語意：未觸高、觸摸低）
 * G2：ADC + 板載 10k 上拉；R_ext 可由分壓估算（可選顯示）
 */

import { omni } from '../../web/core/state.js';
import { applyDeviceConfig } from '../../web/core/configApply.js';
import { computeTouchModeMask } from '../../web/core/touchMask.js';
import * as ble from '../../web/core/ble.js';

const CH_TOUCH = 0;
const CH_ADC = 2;

const BASELINE_MS = 3000;
const TOUCH_DEBOUNCE = 4;
const RELEASE_DROP_FRAC = 0.1;
const STABLE_NEED = 14;
const R_PULLUP_OHMS = 10000;

const PRESET_ACTIVE = 0x05;
const PRESET_PULLUP = 0x04;
const PRESET_CHANNEL_MODES = ['touch', 'adc', 'adc', 'adc', 'adc', 'dig', 'dig', 'dig', 'dig'];

/** @type {HTMLElement | null} */
let rootEl = null;
/** @type {HTMLLinkElement | null} */
let styleLink = null;
let dataHandler = null;
/** @type {any} */
let vizP5 = null;

let phase = 'IDLE';
let phaseStartMs = 0;
let touchLowStreak = 0;
let baselineSamples = [];
let baselineMean = 0;
let baselineStd = 0;
let peakAdc = 0;
let releaseMarkMs = 0;
let releaseDropStreak = 0;
let stableStreak = 0;
let lastAdc = 0;
let recoveryTimeMs = 0;
let driftPercent = 0;
let postReleaseSamples = [];
let testFinished = false;

let finalResolution = 0;
let finalRanks = { resolution: 'D', snr: 'D', recovery: 'D', drift: 'D' };
let overallRank = 'D';
let radarScores = [0, 0, 0, 0];

function injectStylesheet() {
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
        s.onerror = () => reject(new Error('p5 load failed'));
        document.head.appendChild(s);
    });
}

function touchActive(v) {
    return v != null && v < omni.touchThreshold;
}

function stddev(arr, mean) {
    if (arr.length < 2) return 0;
    let s = 0;
    for (const x of arr) {
        const d = x - mean;
        s += d * d;
    }
    return Math.sqrt(s / (arr.length - 1));
}

function rankLetterResolution(res) {
    if (res > 1500) return 'S';
    if (res > 1000) return 'A';
    if (res > 600) return 'B';
    if (res > 300) return 'C';
    return 'D';
}

function rankLetterNoise(std) {
    if (std < 5) return 'S';
    if (std < 10) return 'A';
    if (std < 20) return 'B';
    if (std < 35) return 'C';
    return 'D';
}

function rankLetterDrift(pct) {
    if (pct < 1) return 'S';
    if (pct < 2) return 'A';
    if (pct < 4) return 'B';
    if (pct < 8) return 'C';
    return 'D';
}

function rankLetterRecovery(ms) {
    if (ms <= 0) return 'D';
    if (ms < 150) return 'S';
    if (ms < 300) return 'A';
    if (ms < 500) return 'B';
    if (ms < 800) return 'C';
    return 'D';
}

function letterToScore(L) {
    const m = { S: 5, A: 4, B: 3, C: 2, D: 1 };
    return m[L] || 1;
}

function scoreToLetter(s) {
    if (s >= 5) return 'S';
    if (s >= 4) return 'A';
    if (s >= 3) return 'B';
    if (s >= 2) return 'C';
    return 'D';
}

function estimateRextFromAdc(adcVal) {
    if (adcVal <= 1 || adcVal >= 4094) return null;
    const ratio = adcVal / 4095;
    if (ratio <= 0 || ratio >= 1) return null;
    const rext = (ratio * R_PULLUP_OHMS) / (1 - ratio);
    return rext > 0 && rext < 1e7 ? rext : null;
}

function computeRadarScores() {
    const resN = Math.min(1, Math.max(0, finalResolution / 1500));
    const snrN = Math.min(1, Math.max(0, (35 - baselineStd) / 35));
    const recN = Math.min(1, Math.max(0, (800 - Math.min(recoveryTimeMs, 800)) / 800));
    const driftN = Math.min(1, Math.max(0, (8 - Math.min(driftPercent, 8)) / 8));
    radarScores = [resN, snrN, recN, driftN];
}

function finishTest() {
    if (testFinished) return;
    testFinished = true;
    finalResolution = Math.max(0, peakAdc - baselineMean);
    finalRanks.snr = rankLetterNoise(baselineStd);
    finalRanks.resolution = rankLetterResolution(finalResolution);
    finalRanks.recovery = rankLetterRecovery(recoveryTimeMs);
    finalRanks.drift = rankLetterDrift(driftPercent);

    const minScore = Math.min(
        letterToScore(finalRanks.resolution),
        letterToScore(finalRanks.snr),
        letterToScore(finalRanks.recovery),
        letterToScore(finalRanks.drift)
    );
    overallRank = scoreToLetter(minScore);
    computeRadarScores();
    phase = 'DONE';
    updateDomSummary();
    vizP5?.redraw();
}

function updateDomSummary() {
    const stats = rootEl?.querySelector('#mbt-stats');
    if (!stats) return;
    const rext = estimateRextFromAdc(Math.round(baselineMean));
    const rline =
        rext != null ? `‧ 估算 R_ext ≈ ${(rext / 1000).toFixed(2)} kΩ @靜態（僅參考）` : '';
    stats.innerHTML = `
        <div>基準 μ=${baselineMean.toFixed(0)} σ=${baselineStd.toFixed(2)} counts ${rline}</div>
        <div>峰値 ${peakAdc.toFixed(0)} ‧ 解析度 Δ=${finalResolution.toFixed(0)}</div>
        <div>回復時間 ${recoveryTimeMs.toFixed(0)} ms ‧ 漂移 ${driftPercent.toFixed(2)}%</div>
        <div>分項 ${finalRanks.resolution}/${finalRanks.snr}/${finalRanks.recovery}/${finalRanks.drift}</div>`;

    const badge = rootEl?.querySelector('#mbt-rank-badge');
    const letter = rootEl?.querySelector('#mbt-rank-letter');
    if (badge && letter) {
        badge.classList.remove('hidden');
        letter.textContent = overallRank;
        letter.className = 'mbt-rank-letter mbt-rank-' + overallRank.toLowerCase();
        const desc = rootEl.querySelector('#mbt-rank-desc');
        if (desc) {
            desc.textContent =
                overallRank === 'S'
                    ? '弓弦響應與穩定度優異'
                    : overallRank === 'A'
                      ? '整體良好，可微調張力或接點'
                      : '建議檢查接點、導電條老化或取樣率';
        }
    }
}

function resetStateMachine() {
    testFinished = false;
    phase = 'IDLE';
    phaseStartMs = performance.now();
    touchLowStreak = 0;
    baselineSamples = [];
    baselineMean = 0;
    baselineStd = 0;
    peakAdc = 0;
    releaseMarkMs = 0;
    releaseDropStreak = 0;
    stableStreak = 0;
    lastAdc = 0;
    recoveryTimeMs = 0;
    driftPercent = 0;
    postReleaseSamples = [];
    finalResolution = 0;
    finalRanks = { resolution: 'D', snr: 'D', recovery: 'D', drift: 'D' };
    overallRank = 'D';
    radarScores = [0, 0, 0, 0];
    const badge = rootEl?.querySelector('#mbt-rank-badge');
    badge?.classList.add('hidden');
    setPhaseUi(
        'Phase 0 — IDLE',
        '輕觸 <strong>G0</strong> 開始量測（觸發後請準備保持弓弦靜止）。',
        'idle'
    );
    rootEl?.querySelector('#mbt-stats') && (rootEl.querySelector('#mbt-stats').innerHTML = '');
    vizP5?.redraw();
}

function setPhaseUi(label, html, key) {
    const el = rootEl?.querySelector('#mbt-phase-label');
    const tx = rootEl?.querySelector('#mbt-phase-text');
    if (el) el.textContent = label;
    if (tx) tx.innerHTML = html;
    const card = rootEl?.querySelector('.mbt-phase-card');
    if (card) {
        card.dataset.phase = key;
    }
}

function onDataPacket(ev) {
    if (omni.currentViewId !== 'magic-bow-tester') return;
    const ch = ev.detail.channels;
    const v0 = ch[CH_TOUCH]?.filtered ?? null;
    const v2 = ch[CH_ADC]?.filtered ?? null;
    if (v2 == null) {
        vizP5?.redraw();
        return;
    }
    if (phase === 'DONE') {
        vizP5?.redraw();
        return;
    }
    const now = performance.now();

    if (phase === 'IDLE') {
        if (v0 != null && touchActive(v0)) touchLowStreak++;
        else touchLowStreak = 0;
        if (touchLowStreak >= TOUCH_DEBOUNCE) {
            phase = 'BASELINE';
            phaseStartMs = now;
            touchLowStreak = 0;
            baselineSamples = [];
            setPhaseUi(
                'Phase 1 — BASELINE',
                '請<strong>放開 G0</strong>，保持弓弦靜止約 <strong>3 秒</strong>（量測雜訊底）。',
                'baseline'
            );
        }
    } else if (phase === 'BASELINE') {
        if (v0 != null && touchActive(v0)) {
            setPhaseUi(
                'Phase 1 — BASELINE',
                '仍偵測到 G0 觸控，請先<strong>放開</strong>以利基準採樣。',
                'baseline'
            );
        } else {
            baselineSamples.push(v2);
            if (now - phaseStartMs >= BASELINE_MS) {
                baselineMean =
                    baselineSamples.reduce((a, b) => a + b, 0) / Math.max(1, baselineSamples.length);
                baselineStd = stddev(baselineSamples, baselineMean);
                peakAdc = v2;
                phase = 'PULL';
                phaseStartMs = now;
                setPhaseUi(
                    'Phase 2 — PULL',
                    '<strong>緩慢拉滿</strong>弓弦至最大形變（右側為功率計）。',
                    'pull'
                );
            }
        }
    } else if (phase === 'PULL') {
        peakAdc = Math.max(peakAdc, v2);
        const span = Math.max(30, peakAdc - baselineMean);
        const dropThresh = peakAdc - RELEASE_DROP_FRAC * span;
        if (v2 < dropThresh) releaseDropStreak++;
        else releaseDropStreak = 0;
        if (releaseDropStreak >= 3) {
            phase = 'RELEASE';
            releaseMarkMs = now;
            releaseDropStreak = 0;
            stableStreak = 0;
            postReleaseSamples = [];
            setPhaseUi(
                'Phase 3 — RELEASE',
                '偵測到回彈；量測<strong>恢復時間</strong>與<strong>漂移</strong>…',
                'release'
            );
        }
    } else if (phase === 'RELEASE') {
        if (testFinished) return;
        const settleBand = Math.max(15, baselineStd * 3);
        if (Math.abs(v2 - baselineMean) <= settleBand) {
            stableStreak++;
            postReleaseSamples.push(v2);
            if (postReleaseSamples.length > 40) postReleaseSamples.shift();
            if (stableStreak >= STABLE_NEED) {
                recoveryTimeMs = now - releaseMarkMs;
                const tail = postReleaseSamples.slice(-20);
                const fin = tail.reduce((a, b) => a + b, 0) / tail.length;
                const base = Math.max(50, Math.abs(baselineMean));
                driftPercent = (Math.abs(fin - baselineMean) / base) * 100;
                finishTest();
            }
        } else {
            stableStreak = 0;
        }
        if (!testFinished && now - releaseMarkMs > 6500) {
            recoveryTimeMs = now - releaseMarkMs;
            const fin = postReleaseSamples.length
                ? postReleaseSamples[postReleaseSamples.length - 1]
                : v2;
            const base = Math.max(50, Math.abs(baselineMean));
            driftPercent = (Math.abs(fin - baselineMean) / base) * 100;
            finishTest();
        }
    }

    lastAdc = v2;
    vizP5?.redraw();
}

function mountP5(host) {
    const P = window.p5;
    vizP5 = new P((p) => {
        const labels = ['解析度', '底噪', '回復', '漂移'];

        p.setup = () => {
            const w = Math.max(280, host.clientWidth || 320);
            p.createCanvas(w, 300).parent(host);
            p.noLoop();
        };

        p.draw = () => {
            p.background(11, 18, 36);
            const w = p.width;
            const h = p.height;
            const cx = w * 0.5;
            const cylab = 22;

            if (phase === 'PULL') {
                const span = Math.max(400, peakAdc - baselineMean, 1);
                const cur = lastAdc;
                const norm = p.constrain((cur - baselineMean) / span, 0, 1);
                const meterH = 36;
                const meterY = h * 0.55;
                p.noStroke();
                p.fill(30, 41, 59);
                p.rect(28, meterY, w - 56, meterH, 8);
                const glow = p.lerpColor(p.color(34, 211, 238, 80), p.color(129, 140, 248, 200), norm);
                p.fill(glow);
                p.rect(28, meterY, (w - 56) * norm, meterH, 8);
                p.stroke(34, 211, 238, 120);
                p.noFill();
                p.rect(28, meterY, w - 56, meterH, 8);
                p.fill(226, 232, 240);
                p.noStroke();
                p.textAlign(p.CENTER, p.CENTER);
                p.textSize(13);
                p.text(`POWER  ${(norm * 100).toFixed(0)}%  ‧  Peak ${Math.round(peakAdc)}`, cx, meterY - 28);
                p.textSize(11);
                p.fill(148, 163, 184);
                p.text(`Δ vs 基準 ≈ ${Math.max(0, cur - baselineMean).toFixed(0)} counts`, cx, meterY + meterH + 18);
            } else if (phase === 'BASELINE') {
                const t = (performance.now() - phaseStartMs) / BASELINE_MS;
                const a = p.constrain(t, 0, 1);
                p.noFill();
                p.stroke(34, 211, 238, 160);
                p.strokeWeight(6);
                p.arc(cx, h * 0.48, 100, 100, -p.HALF_PI, -p.HALF_PI + a * p.TWO_PI);
                p.noStroke();
                p.fill(226, 232, 240);
                p.textAlign(p.CENTER);
                p.textSize(15);
                p.text(`${Math.ceil((1 - a) * BASELINE_MS / 1000)} s`, cx, h * 0.48 + 6);
                p.textSize(11);
                p.fill(100, 116, 139);
                (() => {
                    const bs = baselineSamples.slice(-40);
                    const bm = bs.length ? bs.reduce((s, x) => s + x, 0) / bs.length : 0;
                    const sig = bs.length > 3 ? stddev(bs, bm).toFixed(2) : '—';
                    p.text(`σ 即時 ≈ ${sig}`, cx, h * 0.72);
                })();
            } else if (phase === 'DONE') {
                const r = Math.min(w, h) * 0.32;
                p.push();
                p.translate(cx, h * 0.48);
                p.noFill();
                p.stroke(51, 65, 85);
                p.strokeWeight(1);
                for (let i = 0; i < 4; i++) {
                    const ang = -p.HALF_PI + (i * p.TWO_PI) / 4;
                    p.line(0, 0, p.cos(ang) * r, p.sin(ang) * r);
                }
                p.stroke(34, 211, 238, 60);
                p.beginShape();
                for (let i = 0; i < 4; i++) {
                    const ang = -p.HALF_PI + (i * p.TWO_PI) / 4;
                    const rr = r * (0.15 + 0.85 * radarScores[i]);
                    p.vertex(p.cos(ang) * rr, p.sin(ang) * rr);
                }
                p.endShape(p.CLOSE);
                p.stroke(34, 211, 238, 180);
                p.strokeWeight(2);
                p.beginShape();
                for (let i = 0; i < 4; i++) {
                    const ang = -p.HALF_PI + (i * p.TWO_PI) / 4;
                    const rr = r * (0.15 + 0.85 * radarScores[i]);
                    p.vertex(p.cos(ang) * rr, p.sin(ang) * rr);
                }
                p.endShape(p.CLOSE);
                p.fill(148, 163, 184);
                p.noStroke();
                p.textSize(10);
                p.textAlign(p.CENTER, p.CENTER);
                for (let i = 0; i < 4; i++) {
                    const ang = -p.HALF_PI + (i * p.TWO_PI) / 4;
                    const lx = p.cos(ang) * (r + cylab);
                    const ly = p.sin(ang) * (r + cylab);
                    p.text(labels[i], lx, ly);
                }
                p.pop();
                p.fill(226, 232, 240);
                p.textAlign(p.CENTER);
                p.textSize(12);
                p.text('品質雷達（四維）', cx, 20);
            } else {
                const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 220);
                p.fill(34, 211, 238, 100 + 120 * pulse);
                p.noStroke();
                p.circle(cx, h * 0.45, 18);
                p.fill(148, 163, 184);
                p.textSize(12);
                p.textAlign(p.CENTER, p.CENTER);
                p.text('G0 觸控待命', cx, h * 0.62);
            }

            if (phase === 'RELEASE') {
                p.textAlign(p.CENTER);
                p.fill(251, 191, 36);
                p.textSize(12);
                p.text('RELEASE / 回復採樣', cx, h - 20);
            }
        };
    }, host);
}

async function applyPreset() {
    if (!ble.getRxChar()) return;
    omni.channelMode = [...PRESET_CHANNEL_MODES];
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
    if (si) si.innerText = '⚡ 弓弦測試：G0 觸控 + G2 ADC';
}

function buildDom(root) {
    root.innerHTML = `
<div class="mbt-root" id="mbt-root-inner">
  <div class="mbt-header">
    <div class="mbt-title">Magic Bow Quality Tester</div>
    <p class="mbt-sub">固定韌體 8-byte / 10-byte 設定 · Channel0 觸控觸發 · Channel2 ADC（10k 上拉）· Vout = 3.3×Rext/(10k+Rext)</p>
  </div>
  <div class="mbt-phase-card" data-phase="idle">
    <div class="mbt-phase-label" id="mbt-phase-label">Phase 0 — IDLE</div>
    <div class="mbt-phase-text" id="mbt-phase-text">輕觸 <strong>G0</strong> 開始。</div>
  </div>
  <div class="mbt-canvas-host" id="mbt-canvas-host"></div>
  <div class="mbt-stats" id="mbt-stats"></div>
  <div class="mbt-rank-badge hidden" id="mbt-rank-badge">
    <div class="mbt-rank-letter mbt-rank-d" id="mbt-rank-letter">—</div>
    <div class="mbt-rank-desc" id="mbt-rank-desc"></div>
  </div>
  <button type="button" class="mbt-restart" id="mbt-restart">重新量測</button>
</div>`;
    root.querySelector('#mbt-restart')?.addEventListener('click', () => resetStateMachine());
}

/**
 * @param {HTMLElement} root
 */
export async function init(root) {
    injectStylesheet();
    await loadP5();
    rootEl = root;
    omni.currentViewId = 'magic-bow-tester';
    buildDom(root);
    const host = root.querySelector('#mbt-canvas-host');
    mountP5(host);
    phaseStartMs = performance.now();
    dataHandler = onDataPacket;
    window.addEventListener('omnisense:data', dataHandler);
    resetStateMachine();
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
    if (styleLink?.parentNode) {
        styleLink.parentNode.removeChild(styleLink);
    }
    styleLink = null;
    if (rootEl) {
        rootEl.innerHTML = '';
        rootEl = null;
    }
}

export async function unmount() {
    await cleanup();
}
