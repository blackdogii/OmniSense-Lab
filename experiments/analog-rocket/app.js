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
/** ADC margin beyond [baseline - M, peak + M] triggers engine failure in-game */
const OUT_OF_RANGE_MARGIN = 160;
const ADC_MAX = 4095;
const PRESET_MODES = ['adc', 'adc', 'adc', 'adc', 'adc', 'dig', 'dig', 'dig', 'dig'];
const PRESET_ACTIVE = 0x3f;
const PRESET_PULLUP = 0;

/** Pin indices available in settings: logical channels 0–5 */
const PIN_OPTIONS = [0, 1, 2, 3, 4, 5];

let rootEl = null;
let styleLink = null;
let dataListener = null;
let gameP5 = null;

/** @type {'hub' | 'settings' | 'wizard' | 'game'} */
let activeView = 'hub';
let wizardStep = 1;
let wizardBuf = [];
let wizardPeakAcc = 0;
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
    gameDistance: 0
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
    return Math.max(0, Math.min(5, Number(o.pinIndex) || 0));
}

function loadStoredCalibration() {
    const o = readRawStore();
    if (!o || !o.linearOk) return null;
    const pinIndex = Math.max(0, Math.min(5, Number(o.pinIndex) || 0));
    const baseline = Number(o.baseline);
    const peak = Number(o.peak);
    if (!Number.isFinite(baseline) || !Number.isFinite(peak) || peak <= baseline + 8) return null;
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
    const tail = idx === 5 ? '（數位）' : '';
    return `G${idx} · GPIO ${gpio}${tail}`;
}

/**
 * Map raw ADC to thrust 0..1 using two-point calibration.
 */
function thrustFromCalibration(raw, base, peak) {
    const span = Math.max(peak - base, 1);
    const t = (raw - base) / span;
    return Math.max(0, Math.min(1, t));
}

function isSignalOutOfRange(raw) {
    if (!calibration) return false;
    const lo = calibration.baseline - OUT_OF_RANGE_MARGIN;
    const hi = calibration.peak + OUT_OF_RANGE_MARGIN;
    return raw < lo || raw > hi;
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
    return Math.max(0, Math.min(5, parseInt(sel?.value ?? '0', 10)));
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
    if (gameP5) {
        gameP5.remove();
        gameP5 = null;
    }
}

/**
 * Procedural tunnel center Y and gap height for world X (pixels).
 */
function tunnelProfile(p, worldX) {
    const wx = worldX * 0.011;
    const mid =
        p.height * 0.5 +
        p.sin(wx * 1.08) * p.height * 0.2 +
        p.sin(wx * 1.73 + 0.9) * p.height * 0.09;
    const gap = p.height * 0.23 + p.sin(worldX * 0.0061 + 1.2) * p.height * 0.055;
    return { mid, gap, top: mid - gap / 2, bottom: mid + gap / 2 };
}

function mountGameSketch(host) {
    const P = window.p5;
    const state = {
        scroll: 0,
        ry: 0,
        vy: 0,
        dead: false,
        startedAudio: false
    };

    gameP5 = new P((p) => {
        const ROCKET_X = () => p.width * 0.22;
        const ROCKET_H = 38;
        const ROCKET_W = 20;
        const GRAV = 0.082;
        const THRUST_PWR = 0.145;

        p.setup = () => {
            p.createCanvas(Math.max(300, host.clientWidth || 360), 240).parent(host);
            state.ry = p.height * 0.5;
            state.vy = 0;
            state.scroll = 0;
            state.dead = false;
            p.frameRate(55);
        };

        p.draw = () => {
            if (runtime.engineFailed && activeView === 'game') {
                state.dead = true;
                setFailOverlay(true);
                silenceEngineHum();
                p.noLoop();
                return;
            }

            const thrust = runtime.thrustFactor;
            const dtOk = Date.now() - runtime.lastDataMs < STALE_MS;
            if (!dtOk && activeView === 'game') {
                runtime.engineFailed = true;
                state.dead = true;
                setFailOverlay(true);
                silenceEngineHum();
                p.noLoop();
                return;
            }

            if (calibration && isSignalOutOfRange(runtime.lastRaw) && activeView === 'game') {
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

            p.background(4, 8, 20);
            const wobble = p.sin(state.scroll * 0.002) * 6;
            for (let i = 0; i < 50; i++) {
                const x = (i * 37 + state.scroll * 0.15 + wobble) % p.width;
                p.stroke(30, 58, 95, 40);
                p.line(x, 0, x, p.height);
            }

            state.scroll += 1.15 + state.scroll * 0.000015;
            runtime.gameDistance = state.scroll * 0.04;

            state.vy += GRAV;
            state.vy -= thrust * THRUST_PWR;
            state.vy *= 0.995;
            state.ry += state.vy;
            state.ry = p.constrain(state.ry, ROCKET_H / 2 + 4, p.height - ROCKET_H / 2 - 4);

            const wx = state.scroll + ROCKET_X();
            const tun = tunnelProfile(p, wx);
            if (state.ry - ROCKET_H / 2 <= tun.top || state.ry + ROCKET_H / 2 >= tun.bottom) {
                state.dead = true;
                silenceEngineHum();
                p.fill(248, 113, 113, 180);
                p.textAlign(p.CENTER, p.CENTER);
                p.textSize(14);
                p.text('船體撞擊 · 任務結束', p.width / 2, p.height / 2);
                p.noLoop();
                return;
            }

            const ahead = 140;
            p.stroke(34, 197, 94, 120);
            p.strokeWeight(2);
            p.noFill();
            for (let sx = -50; sx < p.width + ahead; sx += 8) {
                const worldX = state.scroll + sx;
                const t0 = tunnelProfile(p, worldX);
                p.line(sx, 0, sx, t0.top);
                p.line(sx, t0.bottom, sx, p.height);
            }

            const plumeLen = 6 + thrust * 48;
            const c0 = p.lerpColor(p.color(36, 99, 235), p.color(255, 170, 60), thrust);
            p.push();
            p.translate(ROCKET_X(), state.ry);
            p.noStroke();
            p.fill(p.red(c0), p.green(c0), p.blue(c0), 90 + thrust * 165);
            p.ellipse(-ROCKET_W * 0.55 - plumeLen * 0.5, 0, plumeLen, ROCKET_H * 0.35 + thrust * 22);
            p.stroke(226, 232, 240);
            p.strokeWeight(2);
            p.fill(71, 85, 105);
            p.beginShape();
            p.vertex(ROCKET_W * 0.5, 0);
            p.vertex(-ROCKET_W * 0.45, -ROCKET_H * 0.35);
            p.vertex(-ROCKET_W * 0.45, ROCKET_H * 0.35);
            p.endShape(p.CLOSE);
            p.pop();

            p.fill(148, 163, 184);
            p.noStroke();
            p.textAlign(p.LEFT, p.TOP);
            p.textSize(10);
            p.text(`航程 ${runtime.gameDistance.toFixed(0)} m · 推力 ${(thrust * 100).toFixed(0)}%`, 8, 8);
        };

        p.windowResized = () => {
            p.resizeCanvas(Math.max(300, host.clientWidth), 240);
        };
    }, host);
}

function onSensor(ev) {
    if (omni.currentViewId !== 'analog-rocket') return;

    const pin = resolveDataPin();
    const ch = ev.detail.channels[pin];
    runtime.lastDataMs = Date.now();

    if (!ch) {
        if (activeView === 'game') {
            runtime.engineFailed = true;
            setFailOverlay(true);
        }
        return;
    }

    const raw = ch.filtered;
    runtime.lastRaw = raw;

    if (calibration && calibration.peak > calibration.baseline + 8) {
        runtime.thrustFactor = thrustFromCalibration(raw, calibration.baseline, calibration.peak);
    } else {
        runtime.thrustFactor = 0;
    }

    if (activeView === 'game' && calibration && isSignalOutOfRange(raw)) {
        runtime.engineFailed = true;
        setFailOverlay(true);
    }

    if (activeView !== 'wizard') return;

    if (wizardStep === 1) {
        wizardBuf.push(raw);
        if (wizardBuf.length > 96) wizardBuf.shift();
    } else if (wizardStep === 2) {
        wizardPeakAcc = Math.max(wizardPeakAcc, raw);
    } else if (wizardStep === 3) {
        if (calibration && calibration.peak > calibration.baseline + 8) {
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
    return Math.max(0, Math.min(5, parseInt(sel?.value ?? '0', 10)));
}

function startWizardFromStep1() {
    clearWizardTimers();
    wizardLockedPin = getSelectedPinFromUi();
    wizardStep = 1;
    wizardBuf = [];
    wizardPeakAcc = 0;
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
            wizardPeakAcc = avg;
            renderWizardStepUi();
        });
    } else if (wizardStep === 2) {
        stepEl.textContent = '步驟 2／3 · 最大出力';
        body.innerHTML = `
          <p class="ar-label">請<strong>用力壓到底</strong>維持約一秒，然後點選記錄峰值。</p>
          <button type="button" class="ar-btn ar-btn--primary" id="ar-wiz-b2">記錄峰值</button>
          <p class="ar-hud">即時 ADC：<span id="ar-wizard-adc-live">—</span><br>目前峰值候選：<span id="ar-wiz-peak-hint">—</span></p>`;
        const hint = rootEl.querySelector('#ar-wiz-peak-hint');
        wizardPeakUiTimer = window.setInterval(() => {
            if (hint) hint.textContent = String(wizardPeakAcc);
        }, 120);
        rootEl.querySelector('#ar-wiz-b2')?.addEventListener('click', () => {
            clearWizardTimers();
            const peak = wizardPeakAcc;
            if (!calibration || peak < calibration.baseline + 24) {
                window.alert('峰值不足，與基準差異過小。請再用力加壓後重試。');
                wizardPeakUiTimer = window.setInterval(() => {
                    const h = rootEl?.querySelector('#ar-wiz-peak-hint');
                    if (h) h.textContent = String(wizardPeakAcc);
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
<div class="ar-root">
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
      <label class="ar-label" for="ar-pin-select">量測腳位（邏輯通道 G0–G5）</label>
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
    <h1>行星逃脫</h1>
    <p class="ar-sub">THE ESCAPE · THRUST = 校準後推力係數</p>
    <div class="ar-panel">
      <div id="ar-game-canvas"></div>
      <div class="ar-row">
        <button type="button" class="ar-btn ar-btn--ghost" id="ar-exit-game">返回艦橋</button>
      </div>
    </div>
  </div>
</div>`;
}

function wireShellEvents() {
    document.getElementById('ar-start-game')?.addEventListener('click', () => {
        runtime.engineFailed = false;
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
    if (si) si.innerText = '⚡ 類比引擎：G0–G5 已啟用';
}

export async function cleanup() {
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