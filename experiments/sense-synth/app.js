/**
 * Sense-Synth Poly — 五路感測多音合成器（Web Audio + p5 示波）
 * 邏輯通道 0–4（實體 GPIO 0–4）：ADC → 220–1200 Hz，高讀值 → 高頻
 */

import { omni, PINS_CONFIG } from '../../web/core/state.js';
import { applyDeviceConfig } from '../../web/core/configApply.js';
import { computeTouchModeMask } from '../../web/core/touchMask.js';
import * as ble from '../../web/core/ble.js';

/** 前五類比通道（使用者慣稱多路感測時與 G0–G4 對齊） */
const CHANS = [0, 1, 2, 3, 4];
const ADC_MAX = 4095;
const F_MIN = 220;
const F_MAX = 1200;
const SCOPE_LEN = 200;
/** 每聲道貢獻增益（疊加五路仍低於 clipping） */
const PER_VOICE_GAIN = 0.11;
const FREQ_SMOOTH_S = 0.028;

const WAVE_COLORS = [
    [34, 211, 238],
    [99, 102, 241],
    [251, 191, 36],
    [52, 211, 153],
    [244, 114, 182]
];

const PRESET_ACTIVE = 0x1f;
const PRESET_PULLUP = 0;
const PRESET_MODES = ['adc', 'adc', 'adc', 'adc', 'adc', 'dig', 'dig', 'dig', 'dig'];

let rootEl = null;
let styleLink = null;
let dataHandler = null;
let vizP5 = null;

let audioCtx = null;
let masterGain = null;
/** @type {{ osc: OscillatorNode, gain: GainNode }[]} */
let voices = [];
let volumeSliderValue = 0.38;

const channelOn = [true, true, true, true, true];
const scopeRows = CHANS.map(() => new Float32Array(SCOPE_LEN).fill(0.5));
let scopeWrite = 0;

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

function adcToFreq(adc) {
    const x = Math.max(0, Math.min(ADC_MAX, adc)) / ADC_MAX;
    return F_MIN + x * (F_MAX - F_MIN);
}

function ensureAudioGraph() {
    if (audioCtx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = new Ctx();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = volumeSliderValue * 0.55;
    masterGain.connect(audioCtx.destination);

    const wave = rootEl?.querySelector('#ssp-waveform')?.value || 'sine';
    for (let i = 0; i < 5; i++) {
        const osc = audioCtx.createOscillator();
        osc.type = wave === 'triangle' ? 'triangle' : 'sine';
        osc.frequency.value = F_MIN;
        const g = audioCtx.createGain();
        g.gain.value = channelOn[i] ? PER_VOICE_GAIN : 0;
        osc.connect(g);
        g.connect(masterGain);
        osc.start();
        voices.push({ osc, gain: g });
    }
}

async function resumeAudio() {
    ensureAudioGraph();
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    rootEl?.querySelector('#ssp-enable-audio')?.classList.add('hidden');
}

function setMasterFromUi() {
    if (!masterGain || !audioCtx) return;
    const v = volumeSliderValue * 0.55;
    masterGain.gain.setTargetAtTime(v, audioCtx.currentTime, 0.02);
}

function updateWaveformType() {
    const w = rootEl?.querySelector('#ssp-waveform')?.value || 'sine';
    const t = w === 'triangle' ? 'triangle' : 'sine';
    for (const v of voices) {
        v.osc.type = t;
    }
}

function syncChannelGains() {
    if (!audioCtx) return;
    for (let i = 0; i < voices.length; i++) {
        const g = channelOn[i] ? PER_VOICE_GAIN : 0;
        voices[i].gain.gain.setTargetAtTime(g, audioCtx.currentTime, 0.015);
    }
    refreshToggleUi();
}

function refreshToggleUi() {
    CHANS.forEach((_, idx) => {
        const btn = rootEl?.querySelector(`[data-ssp-ch="${idx}"]`);
        if (!btn) return;
        const on = channelOn[idx];
        btn.classList.toggle('ssp-ch-btn--on', on);
        btn.style.background = on
            ? `rgba(${WAVE_COLORS[idx][0]}, ${WAVE_COLORS[idx][1]}, ${WAVE_COLORS[idx][2]}, 0.35)`
            : '';
        btn.style.borderColor = on ? `rgba(${WAVE_COLORS[idx][0]}, ${WAVE_COLORS[idx][1]}, ${WAVE_COLORS[idx][2]}, 0.65)` : '';
    });
}

function pushScopeSample(channels) {
    for (let i = 0; i < 5; i++) {
        const ch = CHANS[i];
        const c = channels[ch];
        const raw = c ? c.filtered : 0;
        scopeRows[i][scopeWrite] = Math.max(0, Math.min(1, raw / ADC_MAX));
    }
    scopeWrite = (scopeWrite + 1) % SCOPE_LEN;
}

function onData(ev) {
    if (omni.currentViewId !== 'sense-synth') return;
    const ch = ev.detail.channels;
    pushScopeSample(ch);

    if (audioCtx && voices.length === 5) {
        const t = audioCtx.currentTime;
        for (let i = 0; i < 5; i++) {
            const logic = CHANS[i];
            const c = ch[logic];
            if (!c) continue;
            const f = adcToFreq(c.filtered);
            voices[i].osc.frequency.setTargetAtTime(f, t, FREQ_SMOOTH_S);
        }
    }
    vizP5?.redraw();
}

function mountP5(host) {
    const P = window.p5;
    vizP5 = new P((p) => {
        p.setup = () => {
            const w = Math.max(280, host.clientWidth || 320);
            p.createCanvas(w, 220).parent(host);
            p.noLoop();
        };
        p.draw = () => {
            p.background(8, 12, 28);
            const pad = 8;
            const plotW = p.width - pad * 2;
            const plotH = p.height - pad * 2;
            p.stroke(51, 65, 85, 100);
            p.strokeWeight(1);
            for (let g = 0; g <= 4; g++) {
                const gy = pad + (g * plotH) / 4;
                p.line(pad, gy, pad + plotW, gy);
            }
            const n = SCOPE_LEN;
            for (let ci = 0; ci < 5; ci++) {
                const [r, gg, b] = WAVE_COLORS[ci];
                p.stroke(r, gg, b, 200);
                p.strokeWeight(1.75);
                p.noFill();
                p.beginShape();
                for (let k = 0; k < n; k++) {
                    const idx = (scopeWrite + k) % n;
                    const x = pad + (k / (n - 1)) * plotW;
                    const y = pad + plotH - scopeRows[ci][idx] * plotH;
                    p.vertex(x, y);
                }
                p.endShape();
            }
        };
    }, host);
}

function wireUi() {
    CHANS.forEach((_, idx) => {
        rootEl?.querySelector(`[data-ssp-ch="${idx}"]`)?.addEventListener('click', async () => {
            await resumeAudio();
            channelOn[idx] = !channelOn[idx];
            syncChannelGains();
        });
    });

    rootEl?.querySelector('#ssp-enable-audio')?.addEventListener('click', () => resumeAudio().catch(console.warn));

    rootEl?.querySelector('#ssp-waveform')?.addEventListener('change', () => {
        updateWaveformType();
        vizP5?.redraw();
    });

    rootEl?.querySelector('#ssp-volume')?.addEventListener('input', (e) => {
        const v = parseFloat(e.target?.value);
        volumeSliderValue = Number.isFinite(v) ? v : 0.38;
        setMasterFromUi();
        const lab = rootEl?.querySelector('#ssp-volume-label');
        if (lab) lab.textContent = `${Math.round(volumeSliderValue * 100)}%`;
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
    if (si) si.innerText = '⚡ Sense-Synth：G0–G4 類比';
}

function buildDom(root) {
    const gpioLabels = CHANS.map((logic) => PINS_CONFIG[logic].gpio);
    const toggles = CHANS.map(
        (logic, idx) => `
<button type="button" class="ssp-ch-btn ssp-ch-btn--on" data-ssp-ch="${idx}" style="border-color: rgba(${WAVE_COLORS[idx].join(',')},0.45); background: rgba(${WAVE_COLORS[idx].join(',')},0.35);">
  G${gpioLabels[idx]}
  <small>CH${logic}</small>
</button>`
    ).join('');

    root.innerHTML = `
<div class="ssp-root">
  <div class="ssp-hero">
    <div class="ssp-title">Sense-Synth Poly</div>
    <p class="ssp-sub">五路獨立音高 · ADC 0–4095 → ${F_MIN}–${F_MAX} Hz（讀值愈高 → 頻率愈高）<br>
    邏輯通道 0–4 · 請在主控台或下方預設啟用對應腳位</p>
  </div>
  <div class="ssp-grid">
    <div class="ssp-card">
      <h3>聲部開關</h3>
      <div class="ssp-toggles">${toggles}</div>
      <button type="button" id="ssp-enable-audio" class="ssp-enable-audio">輕觸以啟用音效（瀏覽器要求）</button>
      <div class="ssp-controls-row">
        <label>波形</label>
        <select id="ssp-waveform">
          <option value="sine" selected>正弦</option>
          <option value="triangle">三角</option>
        </select>
        <div class="ssp-vol">
          <label for="ssp-volume">音量</label>
          <input type="range" id="ssp-volume" min="0" max="1" step="0.02" value="${volumeSliderValue}" />
          <span id="ssp-volume-label">${Math.round(volumeSliderValue * 100)}%</span>
        </div>
      </div>
      <p class="ssp-audio-hint">建議教室內先放低音量；五路齊開時仍經由 GainNode 限幅。</p>
    </div>
    <div class="ssp-card">
      <h3>即時感測示波（五軌疊加）</h3>
      <div id="ssp-canvas-host" class="ssp-viz"></div>
    </div>
  </div>
</div>`;
}

export async function mount(root) {
    rootEl = root;
    omni.currentViewId = 'sense-synth';
    injectCss();
    buildDom(root);
    wireUi();
    refreshToggleUi();
    await loadP5();
    const host = root.querySelector('#ssp-canvas-host');
    if (host) mountP5(host);
    dataHandler = (ev) => onData(ev);
    window.addEventListener('omnisense:data', dataHandler);
}

export async function onConnected() {
    await applyPreset();
}

async function teardownSynth() {
    window.removeEventListener('omnisense:data', dataHandler);
    dataHandler = null;

    if (vizP5) {
        vizP5.remove();
        vizP5 = null;
    }

    for (const v of voices) {
        try {
            v.osc.stop();
            v.osc.disconnect();
            v.gain.disconnect();
        } catch {
            /* ignore */
        }
    }
    voices = [];
    if (masterGain) {
        try {
            masterGain.disconnect();
        } catch {
            /* ignore */
        }
        masterGain = null;
    }
    if (audioCtx) {
        try {
            await audioCtx.close();
        } catch {
            /* ignore */
        }
        audioCtx = null;
    }

    if (rootEl) {
        rootEl.innerHTML = '';
        rootEl = null;
    }
}

export async function cleanup() {
    await teardownSynth();
}

export async function unmount() {
    await cleanup();
}
