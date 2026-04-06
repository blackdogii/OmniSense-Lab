/**
 * Magic Bow Quality Tester — 導電弓弦品質卡帶
 * G0：觸控（相對落差 + EMA + 遲滯，降低漏判）
 * G2：ADC；拉弓須在「圓圈倒數」內達到最小形變，避免誤判結束
 */

import { omni } from '../../web/core/state.js';
import { applyDeviceConfig } from '../../web/core/configApply.js';
import { computeTouchModeMask } from '../../web/core/touchMask.js';
import * as ble from '../../web/core/ble.js';

const CH_TOUCH = 0;
const CH_ADC = 2;

const BASELINE_MS = 3000;
/** 拉弓視窗：圓圈由大變小，須於此時間內達到最小拉距 */
const PULL_WINDOW_MS = 4500;
/** 判定「有拉弓」之最小解析度（counts）— 未達則不進入放開偵測 */
const MIN_PULL_DELTA = 100;
/** 進入 PULL 後至少經過此時間才允許偵測「放箭」（避免雜訊誤判） */
const MIN_MS_BEFORE_RELEASE_DETECT = 450;
const RELEASE_DROP_FRAC = 0.12;
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
let rafId = 0;
let vizLoopRunning = false;

/** G0：指數平滑與「放開時」之高水位，用於相對觸發 */
let touchEma = 3500;
let touchIdleHigh = 3800;
const TOUCH_EMA_ALPHA = 0.14;
/** 相對落差：超過 max(120, idleHigh * 0.05) 視為按下 */
const TOUCH_REL_MIN = 120;
const TOUCH_REL_FRAC = 0.05;
/** 連續判定：需連續 N 次為「按下」才確認（降低漏判同時防抖） */
const TOUCH_ON_NEED = 3;
const TOUCH_OFF_NEED = 2;

let touchOnStreak = 0;
let touchOffStreak = 0;
let touchPressed = false;

let phase = 'IDLE';
/** PULL 子階段: 'window' 圓圈倒數 | 'hold' 已拉滿、可放箭 */
let pullSub = 'window';
let phaseStartMs = 0;
/** 進入「可放箭偵測」之時間（pullSub===hold 且已達最小拉距時） */
let pullHoldStartMs = 0;
let pullWindowRetries = 0;

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

function updateTouchFilter(v0) {
    if (v0 == null) return false;
    touchEma = (1 - TOUCH_EMA_ALPHA) * touchEma + TOUCH_EMA_ALPHA * v0;
    if (v0 >= omni.touchThreshold - 80) {
        touchIdleHigh = Math.max(touchIdleHigh * 0.997 + v0 * 0.003, v0);
    }
    const relDrop = touchIdleHigh - touchEma;
    const relThresh = Math.max(TOUCH_REL_MIN, touchIdleHigh * TOUCH_REL_FRAC);
    const absPress = v0 < omni.touchThreshold;
    const relPress = relDrop > relThresh;
    const rawPress = absPress || relPress;

    if (rawPress) {
        touchOnStreak++;
        touchOffStreak = 0;
    } else {
        touchOffStreak++;
        touchOnStreak = 0;
    }

    if (!touchPressed && touchOnStreak >= TOUCH_ON_NEED) {
        touchPressed = true;
        updateTouchDom(true);
    } else if (touchPressed && touchOffStreak >= TOUCH_OFF_NEED) {
        touchPressed = false;
        updateTouchDom(false);
    }
    return touchPressed;
}

function updateTouchDom(pressed) {
    const ring = rootEl?.querySelector('#mbt-touch-ring');
    const state = rootEl?.querySelector('#mbt-touch-state');
    if (ring) ring.classList.toggle('mbt-touch-ring--active', pressed);
    if (state) {
        state.textContent = pressed ? 'G0 已觸發' : '等待輕觸 G0';
        state.classList.toggle('mbt-touch-state--on', pressed);
    }
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

function startVizLoop() {
    if (vizLoopRunning) return;
    vizLoopRunning = true;
    function tick() {
        if (!vizLoopRunning) return;
        vizP5?.redraw();
        rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
}

function stopVizLoop() {
    vizLoopRunning = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
}

function finishTest() {
    if (testFinished) return;
    testFinished = true;
    stopVizLoop();
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
    stopVizLoop();
    testFinished = false;
    phase = 'IDLE';
    pullSub = 'window';
    phaseStartMs = performance.now();
    pullHoldStartMs = 0;
    pullWindowRetries = 0;
    touchEma = 3500;
    touchIdleHigh = 3800;
    touchOnStreak = 0;
    touchOffStreak = 0;
    touchPressed = false;
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
    updateTouchDom(false);
    setPhaseUi(
        'Phase 0 — IDLE',
        '輕觸 <strong>G0</strong> 開始（外圈亮起即為偵測到）。',
        'idle'
    );
    rootEl?.querySelector('#mbt-stats') && (rootEl.querySelector('#mbt-stats').innerHTML = '');
    startVizLoop();
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

/** 圓圈時間耗盡但未達最小拉距：重開一輪視窗，不結束測試 */
function restartPullWindow() {
    pullSub = 'window';
    phaseStartMs = performance.now();
    peakAdc = lastAdc;
    pullHoldStartMs = 0;
    pullWindowRetries++;
    setPhaseUi(
        'Phase 2 — PULL',
        `倒數內未達最小拉距。請在圓圈消失前拉滿弓弦（重試第 ${pullWindowRetries} 次）。`,
        'pull'
    );
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
        return;
    }
    const now = performance.now();

    if (v0 != null) updateTouchFilter(v0);

    if (phase === 'IDLE') {
        if (touchPressed) {
            phase = 'BASELINE';
            phaseStartMs = now;
            baselineSamples = [];
            setPhaseUi(
                'Phase 1 — BASELINE',
                '請<strong>放開 G0</strong>，保持弓弦靜止約 <strong>3 秒</strong>（量測雜訊底）。',
                'baseline'
            );
        }
    } else if (phase === 'BASELINE') {
        if (v0 != null && (v0 < omni.touchThreshold || touchPressed)) {
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
                pullSub = 'window';
                phaseStartMs = now;
                pullHoldStartMs = 0;
                setPhaseUi(
                    'Phase 2 — PULL',
                    '看著<strong>圓圈由大變小</strong>：在消失前<strong>緩慢拉滿</strong>弓弦（長條圖會上升）。',
                    'pull'
                );
                startVizLoop();
            }
        }
    } else if (phase === 'PULL') {
        const pullDelta = Math.max(0, v2 - baselineMean);
        peakAdc = Math.max(peakAdc, v2);

        if (pullSub === 'window') {
            if (pullDelta >= MIN_PULL_DELTA) {
                pullSub = 'hold';
                pullHoldStartMs = now;
                setPhaseUi(
                    'Phase 2 — PULL',
                    '已達標！請<strong>維持拉滿</strong>，準備<strong>放開弓弦</strong>（放箭）。',
                    'pull'
                );
            } else if (now - phaseStartMs >= PULL_WINDOW_MS) {
                restartPullWindow();
            }
        }

        if (pullSub === 'hold') {
            const span = Math.max(MIN_PULL_DELTA, peakAdc - baselineMean);
            const dropThresh = peakAdc - RELEASE_DROP_FRAC * span;
            const canDetectRelease = now - pullHoldStartMs >= MIN_MS_BEFORE_RELEASE_DETECT;
            if (canDetectRelease && v2 < dropThresh) releaseDropStreak++;
            else releaseDropStreak = 0;

            if (canDetectRelease && releaseDropStreak >= 4) {
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
}

function mountP5(host) {
    const P = window.p5;
    vizP5 = new P((p) => {
        const labels = ['解析度', '底噪', '回復', '漂移'];

        p.setup = () => {
            const w = Math.max(280, host.clientWidth || 320);
            p.createCanvas(w, 340).parent(host);
            p.noLoop();
        };

        p.draw = () => {
            p.background(11, 18, 36);
            const w = p.width;
            const h = p.height;
            const cx = w * 0.5;
            const cylab = 22;

            if (phase === 'PULL') {
                const pullDelta = Math.max(0, lastAdc - baselineMean);
                const spanGoal = Math.max(400, peakAdc - baselineMean, MIN_PULL_DELTA);
                const norm = p.constrain(pullDelta / spanGoal, 0, 1);

                const barW = w - 56;
                const barH = 22;
                const barY = h * 0.22;
                p.noStroke();
                p.fill(30, 41, 59);
                p.rect(28, barY, barW, barH, 6);
                const barFill = p.lerpColor(p.color(6, 78, 59), p.color(34, 211, 238), norm);
                p.fill(barFill);
                p.rect(28, barY, barW * norm, barH, 6);
                p.stroke(34, 211, 238, 100);
                p.noFill();
                p.rect(28, barY, barW, barH, 6);
                p.fill(226, 232, 240);
                p.noStroke();
                p.textAlign(p.CENTER, p.CENTER);
                p.textSize(12);
                p.text(`拉弓力度（ΔADC） ${pullDelta.toFixed(0)} / 目標 ≥ ${MIN_PULL_DELTA}`, cx, barY - 14);

                if (pullSub === 'window') {
                    const elapsed = performance.now() - phaseStartMs;
                    const u = p.constrain(1 - elapsed / PULL_WINDOW_MS, 0, 1);
                    const rMax = Math.min(w, h) * 0.38;
                    const r = rMax * (0.2 + 0.8 * u);
                    p.noFill();
                    p.stroke(34, 211, 238, 160);
                    p.strokeWeight(3);
                    p.circle(cx, h * 0.58, r);
                    p.stroke(251, 191, 36, 200);
                    p.strokeWeight(2);
                    p.circle(cx, h * 0.58, r * 0.92);
                    p.noStroke();
                    p.fill(226, 232, 240);
                    p.textSize(14);
                    p.text(`圓圈倒數 ${(u * (PULL_WINDOW_MS / 1000)).toFixed(1)} s`, cx, h * 0.58);
                    p.textSize(11);
                    p.fill(148, 163, 184);
                    p.text('消失前請拉滿弓弦', cx, h * 0.58 + 36);
                } else {
                    const meterH = 40;
                    const meterY = h * 0.52;
                    p.noStroke();
                    p.fill(30, 41, 59);
                    p.rect(28, meterY, barW, meterH, 8);
                    const glow = p.lerpColor(p.color(34, 211, 238, 90), p.color(129, 140, 248, 220), norm);
                    p.fill(glow);
                    p.rect(28, meterY, barW * norm, meterH, 8);
                    p.stroke(34, 211, 238, 130);
                    p.noFill();
                    p.rect(28, meterY, barW, meterH, 8);
                    p.fill(226, 232, 240);
                    p.noStroke();
                    p.textSize(13);
                    p.text(`POWER ${(norm * 100).toFixed(0)}% ‧ Peak ${Math.round(peakAdc)}`, cx, meterY - 18);
                    p.textSize(11);
                    p.fill(148, 163, 184);
                    p.text('維持後放開弓弦（放箭）', cx, meterY + meterH + 16);
                }
            } else if (phase === 'BASELINE') {
                const t = (performance.now() - phaseStartMs) / BASELINE_MS;
                const a = p.constrain(t, 0, 1);
                p.noFill();
                p.stroke(34, 211, 238, 160);
                p.strokeWeight(6);
                p.arc(cx, h * 0.48, 100, 100, -p.HALF_PI, -p.HALF_PI + a * p.TWO_PI);
                p.noStroke();
                p.fill(226, 232, 240);
                p.textAlign(p.CENTER, p.CENTER);
                p.textSize(15);
                p.text(`${Math.ceil((1 - a) * BASELINE_MS / 1000)} s`, cx, h * 0.48 + 6);
                p.textSize(11);
                p.fill(100, 116, 139);
                const bs = baselineSamples.slice(-40);
                const bm = bs.length ? bs.reduce((s, x) => s + x, 0) / bs.length : 0;
                const sig = bs.length > 3 ? stddev(bs, bm).toFixed(2) : '—';
                p.text(`σ 即時 ≈ ${sig}`, cx, h * 0.72);
            } else if (phase === 'DONE') {
                const r = Math.min(w, h) * 0.3;
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
                p.textAlign(p.CENTER, p.CENTER);
                p.textSize(12);
                p.text('品質雷達（四維）', cx, 18);
            } else if (phase === 'RELEASE') {
                p.fill(251, 191, 36);
                p.textAlign(p.CENTER, p.CENTER);
                p.textSize(12);
                p.text('RELEASE / 回復採樣', cx, h * 0.5);
            } else {
                const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 220);
                p.noFill();
                p.stroke(34, 211, 238, 100 + 100 * pulse);
                p.strokeWeight(3);
                p.circle(cx, h * 0.45, 56 + 12 * pulse);
                p.fill(34, 211, 238, 80 + 90 * pulse);
                p.noStroke();
                p.circle(cx, h * 0.45, 22);
                p.fill(148, 163, 184);
                p.textSize(12);
                p.textAlign(p.CENTER, p.CENTER);
                p.text('輕觸 G0 開始', cx, h * 0.68);
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
    <p class="mbt-sub">G0 觸控：相對落差 + 平滑 · G2 ADC（10k 上拉）· 圓圈內須完成拉弓才會進入放箭</p>
  </div>
  <div class="mbt-touch-row" aria-live="polite">
    <div class="mbt-touch-ring" id="mbt-touch-ring">
      <span class="mbt-touch-ring-inner">G0</span>
    </div>
    <p class="mbt-touch-state" id="mbt-touch-state">等待輕觸 G0</p>
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
    stopVizLoop();
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
