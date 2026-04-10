/**
 * Interstellar Voyager: Analog Engine — cartridge
 * UI strings: Traditional Chinese. Code & comments: English.
 */

import { omni, PINS_CONFIG } from '../../web/core/state.js';
import { applyDeviceConfig } from '../../web/core/configApply.js';
import { computeTouchModeMask } from '../../web/core/touchMask.js';
import * as ble from '../../web/core/ble.js';

const STORAGE_KEY = 'omnisense_analog_rocket_v1';
const STORAGE_VERSION = 1;
const STALE_MS = 520;
/** 遊戲中：教學區內放寬「資料過期」判定（避免藍牙略慢即判失效） */
const GAME_STALE_MS = 2200;
/** ADC margin beyond [baseline - M, peak + M] triggers engine failure in-game */
const OUT_OF_RANGE_MARGIN = 160;
/** 教學區：此 scroll 前隧道維持寬敞、緩速（約數秒可飛完） */
const WARMUP_SCROLL_UNITS = 480;
/** 教學區：最長保護時間（秒），與 scroll 二擇一結束 */
const WARMUP_TIME_MS = 6500;
const ADC_MAX = 4095;
const PRESET_MODES = ['adc', 'adc', 'adc', 'adc', 'adc', 'dig', 'dig', 'dig', 'dig'];
/** Analog inputs only (logical G0–G4); G5 is not offered in this lab. */
const PRESET_ACTIVE = 0x1f;
const PRESET_PULLUP = 0;

/** Pin indices available in settings: logical analog channels G0–G4 only */
const PIN_OPTIONS = [0, 1, 2, 3, 4];
const PIN_INDEX_MAX = 4;

let rootEl = null;
let styleLink = null;
let dataListener = null;
let gameP5 = null;
/** @type {ResizeObserver | null} */
let gameHostResizeObs = null;
let arLayoutHandler = null;

/** @type {'hub' | 'settings' | 'wizard' | 'game'} */
let activeView = 'hub';
let wizardStep = 1;
let wizardBuf = [];
/** Min/max ADC observed during wizard step 2 (max-thrust pass). */
let wizardStep2Min = ADC_MAX;
let wizardStep2Max = 0;
let linearRampProgress = 0;
/** Locked logical channel while wizard runs (frozen pin). */
let wizardLockedPin = null;
let wizardPeakUiTimer = null;

let audioCtx = null;
let engineOsc = null;
let engineGain = null;

/** @type {{ pinIndex: number, baseline: number, peak: number, linearOk: boolean } | null} */
let calibration = null;

const runtime = {
    thrustFactor: 0,
    lastRaw: 0,
    lastDataMs: 0,
    engineFailed: false,
    gameDistance: 0,
    /** 由遊戲迴圈更新：教學區內不判訊號失效／越界 */
    gameInWarmup: true
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
        s.onerror = () => reject(new Error('p5 load failed'));
        document.head.appendChild(s);
    });
}

function readRawStore() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const o = JSON.parse(raw);
        if (o.v !== STORAGE_VERSION) return null;
        return o;
    } catch {
        return null;
    }
}

/** Last chosen pin; independent of whether calibration finished. */
function loadSavedPinIndex() {
    const o = readRawStore();
    if (!o) return 0;
    const raw = Number(o.pinIndex);
    if (!Number.isFinite(raw) || raw > PIN_INDEX_MAX || raw < 0) return 0;
    return Math.max(0, Math.min(PIN_INDEX_MAX, raw));
}

function loadStoredCalibration() {
    const o = readRawStore();
    if (!o || !o.linearOk) return null;
    const rawPin = Number(o.pinIndex);
    if (!Number.isFinite(rawPin) || rawPin > PIN_INDEX_MAX || rawPin < 0) return null;
    const pinIndex = Math.max(0, Math.min(PIN_INDEX_MAX, rawPin));
    const baseline = Number(o.baseline);
    const peak = Number(o.peak);
    if (!Number.isFinite(baseline) || !Number.isFinite(peak) || Math.abs(peak - baseline) < 8) return null;
    return { pinIndex, baseline, peak, linearOk: true };
}

function saveCalibration(cal) {
    const payload = {
        v: STORAGE_VERSION,
        pinIndex: cal.pinIndex,
        baseline: Math.round(cal.baseline),
        peak: Math.round(cal.peak),
        linearOk: cal.linearOk
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function clearStoredCalibration() {
    const pin = loadSavedPinIndex();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: STORAGE_VERSION, pinIndex: pin }));
}

function pinLabelZh(idx) {
    const gpio = PINS_CONFIG[idx]?.gpio ?? idx;
    return `G${idx} · GPIO ${gpio}`;
}

/**
 * Map raw ADC to thrust 0..1 using two-point calibration (rest = base, full thrust = peak).
 * Supports both directions: peak may be below base (e.g. flex to GND) or above base.
 */
function thrustFromCalibration(raw, base, peak) {
    const span = peak - base;
    if (Math.abs(span) < 1) return 0;
    const t = (raw - base) / span;
    return Math.max(0, Math.min(1, t));
}

function isSignalOutOfRange(raw) {
    if (!calibration) return false;
    const loEnd = Math.min(calibration.baseline, calibration.peak) - OUT_OF_RANGE_MARGIN;
    const hiEnd = Math.max(calibration.baseline, calibration.peak) + OUT_OF_RANGE_MARGIN;
    return raw < loEnd || raw > hiEnd;
}

function showView(name) {
    activeView = name;
    rootEl?.querySelectorAll('[data-ar-view]').forEach((el) => {
        const v = el.getAttribute('data-ar-view');
        el.classList.toggle('ar-view--on', v === name);
    });
    updateHubVisibility();
    if (name !== 'game') {
        runtime.engineFailed = false;
        setFailOverlay(false);
    }
}

function resolveDataPin() {
    if (wizardLockedPin != null) return wizardLockedPin;
    if (calibration) return calibration.pinIndex;
    const sel = rootEl?.querySelector('#ar-pin-select');
    return Math.max(0, Math.min(PIN_INDEX_MAX, parseInt(sel?.value ?? '0', 10)));
}

function updateHubVisibility() {
    const has = calibration && calibration.linearOk;
    const rowCal = rootEl?.querySelector('#ar-hub-row-calibrated');
    const rowUncal = rootEl?.querySelector('#ar-hub-row-uncalibrated');
    if (rowCal) rowCal.classList.toggle('hidden', !has);
    if (rowUncal) rowUncal.classList.toggle('hidden', has);
}

function setFailOverlay(on) {
    const el = document.getElementById('ar-fail-overlay');
    if (!el) return;
    el.classList.toggle('ar-fail--on', on);
}

function ensureEngineAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || audioCtx) return;
    audioCtx = new AC();
    engineOsc = audioCtx.createOscillator();
    engineOsc.type = 'triangle';
    engineGain = audioCtx.createGain();
    engineGain.gain.value = 0;
    engineOsc.connect(engineGain);
    engineGain.connect(audioCtx.destination);
    engineOsc.start(0);
}

async function resumeEngineAudio() {
    if (!audioCtx) ensureEngineAudio();
    if (audioCtx?.state === 'suspended') await audioCtx.resume();
}

function updateEngineHum(thrust) {
    if (!audioCtx || !engineOsc || !engineGain) return;
    const f = 52 + thrust * 205;
    const g = 0.006 + thrust * 0.11;
    const t = audioCtx.currentTime;
    engineOsc.frequency.setTargetAtTime(f, t, 0.06);
    engineGain.gain.setTargetAtTime(g, t, 0.06);
}

function silenceEngineHum() {
    if (!audioCtx || !engineGain) return;
    engineGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.08);
}

function stopEngineAudioHard() {
    try {
        engineOsc?.stop();
        engineOsc?.disconnect();
        engineGain?.disconnect();
    } catch {
        /* ignore */
    }
    engineOsc = null;
    engineGain = null;
    if (audioCtx) {
        audioCtx.close().catch(() => {});
        audioCtx = null;
    }
}

function destroyGameP5() {
    if (gameHostResizeObs) {
        try {
            gameHostResizeObs.disconnect();
        } catch {
            /* ignore */
        }
        gameHostResizeObs = null;
    }
    if (gameP5) {
        gameP5.remove();
        gameP5 = null;
    }
}

function applyArLayout() {
    const el = rootEl?.querySelector('.ar-root');
    if (!el) return;
    const desktop = window.matchMedia('(min-width: 768px)').matches;
    el.classList.toggle('ar-layout--desktop', desktop);
    el.classList.toggle('ar-layout--mobile', !desktop);
}

function smoothstep01(t) {
    const x = Math.max(0, Math.min(1, t));
    return x * x * (3 - 2 * x);
}

/**
 * Procedural tunnel: early segment is wide & centered (tutorial); later full difficulty.
 * @param {number} scroll — internal distance; higher → harder curve & narrower gap
 */
function tunnelProfile(p, worldX, scroll) {
    const u = Math.min(1, scroll / WARMUP_SCROLL_UNITS);
    const ease = smoothstep01(u);
    const wx = worldX * 0.011;
    const midWiggle =
        p.sin(wx * 1.08) * p.height * 0.2 + p.sin(wx * 1.73 + 0.9) * p.height * 0.09;
    const mid = p.height * 0.5 + midWiggle * ease;
    const gapNarrow = p.height * 0.23 + p.sin(worldX * 0.0061 + 1.2) * p.height * 0.055;
    const gapWide = p.height * 0.46;
    const gap = gapWide * (1 - ease) + gapNarrow * ease;
    return { mid, gap, top: mid - gap / 2, bottom: mid + gap / 2 };
}

/** Canvas size: phone taller play area; desktop wider / taller */
function gameCanvasDims(host) {
    const w = Math.max(300, host.clientWidth || 360);
    const desktop = typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches;
    const h = desktop ? 480 : 380;
    return { w, h, desktop };
}

function mountGameSketch(host) {
    const P = window.p5;
    const state = {
        scroll: 0,
        ry: 0,
        vy: 0,
        dead: false,
        startedAudio: false,
        gameStartMs: 0,
        /** @type {{ x: number; y: number; vx: number; vy: number; life: number; sz: number }[]} */
        particles: [],
        fxShake: 0,
        nebulaPhase: 0,
        lastThrust: 0
    };

    gameP5 = new P((p) => {
        const ROCKET_X = () => p.width * 0.22;
        const ROCKET_H = 38;
        const ROCKET_W = 20;
        const GRAV = 0.082;
        const THRUST_PWR = 0.145;

        function alignRocketToTunnel() {
            const wx = state.scroll + ROCKET_X();
            const tun = tunnelProfile(p, wx, state.scroll);
            state.ry = p.constrain(tun.mid, ROCKET_H / 2 + 4, p.height - ROCKET_H / 2 - 4);
        }

        p.setup = () => {
            const { w, h } = gameCanvasDims(host);
            p.createCanvas(w, h).parent(host);
            state.vy = 0;
            state.scroll = 0;
            state.dead = false;
            state.gameStartMs = performance.now();
            state.particles = [];
            state.fxShake = 0;
            state.nebulaPhase = 0;
            alignRocketToTunnel();
            p.frameRate(60);
            if (typeof ResizeObserver !== 'undefined') {
                gameHostResizeObs = new ResizeObserver(() => {
                    requestAnimationFrame(() => {
                        if (state.dead || activeView !== 'game') return;
                        const dim = gameCanvasDims(host);
                        p.resizeCanvas(dim.w, dim.h);
                        alignRocketToTunnel();
                    });
                });
                gameHostResizeObs.observe(host);
            }
        };

        p.draw = () => {
            if (runtime.engineFailed && activeView === 'game') {
                state.dead = true;
                setFailOverlay(true);
                silenceEngineHum();
                p.noLoop();
                return;
            }

            const nowMs = performance.now();
            /** 教學區結束：航程達門檻「或」已超過最長保護時間 */
            const inWarmup =
                state.scroll < WARMUP_SCROLL_UNITS && nowMs - state.gameStartMs < WARMUP_TIME_MS;
            runtime.gameInWarmup = inWarmup;
            const staleLimit = inWarmup ? GAME_STALE_MS : 1000;

            const thrust = runtime.thrustFactor;
            const dtOk = Date.now() - runtime.lastDataMs < staleLimit;
            if (!dtOk && activeView === 'game' && !inWarmup) {
                runtime.engineFailed = true;
                state.dead = true;
                setFailOverlay(true);
                silenceEngineHum();
                p.noLoop();
                return;
            }

            if (
                calibration &&
                isSignalOutOfRange(runtime.lastRaw) &&
                activeView === 'game' &&
                !inWarmup
            ) {
                runtime.engineFailed = true;
                state.dead = true;
                setFailOverlay(true);
                silenceEngineHum();
                p.noLoop();
                return;
            }

            if (!state.startedAudio) {
                resumeEngineAudio().then(() => {
                    state.startedAudio = true;
                });
            }
            updateEngineHum(thrust);

            const easeFlight = smoothstep01(Math.min(1, state.scroll / WARMUP_SCROLL_UNITS));
            const scrollSpeedMul = 0.28 + 0.72 * easeFlight;
            state.scroll += (1.05 + state.scroll * 0.000012) * scrollSpeedMul;
            runtime.gameDistance = state.scroll * 0.04;

            const gravMul = 0.48 + 0.52 * easeFlight;
            state.vy += GRAV * gravMul;
            state.vy -= thrust * THRUST_PWR;
            state.vy *= 0.995;
            state.ry += state.vy;
            state.ry = p.constrain(state.ry, ROCKET_H / 2 + 4, p.height - ROCKET_H / 2 - 4);

            const wx = state.scroll + ROCKET_X();
            const tun = tunnelProfile(p, wx, state.scroll);
            const canCollide = !inWarmup;
            if (
                canCollide &&
                (state.ry - ROCKET_H / 2 <= tun.top || state.ry + ROCKET_H / 2 >= tun.bottom)
            ) {
                state.dead = true;
                silenceEngineHum();
                p.noStroke();
                for (let yy = 0; yy < p.height; yy++) {
                    const t = yy / p.height;
                    p.stroke(p.lerpColor(p.color(40, 8, 12), p.color(12, 6, 18), t));
                    p.line(0, yy, p.width, yy);
                }
                p.fill(254, 202, 202, 230);
                p.stroke(127, 29, 29, 180);
                p.strokeWeight(3);
                p.textAlign(p.CENTER, p.CENTER);
                p.textSize(p.max(17, p.width * 0.048));
                p.text('船體撞擊 · 任務結束', p.width / 2 + 2, p.height / 2 + 2);
                p.fill(248, 113, 113);
                p.noStroke();
                p.text('船體撞擊 · 任務結束', p.width / 2, p.height / 2);
                p.noLoop();
                return;
            }

            state.nebulaPhase += 0.016 + thrust * 0.04;
            state.fxShake = state.fxShake * 0.82 + thrust * p.random(-3.2, 3.2);
            const shake = p.constrain(state.fxShake, -14, 14);

            const thrustBump = Math.abs(thrust - state.lastThrust);
            state.lastThrust = thrust;
            const rx = ROCKET_X();
            const ry = state.ry;
            if (thrust > 0.06) {
                const n = Math.min(8, 2 + Math.floor(thrust * 10) + Math.floor(thrustBump * 20));
                for (let pi = 0; pi < n; pi++) {
                    state.particles.push({
                        x: rx - ROCKET_W * 0.4 + p.random(-6, 4),
                        y: ry + p.random(-ROCKET_H * 0.4, ROCKET_H * 0.4),
                        vx: p.random(-10, -4) - thrust * 12,
                        vy: p.random(-3.5, 3.5),
                        life: p.random(0.55, 1),
                        sz: p.random(2, 5.5)
                    });
                }
            }
            for (let i = state.particles.length - 1; i >= 0; i--) {
                const q = state.particles[i];
                q.x += q.vx;
                q.y += q.vy;
                q.life -= 0.022 + thrust * 0.015;
                if (q.life <= 0) state.particles.splice(i, 1);
            }

            for (let yy = 0; yy < p.height; yy++) {
                const t = yy / p.height;
                p.stroke(p.lerpColor(p.color(6, 4, 22), p.color(10, 14, 38), t));
                p.line(0, yy, p.width, yy);
            }

            const tNeb = state.nebulaPhase;
            p.noStroke();
            p.fill(99, 102, 241, 35 + thrust * 40);
            p.ellipse(
                p.width * 0.72 + p.sin(tNeb * 0.7) * 40,
                p.height * 0.35 + p.cos(tNeb * 0.5) * 30,
                p.width * 0.55,
                p.height * 0.45
            );
            p.fill(6, 182, 212, 22 + thrust * 35);
            p.ellipse(
                p.width * 0.18 + p.cos(tNeb * 0.6) * 25,
                p.height * 0.62 + p.sin(tNeb * 0.45) * 20,
                p.width * 0.42,
                p.height * 0.38
            );

            for (let layer = 0; layer < 3; layer++) {
                const sp = 0.04 + layer * 0.07;
                const br = 180 + layer * 40;
                p.stroke(br, br, 255, 35 - layer * 8);
                for (let s = 0; s < 55; s++) {
                    const sx = (s * 113 + state.scroll * sp * (12 + layer * 6)) % (p.width + 20) - 10;
                    const sy = (s * 67 + layer * 41) % p.height;
                    p.strokeWeight(layer === 0 ? 1.2 : 0.8);
                    p.point(sx, sy);
                }
            }

            const ahead = 150;
            for (let sx = -60; sx < p.width + ahead; sx += 7) {
                const worldX = state.scroll + sx;
                const t0 = tunnelProfile(p, worldX, state.scroll);
                p.noStroke();
                p.fill(18, 12, 32, 140);
                p.rect(sx, 0, 8, t0.top);
                p.fill(12, 18, 36, 150);
                p.rect(sx, t0.bottom, 8, p.height - t0.bottom);
                p.stroke(34, 211, 238, 100);
                p.strokeWeight(4);
                p.line(sx, t0.top, sx + 7, t0.top);
                p.stroke(167, 139, 250, 90);
                p.strokeWeight(2);
                p.line(sx, t0.bottom, sx + 7, t0.bottom);
            }
            p.stroke(45, 212, 191, 200);
            p.strokeWeight(1.5);
            p.noFill();
            for (let sx = -60; sx < p.width + ahead; sx += 7) {
                const worldX = state.scroll + sx;
                const t0 = tunnelProfile(p, worldX, state.scroll);
                p.line(sx, 0, sx, t0.top);
                p.line(sx, t0.bottom, sx, p.height);
            }

            p.push();
            for (const q of state.particles) {
                p.noStroke();
                const a = q.life;
                p.fill(125 + (1 - a) * 80, 220, 255, a * 220);
                p.circle(q.x, q.y, q.sz * a);
                p.fill(255, 200, 120, a * 120);
                p.circle(q.x - 1, q.y, q.sz * 0.45 * a);
            }
            p.pop();

            const plumeLen = 10 + thrust * 58;
            const cCore = p.lerpColor(p.color(59, 130, 246), p.color(251, 146, 60), thrust);
            const cGlow = p.lerpColor(p.color(34, 211, 238), p.color(244, 114, 182), thrust * 0.7);

            p.push();
            p.translate(shake * 0.7, shake * 0.35);
            p.translate(rx, ry);

            p.noStroke();
            p.fill(p.red(cGlow), p.green(cGlow), p.blue(cGlow), 40 + thrust * 100);
            p.ellipse(-ROCKET_W * 0.2, 0, ROCKET_W * 3.2 + thrust * 40, ROCKET_H * 2.4 + thrust * 30);

            for (let ring = 3; ring >= 1; ring--) {
                p.fill(
                    p.red(cCore),
                    p.green(cCore),
                    p.blue(cCore),
                    (30 + thrust * 70) / ring
                );
                p.ellipse(
                    -ROCKET_W * 0.55 - plumeLen * (0.35 + ring * 0.12),
                    0,
                    plumeLen * (1.1 - ring * 0.08),
                    (ROCKET_H * 0.42 + thrust * 26) / ring
                );
            }

            p.stroke(148, 163, 184, 220);
            p.strokeWeight(2.5);
            const bodyL = p.lerpColor(p.color(51, 65, 85), p.color(148, 163, 184), 0.45);
            p.fill(p.red(bodyL), p.green(bodyL), p.blue(bodyL));
            p.beginShape();
            p.vertex(ROCKET_W * 0.52, 0);
            p.vertex(-ROCKET_W * 0.48, -ROCKET_H * 0.36);
            p.vertex(-ROCKET_W * 0.48, ROCKET_H * 0.36);
            p.endShape(p.CLOSE);
            p.stroke(226, 232, 240, 180);
            p.strokeWeight(1);
            p.noFill();
            p.beginShape();
            p.vertex(ROCKET_W * 0.25, -ROCKET_H * 0.12);
            p.vertex(-ROCKET_W * 0.15, -ROCKET_H * 0.22);
            p.vertex(-ROCKET_W * 0.15, ROCKET_H * 0.22);
            p.endShape();

            p.pop();

            const hudPad = 12;
            const hudW = p.min(p.width - 24, 280);
            p.noStroke();
            p.fill(15, 23, 42, 168);
            p.rect(hudPad, hudPad, hudW, 56, 10);
            p.stroke(34, 211, 238, 100);
            p.strokeWeight(1);
            p.noFill();
            p.rect(hudPad + 0.5, hudPad + 0.5, hudW - 1, 55, 10);

            p.fill(226, 232, 240);
            p.noStroke();
            p.textAlign(p.LEFT, p.TOP);
            p.textSize(p.max(11, p.width * 0.03));
            p.text(`航程 ${runtime.gameDistance.toFixed(0)} m`, hudPad + 14, hudPad + 12);
            p.fill(148, 163, 184);
            p.textSize(p.max(9, p.width * 0.024));
            p.text(`推力 ${(thrust * 100).toFixed(0)}%`, hudPad + 14, hudPad + 32);

            const barX = hudPad + 120;
            const barW = hudW - 140;
            const barY = hudPad + 22;
            p.fill(30, 41, 59);
            p.rect(barX, barY, barW, 8, 4);
            const gBar = p.lerpColor(p.color(6, 182, 212), p.color(251, 113, 133), thrust);
            p.fill(p.red(gBar), p.green(gBar), p.blue(gBar), 220);
            p.rect(barX, barY, Math.max(4, barW * thrust), 8, 4);
            p.fill(255, 255, 255, 60);
            p.rect(barX, barY, barW * thrust, 3, 4);

            if (inWarmup) {
                p.noStroke();
                p.fill(15, 23, 42, 200);
                p.rect(p.width * 0.06, p.height - 62, p.width * 0.88, 48, 12);
                p.stroke(251, 191, 36, 160);
                p.strokeWeight(1.5);
                p.noFill();
                p.rect(p.width * 0.06 + 0.5, p.height - 61.5, p.width * 0.88 - 1, 47, 12);
                p.fill(253, 224, 71);
                p.noStroke();
                p.textSize(p.max(10, p.width * 0.027));
                p.textAlign(p.CENTER, p.CENTER);
                p.text('教學航道 · 緩速寬敞 — 以類比推力上下閃避能量邊界', p.width / 2, p.height - 38);
                p.textAlign(p.LEFT, p.TOP);
            }

            if (thrust > 0.55) {
                p.stroke(255, 255, 255, 40 + thrust * 80);
                p.strokeWeight(1);
                for (let z = 0; z < 6; z++) {
                    const zx = p.random(p.width * 0.35, p.width);
                    const zy = p.random(0, p.height);
                    p.line(zx, zy, zx - p.random(30, 90), zy + p.random(-20, 20));
                }
            }
        };

        p.windowResized = () => {
            const { w, h } = gameCanvasDims(host);
            p.resizeCanvas(w, h);
            if (!state.dead) {
                alignRocketToTunnel();
            }
        };
    }, host);
}

function onSensor(ev) {
    if (omni.currentViewId !== 'analog-rocket') return;

    const pin = resolveDataPin();
    const ch = ev.detail.channels[pin];
    runtime.lastDataMs = Date.now();

    if (!ch) {
        if (activeView === 'game' && !runtime.gameInWarmup) {
            runtime.engineFailed = true;
            setFailOverlay(true);
        }
        return;
    }

    const raw = ch.filtered;
    runtime.lastRaw = raw;

    if (calibration && Math.abs(calibration.peak - calibration.baseline) > 8) {
        runtime.thrustFactor = thrustFromCalibration(raw, calibration.baseline, calibration.peak);
    } else {
        runtime.thrustFactor = 0;
    }

    if (
        activeView === 'game' &&
        calibration &&
        isSignalOutOfRange(raw) &&
        !runtime.gameInWarmup
    ) {
        runtime.engineFailed = true;
        setFailOverlay(true);
    }

    if (activeView !== 'wizard') return;

    if (wizardStep === 1) {
        wizardBuf.push(raw);
        if (wizardBuf.length > 96) wizardBuf.shift();
    } else if (wizardStep === 2) {
        wizardStep2Min = Math.min(wizardStep2Min, raw);
        wizardStep2Max = Math.max(wizardStep2Max, raw);
    } else if (wizardStep === 3) {
        if (calibration && Math.abs(calibration.peak - calibration.baseline) > 8) {
            linearRampProgress = Math.max(linearRampProgress, runtime.thrustFactor);
        }
        const pct = Math.round(linearRampProgress * 100);
        const fill = rootEl?.querySelector('#ar-wizard-ramp-fill');
        const lab = rootEl?.querySelector('#ar-wizard-ramp-pct');
        if (fill) fill.style.width = `${pct}%`;
        if (lab) lab.textContent = `${pct}%`;
    }

    const adcLab = rootEl?.querySelector('#ar-wizard-adc-live');
    if (adcLab) adcLab.textContent = String(raw);
}

function clearWizardTimers() {
    if (wizardPeakUiTimer != null) {
        clearInterval(wizardPeakUiTimer);
        wizardPeakUiTimer = null;
    }
}

function getSelectedPinFromUi() {
    const sel = rootEl?.querySelector('#ar-pin-select');
    return Math.max(0, Math.min(PIN_INDEX_MAX, parseInt(sel?.value ?? '0', 10)));
}

function startWizardFromStep1() {
    clearWizardTimers();
    wizardLockedPin = getSelectedPinFromUi();
    wizardStep = 1;
    wizardBuf = [];
    wizardStep2Min = ADC_MAX;
    wizardStep2Max = 0;
    linearRampProgress = 0;
    calibration = {
        pinIndex: wizardLockedPin,
        baseline: 0,
        peak: ADC_MAX,
        linearOk: false
    };
    showView('wizard');
    renderWizardStepUi();
}

function renderWizardStepUi() {
    clearWizardTimers();
    const stepEl = rootEl?.querySelector('#ar-wizard-step-label');
    const body = rootEl?.querySelector('#ar-wizard-body');
    if (!body || !stepEl) return;

    const fill = rootEl?.querySelector('#ar-wizard-ramp-fill');
    const lab = rootEl?.querySelector('#ar-wizard-ramp-pct');
    if (fill) fill.style.width = wizardStep === 3 ? `${Math.round(linearRampProgress * 100)}%` : '0%';
    if (lab) lab.textContent = wizardStep === 3 ? `${Math.round(linearRampProgress * 100)}%` : '0%';

    if (wizardStep === 1) {
        stepEl.textContent = '步驟 1／3 · 靜態歸零';
        body.innerHTML = `
          <p class="ar-label">請保持感測器無外力，準備完成後記錄基準 ADC。</p>
          <button type="button" class="ar-btn ar-btn--primary" id="ar-wiz-b1">記錄基準值</button>
          <p class="ar-hud">即時 ADC：<span id="ar-wizard-adc-live">—</span></p>`;
        rootEl.querySelector('#ar-wiz-b1')?.addEventListener('click', () => {
            if (wizardBuf.length < 12) {
                window.alert('資料不足，請確認裝置已連線並稍候。');
                return;
            }
            const sum = wizardBuf.reduce((a, b) => a + b, 0);
            const avg = sum / wizardBuf.length;
            if (calibration) calibration.baseline = avg;
            wizardStep = 2;
            wizardStep2Min = ADC_MAX;
            wizardStep2Max = 0;
            renderWizardStepUi();
        });
    } else if (wizardStep === 2) {
        stepEl.textContent = '步驟 2／3 · 最大出力';
        body.innerHTML = `
          <p class="ar-label">請<strong>用力壓到底</strong>維持約一秒，然後點選記錄峰值。</p>
          <button type="button" class="ar-btn ar-btn--primary" id="ar-wiz-b2">記錄峰值</button>
          <p class="ar-hud">即時 ADC：<span id="ar-wizard-adc-live">—</span><br>採樣區間（低～高）：<span id="ar-wiz-peak-hint">—</span></p>`;
        const hint = rootEl.querySelector('#ar-wiz-peak-hint');
        wizardPeakUiTimer = window.setInterval(() => {
            if (hint) {
                hint.textContent =
                    wizardStep2Max >= wizardStep2Min
                        ? `${Math.round(wizardStep2Min)}～${Math.round(wizardStep2Max)}`
                        : '—';
            }
        }, 120);
        rootEl.querySelector('#ar-wiz-b2')?.addEventListener('click', () => {
            clearWizardTimers();
            const base = calibration?.baseline ?? 0;
            const dHigh = wizardStep2Max - base;
            const dLow = base - wizardStep2Min;
            /** Full-thrust ADC: whichever extreme is farther from rest (high or low). */
            const peak =
                dHigh >= dLow ? wizardStep2Max : wizardStep2Min;
            if (!calibration || Math.abs(peak - base) < 24) {
                window.alert('與基準差異過小，無法取得最大出力端點。請確認已加壓至底或採樣區間有含蓋極值後重試。');
                wizardPeakUiTimer = window.setInterval(() => {
                    const h = rootEl?.querySelector('#ar-wiz-peak-hint');
                    if (h) {
                        h.textContent =
                            wizardStep2Max >= wizardStep2Min
                                ? `${Math.round(wizardStep2Min)}～${Math.round(wizardStep2Max)}`
                                : '—';
                    }
                }, 120);
                return;
            }
            calibration.peak = peak;
            wizardStep = 3;
            linearRampProgress = 0;
            renderWizardStepUi();
        });
    } else {
        stepEl.textContent = '步驟 3／3 · 線性測試';
        body.innerHTML = `
          <p class="ar-label">請<strong>由輕至重</strong>慢慢加壓，直到進度列填滿（驗證曲線平滑）。</p>
          <div class="ar-meter"><div id="ar-wizard-ramp-fill" class="ar-meter__fill"></div></div>
          <p class="ar-hud">進度 <span id="ar-wizard-ramp-pct">0%</span> · 即時 ADC <span id="ar-wizard-adc-live">—</span></p>
          <div class="ar-row">
            <button type="button" class="ar-btn ar-btn--primary" id="ar-wiz-b3">完成校準</button>
            <button type="button" class="ar-btn ar-btn--ghost" id="ar-wiz-b3-redo">重測線性</button>
          </div>`;
        const fill3 = rootEl.querySelector('#ar-wizard-ramp-fill');
        const lab3 = rootEl.querySelector('#ar-wizard-ramp-pct');
        if (fill3) fill3.style.width = `${Math.round(linearRampProgress * 100)}%`;
        if (lab3) lab3.textContent = `${Math.round(linearRampProgress * 100)}%`;
        rootEl.querySelector('#ar-wiz-b3-redo')?.addEventListener('click', () => {
            linearRampProgress = 0;
            const f = rootEl.querySelector('#ar-wizard-ramp-fill');
            const l = rootEl.querySelector('#ar-wizard-ramp-pct');
            if (f) f.style.width = '0%';
            if (l) l.textContent = '0%';
        });
        rootEl.querySelector('#ar-wiz-b3')?.addEventListener('click', () => {
            if (linearRampProgress < 0.92) {
                window.alert('請先將線性進度推進至約 full（由輕到重慢慢加壓）。');
                return;
            }
            if (calibration) {
                calibration.linearOk = true;
                calibration.pinIndex = wizardLockedPin ?? calibration.pinIndex;
                saveCalibration(calibration);
            }
            wizardLockedPin = null;
            clearWizardTimers();
            showView('hub');
        });
    }
}

function buildPinOptionsHtml(selected) {
    return PIN_OPTIONS.map((idx) => {
        const sel = idx === selected ? ' selected' : '';
        return `<option value="${idx}"${sel}>${pinLabelZh(idx)}</option>`;
    }).join('');
}

function injectShellHtml() {
    const pinSel = buildPinOptionsHtml(loadSavedPinIndex());
    rootEl.innerHTML = `
<div class="ar-root ar-layout--mobile">
  <div data-ar-view="hub" class="ar-view ar-view--on">
    <h1>星際旅航者：類比引擎</h1>
    <p class="ar-sub">INTERSTELLAR VOYAGER · ANALOG ENGINE</p>
    <div class="ar-panel">
      <p class="ar-label" style="margin-top:0">前線艦橋 · 選擇任務</p>
      <div id="ar-hub-row-calibrated" class="ar-big-actions hidden">
        <button type="button" class="ar-btn ar-btn--primary" id="ar-start-game">開始冒險</button>
        <button type="button" class="ar-btn ar-btn--ghost" id="ar-goto-settings">設定</button>
        <button type="button" class="ar-btn ar-btn--ghost" id="ar-recal-wizard">重新調校引擎</button>
      </div>
      <div id="ar-hub-row-uncalibrated" class="ar-big-actions">
        <p class="ar-label">尚未完成引擎調校。請先執行精靈或至設定選擇腳位。</p>
        <button type="button" class="ar-btn ar-btn--primary" id="ar-force-wizard">引擎調校</button>
        <button type="button" class="ar-btn ar-btn--ghost" id="ar-hub-settings">設定</button>
      </div>
    </div>
  </div>

  <div data-ar-view="settings" class="ar-view">
    <h1>設定</h1>
    <p class="ar-sub">STORAGE · PIN & CALIBRATION</p>
    <div class="ar-panel">
      <label class="ar-label" for="ar-pin-select">量測腳位（邏輯通道 G0–G4 · 類比）</label>
      <select id="ar-pin-select" class="ar-select">${pinSel}</select>
      <div class="ar-row" style="margin-top:0.75rem">
        <button type="button" class="ar-btn ar-btn--primary" id="ar-save-settings">儲存腳位</button>
        <button type="button" class="ar-btn ar-btn--danger" id="ar-clear-cal">清除校準資料</button>
        <button type="button" class="ar-btn ar-btn--ghost" id="ar-back-hub">返回艦橋</button>
      </div>
    </div>
  </div>

  <div data-ar-view="wizard" class="ar-view">
    <h1>引擎調校</h1>
    <p class="ar-sub">GUIDED AUTO-CALIBRATION</p>
    <div class="ar-panel">
      <div class="ar-wiz-step" id="ar-wizard-step-label">—</div>
      <div id="ar-wizard-body"></div>
    </div>
    <div class="ar-row">
      <button type="button" class="ar-btn ar-btn--ghost" id="ar-wiz-cancel">中止並返回</button>
    </div>
  </div>

  <div data-ar-view="game" class="ar-view">
    <div class="ar-game-wrap">
      <div class="ar-game-intro ar-game-intro--escape">
        <h1>行星逃脫</h1>
        <p class="ar-sub">THE ESCAPE · 前段為寬航道教學區；之後難度逐步提高</p>
      </div>
      <div class="ar-panel ar-game-panel ar-game-panel--stage">
        <div id="ar-game-canvas" class="ar-game-canvas-host"></div>
        <div class="ar-row ar-game-actions">
          <button type="button" class="ar-btn ar-btn--ghost" id="ar-exit-game">返回艦橋</button>
        </div>
      </div>
    </div>
  </div>
</div>`;
}

function wireShellEvents() {
    document.getElementById('ar-start-game')?.addEventListener('click', () => {
        runtime.engineFailed = false;
        runtime.gameInWarmup = true;
        runtime.lastDataMs = Date.now();
        setFailOverlay(false);
        showView('game');
        destroyGameP5();
        const host = document.getElementById('ar-game-canvas');
        if (host) mountGameSketch(host);
    });
    document.getElementById('ar-goto-settings')?.addEventListener('click', () => showView('settings'));
    document.getElementById('ar-hub-settings')?.addEventListener('click', () => showView('settings'));
    document.getElementById('ar-recal-wizard')?.addEventListener('click', () => startWizardFromStep1());
    document.getElementById('ar-force-wizard')?.addEventListener('click', () => startWizardFromStep1());

    document.getElementById('ar-save-settings')?.addEventListener('click', () => {
        const p = getSelectedPinFromUi();
        const prev = readRawStore();
        if (prev?.linearOk && prev.pinIndex !== p) {
            if (!window.confirm('變更腳位將清除既有校準。是否繼續？')) return;
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: STORAGE_VERSION, pinIndex: p }));
            calibration = null;
        } else if (calibration?.linearOk) {
            calibration.pinIndex = p;
            saveCalibration(calibration);
        } else {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: STORAGE_VERSION, pinIndex: p }));
            calibration = null;
        }
        syncPinSelectToCal();
        updateHubVisibility();
        showView('hub');
    });
    document.getElementById('ar-clear-cal')?.addEventListener('click', () => {
        if (!window.confirm('確定清除校準資料？')) return;
        calibration = null;
        clearStoredCalibration();
        wizardLockedPin = null;
        updateHubVisibility();
        showView('hub');
    });
    document.getElementById('ar-back-hub')?.addEventListener('click', () => showView('hub'));

    document.getElementById('ar-exit-game')?.addEventListener('click', () => {
        destroyGameP5();
        silenceEngineHum();
        showView('hub');
    });
    document.getElementById('ar-wiz-cancel')?.addEventListener('click', () => {
        clearWizardTimers();
        wizardLockedPin = null;
        calibration = loadStoredCalibration();
        showView('hub');
    });

    const sel = document.getElementById('ar-pin-select');
    sel?.addEventListener('change', () => {
        /* live pin preview only */
    });
}

async function applyDevicePreset() {
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
}

/**
 * Mount UI and state. Required by OmniSense shell as mount(root).
 */
export async function init(container) {
    rootEl = container;
    omni.currentViewId = 'analog-rocket';
    calibration = loadStoredCalibration();
    wizardLockedPin = null;
    injectCss();
    injectShellHtml();
    applyArLayout();
    arLayoutHandler = () => applyArLayout();
    window.addEventListener('resize', arLayoutHandler);
    wireShellEvents();
    syncPinSelectToCal();
    await loadP5();
    dataListener = (ev) => onSensor(ev);
    window.addEventListener('omnisense:data', dataListener);

    if (calibration?.linearOk) showView('hub');
    else startWizardFromStep1();

    document.getElementById('ar-fail-overlay')?.remove();
    const fo = document.createElement('div');
    fo.id = 'ar-fail-overlay';
    fo.className = 'ar-fail';
    fo.innerHTML = `
      <h2>引擎失效</h2>
      <p class="ar-label" style="text-align:center;max-width:280px;color:#94a3b8">訊號遺失或讀值超出校準範圍。請檢查連線與感測器。</p>
      <button type="button" class="ar-btn ar-btn--primary" id="ar-fail-ok">返回艦橋</button>`;
    document.body.appendChild(fo);
    document.getElementById('ar-fail-ok')?.addEventListener('click', () => {
        runtime.engineFailed = false;
        setFailOverlay(false);
        destroyGameP5();
        silenceEngineHum();
        showView('hub');
    });
}

function syncPinSelectToCal() {
    const sel = rootEl?.querySelector('#ar-pin-select');
    if (!sel) return;
    const v = calibration?.pinIndex ?? loadSavedPinIndex();
    sel.innerHTML = buildPinOptionsHtml(v);
    sel.value = String(v);
}

export async function mount(root) {
    return init(root);
}

export async function onConnected() {
    await applyDevicePreset();
    const si = document.getElementById('syncIndicator');
    if (si) si.innerText = '⚡ 類比引擎：G0–G4 已啟用';
}

export async function cleanup() {
    if (arLayoutHandler) {
        window.removeEventListener('resize', arLayoutHandler);
        arLayoutHandler = null;
    }
    window.removeEventListener('omnisense:data', dataListener);
    dataListener = null;
    clearWizardTimers();
    wizardLockedPin = null;
    destroyGameP5();
    stopEngineAudioHard();
    document.getElementById('ar-fail-overlay')?.remove();
    if (rootEl) {
        rootEl.innerHTML = '';
        rootEl = null;
    }
    calibration = null;
}

export async function unmount() {
    return cleanup();
}