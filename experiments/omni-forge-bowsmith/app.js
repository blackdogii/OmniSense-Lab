/**
 * Omni-Forge: The Bowsmith Trial
 * 3 次試煉 → 截尾平均（去極值）· Void / Titan / Return 三階段 · 魔法能量計 · 粒子
 */

import { omni } from '../../web/core/state.js';
import { applyDeviceConfig } from '../../web/core/configApply.js';
import { computeTouchModeMask } from '../../web/core/touchMask.js';
import * as ble from '../../web/core/ble.js';

const CH_TOUCH = 0;
const CH_ADC = 2;
const TRIALS_REQUIRED = 3;
const PASS_SCORE = 70;
/** 連續兩輪未達 PASS_SCORE 後，下一輪起改用此門檻 */
const PASS_SCORE_RELAXED = 55;

/** 連續「整組試煉結束但未達標準」次數（達標或 Remake 會歸零／調整） */
let failedFullRuns = 0;

const VOID_MS = 2600;
const TITAN_WINDOW_MS = 4200;
const MIN_PULL_DELTA = 88;
const MIN_MS_BEFORE_RELEASE = 420;
const RELEASE_FRAC = 0.11;
const STABLE_NEED = 12;

const PRESET_ACTIVE = 0x05;
const PRESET_PULLUP = 0x04;
const PRESET_MODES = ['touch', 'adc', 'adc', 'adc', 'adc', 'dig', 'dig', 'dig', 'dig'];

const TOUCH_EMA_A = 0.14;
const TOUCH_ON = 3;
const TOUCH_OFF = 2;
const REL_MIN = 115;
const REL_FRAC = 0.055;

/** @type {HTMLElement | null} */
let rootEl = null;
let styleLink = null;
let dataHandler = null;
let vizP5 = null;
let p5ResizeHandler = null;
let layoutMediaHandler = null;
let rafId = 0;
let vizLoopOn = false;

let touchEma = 3500;
let touchIdleHi = 3800;
let tOn = 0;
let tOff = 0;
let touchPressed = false;

/** IDLE | VOID | TITAN_WIN | TITAN_HOLD | RETURN | BETWEEN | CERT */
let phase = 'IDLE';
let trialIndex = 0;
let phaseStartMs = 0;
let holdStartMs = 0;
let baselineSamples = [];
let baselineMean = 0;
let baselineStd = 0;
let peakAdc = 0;
let releaseMarkMs = 0;
let relDrop = 0;
let stab = 0;
let lastAdc = 0;
let postSamp = [];
let recMs = 0;
let driftPct = 0;
let returnSealed = false;

/** @type {number[]} */
let trialScores = [];
/** 單次試煉暫存 */
let curNoise = 0;
let curDelta = 0;

let finalScore = 0;
let trimmedMean = 0;
let letterGrade = 'F';
let radarVals = [0, 0, 0, 0];

const particles = [];
const MAX_P = 180;

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

function updateTouch(v0) {
    if (v0 == null) return false;
    touchEma = (1 - TOUCH_EMA_A) * touchEma + TOUCH_EMA_A * v0;
    if (v0 >= omni.touchThreshold - 85) touchIdleHi = Math.max(touchIdleHi * 0.997 + v0 * 0.003, v0);
    const drop = touchIdleHi - touchEma;
    const th = Math.max(REL_MIN, touchIdleHi * REL_FRAC);
    const raw = v0 < omni.touchThreshold || drop > th;
    if (raw) {
        tOn++;
        tOff = 0;
    } else {
        tOff++;
        tOn = 0;
    }
    if (!touchPressed && tOn >= TOUCH_ON) {
        touchPressed = true;
        rootEl?.querySelector('#of-touch-dot')?.classList.add('of-touch-dot--on');
    } else if (touchPressed && tOff >= TOUCH_OFF) {
        touchPressed = false;
        rootEl?.querySelector('#of-touch-dot')?.classList.remove('of-touch-dot--on');
    }
    return touchPressed;
}

function stddev(a, m) {
    if (a.length < 2) return 0;
    let s = 0;
    for (const x of a) {
        const d = x - m;
        s += d * d;
    }
    return Math.sqrt(s / (a.length - 1));
}

function getEffectivePassScore() {
    return failedFullRuns >= 2 ? PASS_SCORE_RELAXED : PASS_SCORE;
}

/** 至少 TRIALS_REQUIRED 筆；去最高最低後平均（3 筆時為中位數） */
function trimmedMeanTrials(arr) {
    if (arr.length < TRIALS_REQUIRED) return NaN;
    const s = [...arr].sort((a, b) => a - b);
    const slice = s.slice(1, -1);
    return slice.reduce((x, y) => x + y, 0) / slice.length;
}

function scoreTrial(voidStd, delta, recoveryMs, drift) {
    const ns = Math.min(25, Math.max(0, 25 * (1 - voidStd / 42)));
    const ts = Math.min(40, 40 * Math.min(1, delta / 950));
    const rs = Math.min(22, 22 * (1 - Math.min(recoveryMs, 900) / 900));
    const ds = Math.min(13, 13 * (1 - Math.min(drift, 14) / 14));
    return Math.round(Math.min(100, ns + ts + rs + ds));
}

function letterFromScore(s) {
    if (s >= 90) return 'S';
    if (s >= 80) return 'A';
    if (s >= 70) return 'B';
    if (s >= 60) return 'C';
    if (s >= 50) return 'D';
    return 'F';
}

function startViz() {
    if (vizLoopOn) return;
    vizLoopOn = true;
    function tick() {
        if (!vizLoopOn) return;
        vizP5?.redraw();
        rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
}

function stopViz() {
    vizLoopOn = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
}

function spawnParticles(p, intensity) {
    const n = Math.floor(2 + intensity * 14);
    for (let i = 0; i < n && particles.length < MAX_P; i++) {
        particles.push({
            x: p.random(p.width * 0.2, p.width * 0.8),
            y: p.random(p.height * 0.35, p.height * 0.85),
            vx: p.random(-2.2, 2.2) * (0.5 + intensity),
            vy: p.random(-3.5, -0.5) * (0.4 + intensity),
            life: p.random(0.4, 1),
            hue: p.random() > 0.5 ? 195 : 265
        });
    }
}

function stepParticles(p) {
    for (let i = particles.length - 1; i >= 0; i--) {
        const q = particles[i];
        q.x += q.vx;
        q.y += q.vy;
        q.life -= 0.018;
        p.noStroke();
        p.fill(q.hue, 85, 72, q.life);
        p.circle(q.x, q.y, 3 + q.life * 4);
        if (q.life <= 0) particles.splice(i, 1);
    }
}

function energyNorm() {
    const span = Math.max(120, peakAdc - baselineMean, MIN_PULL_DELTA);
    return Math.min(1, Math.max(0, (lastAdc - baselineMean) / span));
}

function finalizeTrial(score) {
    if (phase === 'CERT') return;
    trialScores.push(score);
    updateTrialBadge();
    if (trialScores.length < TRIALS_REQUIRED) {
        phase = 'BETWEEN';
        phaseStartMs = performance.now();
        particles.length = 0;
        setHud(
            `第 ${trialScores.length} 輪完成`,
            `觸碰 G0 或按「繼續鍛造」開始第 ${trialScores.length + 1} 輪。`,
            'between'
        );
        return;
    }
    trimmedMean = trimmedMeanTrials(trialScores);
    finalScore = Math.round(trimmedMean);
    letterGrade = letterFromScore(finalScore);
    const effectivePass = getEffectivePassScore();
    const passed = finalScore >= effectivePass;
    if (passed) {
        failedFullRuns = 0;
    } else if (finalScore < PASS_SCORE) {
        failedFullRuns++;
    }
    radarVals = [
        Math.min(1, finalScore / 100),
        Math.min(1, Math.max(0, (45 - baselineStd) / 45)),
        Math.min(1, (900 - Math.min(recMs || 400, 900)) / 900),
        trialScores.length >= 2 ? 1 - Math.min(1, Math.abs(trialScores[0] - trialScores[trialScores.length - 1]) / 100) : 0.5
    ];
    phase = 'CERT';
    particles.length = 0;
    showCertificate(passed, effectivePass);
    vizP5?.redraw();
    window.dispatchEvent(
        new CustomEvent('omnisense:forge-result', {
            detail: { passed, score: finalScore, grade: letterGrade, trials: [...trialScores], passThreshold: effectivePass }
        })
    );
}

/**
 * @param {boolean} passed
 * @param {number} effectivePass
 */
function showCertificate(passed, effectivePass) {
    const cert = rootEl?.querySelector('#of-cert');
    const stamp = rootEl?.querySelector('#of-stamp');
    const sc = rootEl?.querySelector('#of-final-score');
    const lock = rootEl?.querySelector('#of-lock-msg');
    const pass = rootEl?.querySelector('#of-pass-msg');
    const nextBtn = rootEl?.querySelector('#of-next');
    const remake = rootEl?.querySelector('#of-remake');
    const relaxBanner = rootEl?.querySelector('#of-relax-banner');
    cert?.classList.add('of-cert--visible');
    if (stamp) {
        stamp.textContent = letterGrade;
        stamp.className = 'of-stamp of-stamp--' + letterGrade.toLowerCase();
    }
    if (sc) {
        sc.innerHTML = `截尾均分 <strong>${finalScore}</strong> / 100<span class="of-score-meta">（${TRIALS_REQUIRED} 次試煉，去最高／最低）</span>`;
    }
    if (relaxBanner) {
        const showRelax = effectivePass < PASS_SCORE;
        relaxBanner.classList.toggle('hidden', !showRelax);
        if (showRelax) {
            relaxBanner.innerHTML = `已為你調降鑑定門檻：<strong>${effectivePass}</strong> 分（原 ${PASS_SCORE} 分）`;
        }
    }
    if (lock) {
        lock.classList.toggle('hidden', passed);
        if (!passed) {
            lock.textContent = `分數未達 ${effectivePass} 分（無法解鎖下一試煉）。可 Remake 再試，或累積兩輪未達 ${PASS_SCORE} 分後將自動調降門檻。`;
        }
    }
    pass?.classList.toggle('hidden', !passed);
    if (nextBtn) {
        nextBtn.classList.remove('hidden');
        nextBtn.disabled = !passed;
        nextBtn.classList.toggle('of-btn--locked', !passed);
    }
    remake?.classList.remove('hidden');
}

function hideCertificate() {
    rootEl?.querySelector('#of-cert')?.classList.remove('of-cert--visible');
    rootEl?.querySelector('#of-lock-msg')?.classList.add('hidden');
    rootEl?.querySelector('#of-pass-msg')?.classList.add('hidden');
    rootEl?.querySelector('#of-next')?.classList.add('hidden');
    rootEl?.querySelector('#of-relax-banner')?.classList.add('hidden');
}

function updateTrialBadge() {
    const b = rootEl?.querySelector('#of-trial-badge');
    if (!b) return;
    const cur =
        phase === 'VOID' || phase === 'TITAN_WIN' || phase === 'TITAN_HOLD' || phase === 'RETURN'
            ? trialScores.length + 1
            : Math.min(trialScores.length, TRIALS_REQUIRED);
    b.textContent = `TRIAL ${cur}/${TRIALS_REQUIRED}`;
}

function setHud(title, body, pill) {
    const t = rootEl?.querySelector('#of-hud-title');
    const b = rootEl?.querySelector('#of-hud-body');
    const p = rootEl?.querySelector('#of-phase-pill');
    if (t) t.textContent = title;
    if (b) b.innerHTML = body;
    if (p) {
        p.textContent = pill;
        p.dataset.phase = pill.toLowerCase().includes('void')
            ? 'void'
            : pill.toLowerCase().includes('titan')
              ? 'titan'
              : pill.toLowerCase().includes('return')
                ? 'return'
                : '';
    }
}

function beginVoidTrial() {
    trialIndex = trialScores.length + 1;
    phase = 'VOID';
    phaseStartMs = performance.now();
    baselineSamples = [];
    returnSealed = false;
    updateTrialBadge();
    setHud(
        `試煉 ${trialIndex}/${TRIALS_REQUIRED} — Void`,
        '保持弓弦<strong>靜止</strong>，量測虛空底噪…',
        'Void'
    );
}

function onData(ev) {
    if (omni.currentViewId !== 'omni-forge-bowsmith') return;
    if (phase === 'CERT') return;
    const ch = ev.detail.channels;
    const v0 = ch[CH_TOUCH]?.filtered ?? null;
    const v2 = ch[CH_ADC]?.filtered ?? null;
    if (v2 == null) return;
    const now = performance.now();
    if (v0 != null) updateTouch(v0);

    if (phase === 'IDLE') {
        if (touchPressed) beginVoidTrial();
    } else if (phase === 'BETWEEN') {
        if (touchPressed) beginVoidTrial();
    } else if (phase === 'VOID') {
        if (v0 != null && (v0 < omni.touchThreshold || touchPressed)) {
            setHud(`試煉 ${trialIndex}/${TRIALS_REQUIRED} — Void`, '請先<strong>放開 G0</strong>。', 'Void');
        } else {
            baselineSamples.push(v2);
            if (now - phaseStartMs >= VOID_MS) {
                baselineMean = baselineSamples.reduce((a, b) => a + b, 0) / Math.max(1, baselineSamples.length);
                baselineStd = stddev(baselineSamples, baselineMean);
                curNoise = baselineStd;
                peakAdc = v2;
                phase = 'TITAN_WIN';
                phaseStartMs = now;
                holdStartMs = 0;
                setHud(
                    `試煉 ${trialIndex}/${TRIALS_REQUIRED} — Titan`,
                    '圓圈消逝前<strong>灌入魔力</strong>（拉滿弓弦）。',
                    'Titan'
                );
            }
        }
    } else if (phase === 'TITAN_WIN' || phase === 'TITAN_HOLD') {
        peakAdc = Math.max(peakAdc, v2);
        const d = Math.max(0, v2 - baselineMean);
        if (phase === 'TITAN_WIN') {
            if (d >= MIN_PULL_DELTA) {
                phase = 'TITAN_HOLD';
                holdStartMs = now;
                relDrop = 0;
                setHud(
                    `試煉 ${trialIndex}/${TRIALS_REQUIRED} — Titan`,
                    '能量足夠！<strong>維持</strong>並準備放箭。',
                    'Titan'
                );
            } else if (now - phaseStartMs >= TITAN_WINDOW_MS) {
                beginVoidTrial();
                setHud(
                    `試煉 ${trialIndex}/${TRIALS_REQUIRED} — Void`,
                    '魔力不足，重新<strong>虛空定標</strong>…',
                    'Void'
                );
            }
        }
        if (phase === 'TITAN_HOLD') {
            const span = Math.max(MIN_PULL_DELTA, peakAdc - baselineMean);
            const th = peakAdc - RELEASE_FRAC * span;
            if (now - holdStartMs >= MIN_MS_BEFORE_RELEASE && v2 < th) relDrop++;
            else relDrop = 0;
            if (relDrop >= 4) {
                phase = 'RETURN';
                releaseMarkMs = now;
                returnSealed = false;
                relDrop = 0;
                stab = 0;
                postSamp = [];
                setHud(
                    `試煉 ${trialIndex}/${TRIALS_REQUIRED} — Return`,
                    '箭已離弦；量測<strong>回響</strong>…',
                    'Return'
                );
            }
        }
    } else if (phase === 'RETURN' && !returnSealed) {
        const band = Math.max(14, baselineStd * 2.8);
        if (Math.abs(v2 - baselineMean) <= band) {
            stab++;
            postSamp.push(v2);
            if (postSamp.length > 36) postSamp.shift();
            if (stab >= STABLE_NEED) {
                returnSealed = true;
                recMs = now - releaseMarkMs;
                const tail = postSamp.slice(-18);
                const fin = tail.reduce((a, b) => a + b, 0) / tail.length;
                const base = Math.max(45, Math.abs(baselineMean));
                driftPct = (Math.abs(fin - baselineMean) / base) * 100;
                curDelta = Math.max(0, peakAdc - baselineMean);
                const sc = scoreTrial(curNoise, curDelta, recMs, driftPct);
                finalizeTrial(sc);
            }
        } else stab = 0;
        if (!returnSealed && now - releaseMarkMs > 6000) {
            returnSealed = true;
            recMs = now - releaseMarkMs;
            driftPct = (Math.abs(v2 - baselineMean) / Math.max(45, Math.abs(baselineMean))) * 100;
            curDelta = Math.max(0, peakAdc - baselineMean);
            finalizeTrial(scoreTrial(curNoise, curDelta, recMs, driftPct));
        }
    }

    lastAdc = v2;
}

function canvasDims(host) {
    const cw = Math.max(300, host.clientWidth || 360);
    const desktop = typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches;
    const ch = desktop ? 480 : 420;
    return { cw, ch, desktop };
}

function mountP5(host) {
    const P = window.p5;
    vizP5 = new P((p) => {
        const L = ['虛空', '巨力', '回響', '穩定'];

        p.setup = () => {
            const { cw, ch } = canvasDims(host);
            p.createCanvas(cw, ch).parent(host);
            p.colorMode(p.HSB, 360, 100, 100, 1);
            p.noLoop();
            p5ResizeHandler = () => {
                const { cw: nw, ch: nh } = canvasDims(host);
                p.resizeCanvas(nw, nh);
                p.redraw();
            };
            window.addEventListener('resize', p5ResizeHandler);
        };

        p.draw = () => {
            p.background(230, 45, 8);
            const w = p.width;
            const h = p.height;
            const cx = w / 2;
            const en = energyNorm();
            const tMain = p.max(16, p.min(26, w * 0.055));
            const tSub = p.max(13, p.min(20, w * 0.042));
            const tHud = p.max(12, p.min(17, w * 0.034));

            if (phase === 'CERT') {
                p.colorMode(p.RGB, 255);
                const r = p.min(w, h) * 0.3;
                p.push();
                p.translate(cx, h * 0.42);
                p.stroke(60, 70, 90);
                p.strokeWeight(1);
                for (let i = 0; i < 4; i++) {
                    const ang = -p.HALF_PI + (i * p.TWO_PI) / 4;
                    p.line(0, 0, p.cos(ang) * r, p.sin(ang) * r);
                }
                p.stroke(56, 189, 248, 180);
                p.fill(56, 189, 248, 40);
                p.beginShape();
                for (let i = 0; i < 4; i++) {
                    const ang = -p.HALF_PI + (i * p.TWO_PI) / 4;
                    const rr = r * (0.2 + 0.8 * radarVals[i]);
                    p.vertex(p.cos(ang) * rr, p.sin(ang) * rr);
                }
                p.endShape(p.CLOSE);
                p.fill(200);
                p.noStroke();
                p.textAlign(p.CENTER, p.CENTER);
                p.textSize(p.max(11, tSub * 0.85));
                for (let i = 0; i < 4; i++) {
                    const ang = -p.HALF_PI + (i * p.TWO_PI) / 4;
                    p.text(L[i], p.cos(ang) * (r + 32), p.sin(ang) * (r + 32));
                }
                p.pop();
                p.colorMode(p.HSB, 360, 100, 100, 1);
                return;
            }

            if (phase === 'TITAN_WIN' || phase === 'TITAN_HOLD') {
                spawnParticles(p, en);
            }
            stepParticles(p);

            p.colorMode(p.RGB, 255);
            p.textAlign(p.CENTER, p.CENTER);
            if (
                phase === 'VOID' ||
                phase === 'TITAN_WIN' ||
                phase === 'TITAN_HOLD' ||
                phase === 'RETURN'
            ) {
                const barW = w - 48;
                const barY = h * 0.1;
                const barH = p.max(22, tSub * 1.1);
                p.fill(30, 41, 59);
                p.noStroke();
                p.rect(24, barY, barW, barH, 6);
                const g2 = p.lerpColor(p.color(30, 58, 138), p.color(34, 211, 238), en);
                p.fill(g2);
                p.rect(24, barY, barW * en, barH, 6);
                p.stroke(56, 189, 248, 100);
                p.noFill();
                p.rect(24, barY, barW, barH, 6);
                p.fill(226, 232, 240);
                p.noStroke();
                p.textSize(tHud);
                p.text('MAGIC ENERGY', cx, barY - 12);
                p.textSize(tHud * 0.92);
                p.fill(148, 163, 184);
                p.text(`${(en * 100).toFixed(0)} 魔導單位`, cx, barY + barH + 18);
            }

            p.colorMode(p.HSB, 360, 100, 100, 1);
            if (phase === 'VOID') {
                const t = (performance.now() - phaseStartMs) / VOID_MS;
                const a = p.constrain(t, 0, 1);
                p.noFill();
                p.stroke(195, 40, 85, 0.5);
                p.strokeWeight(5);
                const arcR = p.min(110, w * 0.28);
                p.arc(cx, h * 0.52, arcR, arcR, -p.HALF_PI, -p.HALF_PI + a * p.TWO_PI);
            } else if (phase === 'TITAN_WIN') {
                const u = p.constrain(1 - (performance.now() - phaseStartMs) / TITAN_WINDOW_MS, 0, 1);
                const R = p.min(w, h) * 0.36 * (0.25 + 0.75 * u);
                p.noFill();
                p.stroke(265, 70, 90, 0.7);
                p.strokeWeight(3);
                p.circle(cx, h * 0.55, R);
                p.fill(0, 0, 95);
                p.noStroke();
                p.textSize(tMain);
                p.text(`${(u * (TITAN_WINDOW_MS / 1000)).toFixed(1)}s`, cx, h * 0.55);
            }

            if (phase === 'RETURN') {
                p.fill(48, 90, 95);
                p.textSize(tSub);
                p.text('RETURN', cx, h - 22);
            } else if (phase === 'IDLE' || phase === 'BETWEEN') {
                p.colorMode(p.RGB, 255);
                p.fill(186, 198, 214);
                p.textSize(tMain);
                p.text(phase === 'IDLE' ? '輕觸 G0 開始試煉' : '觸發 G0 或按鈕 — 下一輪', cx, h * 0.5);
                p.textSize(tSub * 0.95);
                p.fill(148, 163, 184);
                p.text(phase === 'IDLE' ? '共 3 輪，截尾計分' : '準備下一輪試煉', cx, h * 0.5 + tMain * 1.35);
                p.colorMode(p.HSB, 360, 100, 100, 1);
            }
        };
    }, host);
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
    if (si) si.innerText = '⚡ Omni-Forge：G0+G2';
}

function resetAll() {
    stopViz();
    particles.length = 0;
    phase = 'IDLE';
    trialIndex = 0;
    trialScores = [];
    returnSealed = false;
    touchEma = 3500;
    touchIdleHi = 3800;
    touchPressed = false;
    finalScore = 0;
    trimmedMean = 0;
    hideCertificate();
    rootEl?.querySelector('#of-remake')?.classList.add('hidden');
    rootEl?.querySelector('#of-touch-dot')?.classList.remove('of-touch-dot--on');
    setHud('Omni-Forge', '以物理鍛弓：<code>R = ρ·L/A</code>。輕觸 <strong>G0</strong> 開始第一輪。', '—');
    updateTrialBadge();
    startViz();
    vizP5?.redraw();
}

function applyLayoutRoot() {
    const inner = rootEl?.querySelector('#of-inner');
    if (!inner) return;
    const desktop = window.matchMedia('(min-width: 768px)').matches;
    inner.classList.toggle('of-layout--desktop', desktop);
    inner.classList.toggle('of-layout--mobile', !desktop);
}

function buildDom(root) {
    root.innerHTML = `
<div class="of-root of-layout--mobile" id="of-inner">
  <header class="of-hero">
    <p class="of-lore">弓匠試煉：電阻定律 <strong>R = ρL/A</strong> — 拉距改變有效截面與長度，ADC 反映分壓能量。</p>
    <div class="of-touch-row">
      <div class="of-touch-dot" id="of-touch-dot">G0</div>
      <p class="of-touch-hint">觸發鍵；每輪結束後再觸發下一輪（共 <strong>${TRIALS_REQUIRED} 次</strong>試煉，截尾平均）。連續兩輪未達 ${PASS_SCORE} 分時，將自動調降門檻以利通關。</p>
    </div>
  </header>
  <div class="of-main-grid">
    <div class="of-col of-col--hud">
      <div class="of-hud">
        <span class="of-trial-badge" id="of-trial-badge">TRIAL 0/${TRIALS_REQUIRED}</span>
        <span class="of-phase-pill" id="of-phase-pill" data-phase="">—</span>
      </div>
      <div class="of-card">
        <h2 id="of-hud-title">Omni-Forge</h2>
        <p id="of-hud-body">輕觸 <strong>G0</strong> 開始。</p>
      </div>
      <div class="of-energy-label">✦ Magic Energy Meter ✦</div>
    </div>
    <div class="of-col of-col--viz">
      <div class="of-canvas-host" id="of-canvas-host"></div>
    </div>
  </div>
  <div class="of-cert" id="of-cert">
    <div class="of-relax-banner hidden" id="of-relax-banner" aria-live="polite"></div>
    <div class="of-cert-header">
      <div class="of-cert-title">APPRAISAL CERTIFICATE</div>
      <div class="of-cert-name">Omni-Forge — Bowsmith</div>
    </div>
    <div class="of-stamp of-stamp--f" id="of-stamp">—</div>
    <p class="of-score-line" id="of-final-score"></p>
    <div class="of-cert-radar-host" id="of-cert-radar"></div>
    <p class="of-lock-msg hidden" id="of-lock-msg"></p>
    <p class="of-pass-msg hidden" id="of-pass-msg">試煉通過：下一試煉已解鎖（可自實驗選單進入）。</p>
  </div>
  <div class="of-actions">
    <button type="button" class="of-btn of-btn--primary" id="of-continue">繼續鍛造（G0 或此鍵）</button>
    <button type="button" class="of-btn of-btn--ghost hidden" id="of-next" disabled>前往下一試煉</button>
    <button type="button" class="of-btn of-btn--danger hidden" id="of-remake">Remake 重新鍛造</button>
  </div>
</div>`;

    const cont = root.querySelector('#of-continue');
    cont?.addEventListener('click', () => {
        if (phase === 'IDLE' || phase === 'BETWEEN') beginVoidTrial();
    });
    root.querySelector('#of-remake')?.addEventListener('click', () => resetAll());
    root.querySelector('#of-next')?.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('omnisense:forge-next', { detail: { score: finalScore } }));
        window.alert('請由上方「實驗專案」選單切換至下一個模組。');
    });
}

function syncTrialBadge() {
    const b = rootEl?.querySelector('#of-trial-badge');
    if (b) b.textContent = `TRIAL ${Math.min(trialScores.length + (phase === 'VOID' || phase.includes('TITAN') || phase === 'RETURN' ? 1 : 0), TRIALS_REQUIRED)}/${TRIALS_REQUIRED}`;
}

export async function init(root) {
    injectCss();
    await loadP5();
    rootEl = root;
    omni.currentViewId = 'omni-forge-bowsmith';
    buildDom(root);
    applyLayoutRoot();
    layoutMediaHandler = () => {
        applyLayoutRoot();
        if (typeof p5ResizeHandler === 'function') p5ResizeHandler();
    };
    window.matchMedia('(min-width: 768px)').addEventListener('change', layoutMediaHandler);
    mountP5(root.querySelector('#of-canvas-host'));
    dataHandler = onData;
    window.addEventListener('omnisense:data', dataHandler);
    resetAll();
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
    stopViz();
    if (p5ResizeHandler) {
        window.removeEventListener('resize', p5ResizeHandler);
        p5ResizeHandler = null;
    }
    if (layoutMediaHandler) {
        window.matchMedia('(min-width: 768px)').removeEventListener('change', layoutMediaHandler);
        layoutMediaHandler = null;
    }
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
