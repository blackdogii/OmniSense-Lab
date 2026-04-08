/**
 * Omni Mixer cartridge (Web Audio + p5 scope).
 * UI language is Traditional Chinese by requirement.
 */

import { omni } from '../../web/core/state.js';
import { applyDeviceConfig } from '../../web/core/configApply.js';
import { computeTouchModeMask } from '../../web/core/touchMask.js';
import * as ble from '../../web/core/ble.js';

const CHANS = [0, 1, 2, 3, 4];
const ADC_MAX = 4095;
const NOISE_GATE_DELTA = 10;
const ADSR_SEC = 0.05;
const SCOPE_POINTS = 220;
const PRESET_ACTIVE = 0x1f;
const PRESET_PULLUP = 0;
const PRESET_MODES = ['adc', 'adc', 'adc', 'adc', 'adc', 'dig', 'dig', 'dig', 'dig'];

const COLOR_RGB = [
    [34, 211, 238],
    [99, 102, 241],
    [251, 191, 36],
    [52, 211, 153],
    [244, 114, 182]
];

const STYLE_PRESETS = {
    elegant: { min: 220, max: 660, osc: 'sine' },
    magical: { min: 880, max: 3500, osc: 'triangle' }
};

let rootEl = null;
let styleLink = null;
let dataHandler = null;
let vizP5 = null;

let audioCtx = null;
let masterGain = null;
/** @type {{ osc: OscillatorNode, gain: GainNode }[]} */
let voices = [];

const channelOn = [true, true, true, true, true];
const lastAdc = [0, 0, 0, 0, 0];
const currentFreq = [220, 220, 220, 220, 220];
const phaseState = [0, 0, 0, 0, 0];
let isAudioReady = false;
let volumeValue = 0.42;

const scopeRows = CHANS.map(() => new Float32Array(SCOPE_POINTS).fill(0));
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

function getStyleMode() {
    return rootEl?.querySelector('#omx-style')?.value || 'elegant';
}

function getFreqRange() {
    const mode = getStyleMode();
    if (mode === 'custom') {
        const minV = Number(rootEl?.querySelector('#omx-fmin')?.value);
        const maxV = Number(rootEl?.querySelector('#omx-fmax')?.value);
        const min = Number.isFinite(minV) ? Math.max(20, minV) : 220;
        const max = Number.isFinite(maxV) ? Math.max(min + 1, maxV) : 1200;
        return { min, max, osc: 'sine' };
    }
    return STYLE_PRESETS[mode] || STYLE_PRESETS.elegant;
}

function mapAdcToFreq(adc, min, max) {
    const x = Math.max(0, Math.min(ADC_MAX, adc)) / ADC_MAX;
    return min + x * (max - min);
}

function refreshCustomInputs() {
    const wrap = rootEl?.querySelector('#omx-custom-wrap');
    const isCustom = getStyleMode() === 'custom';
    if (wrap) wrap.classList.toggle('hidden', !isCustom);
}

function refreshHzLabels() {
    for (let i = 0; i < CHANS.length; i++) {
        const el = rootEl?.querySelector(`#omx-hz-${i}`);
        if (!el) continue;
        el.textContent = `${Math.round(currentFreq[i])} Hz`;
    }
}

function ensureAudioGraph() {
    if (audioCtx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0;
    masterGain.connect(audioCtx.destination);

    const cfg = getFreqRange();
    for (let i = 0; i < 5; i++) {
        const osc = audioCtx.createOscillator();
        osc.type = cfg.osc;
        osc.frequency.value = cfg.min;
        const gain = audioCtx.createGain();
        gain.gain.value = 0;
        osc.connect(gain);
        gain.connect(masterGain);
        osc.start();
        voices.push({ osc, gain });
    }
}

function applyMasterGain() {
    if (!audioCtx || !masterGain) return;
    // hard ceiling to keep summed output <= 1.0
    const gain = Math.max(0, Math.min(1, volumeValue));
    masterGain.gain.setTargetAtTime(gain, audioCtx.currentTime, ADSR_SEC);
}

function updateVoiceGainsWithAdsr() {
    if (!audioCtx || voices.length !== 5) return;
    const activeCount = channelOn.filter(Boolean).length || 1;
    const perVoice = Math.min(1, 1 / activeCount) * 0.9;
    const now = audioCtx.currentTime;
    for (let i = 0; i < 5; i++) {
        const target = channelOn[i] ? perVoice : 0;
        voices[i].gain.gain.cancelScheduledValues(now);
        voices[i].gain.gain.setTargetAtTime(target, now, ADSR_SEC);
    }
}

function applyOscTypeFromStyle() {
    const cfg = getFreqRange();
    for (const v of voices) v.osc.type = cfg.osc;
}

async function resumeAudio() {
    ensureAudioGraph();
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    isAudioReady = true;
    rootEl?.querySelector('#omx-enable')?.classList.add('hidden');
    applyMasterGain();
    updateVoiceGainsWithAdsr();
}

function pushScopeFromFrequencies() {
    for (let i = 0; i < 5; i++) {
        const amp = channelOn[i] ? 1 : 0.2;
        const hz = currentFreq[i];
        phaseState[i] += (hz / 1200) * 0.22;
        if (phaseState[i] > Math.PI * 2) phaseState[i] -= Math.PI * 2;
        scopeRows[i][scopeWrite] = Math.sin(phaseState[i]) * amp;
    }
    scopeWrite = (scopeWrite + 1) % SCOPE_POINTS;
}

function onData(ev) {
    if (omni.currentViewId !== 'sense-synth') return;
    const channels = ev.detail.channels;
    const cfg = getFreqRange();

    if (audioCtx && voices.length === 5) {
        const now = audioCtx.currentTime;
        for (let i = 0; i < CHANS.length; i++) {
            const c = channels[CHANS[i]];
            if (!c) continue;
            const adc = c.filtered;
            const delta = Math.abs(adc - lastAdc[i]);
            if (delta >= NOISE_GATE_DELTA) {
                const f = mapAdcToFreq(adc, cfg.min, cfg.max);
                currentFreq[i] = f;
                voices[i].osc.frequency.setTargetAtTime(f, now, 0.03);
                lastAdc[i] = adc;
            }
        }
    } else {
        for (let i = 0; i < CHANS.length; i++) {
            const c = channels[CHANS[i]];
            if (!c) continue;
            const adc = c.filtered;
            if (Math.abs(adc - lastAdc[i]) >= NOISE_GATE_DELTA) {
                currentFreq[i] = mapAdcToFreq(adc, cfg.min, cfg.max);
                lastAdc[i] = adc;
            }
        }
    }

    refreshHzLabels();
    pushScopeFromFrequencies();
    vizP5?.redraw();
}

function mountP5(host) {
    const P = window.p5;
    vizP5 = new P((p) => {
        p.setup = () => {
            p.createCanvas(Math.max(290, host.clientWidth || 320), 230).parent(host);
            p.noLoop();
        };
        p.draw = () => {
            p.background(6, 10, 24);
            const pad = 10;
            const w = p.width - pad * 2;
            const h = p.height - pad * 2;
            p.stroke(51, 65, 85, 120);
            for (let i = 0; i <= 4; i++) {
                const gy = pad + (i * h) / 4;
                p.line(pad, gy, pad + w, gy);
            }

            const n = SCOPE_POINTS;
            for (let ci = 0; ci < 5; ci++) {
                const [r, g, b] = COLOR_RGB[ci];
                p.stroke(r, g, b, 210);
                p.strokeWeight(1.8);
                p.noFill();
                p.beginShape();
                for (let k = 0; k < n; k++) {
                    const idx = (scopeWrite + k) % n;
                    const x = pad + (k / (n - 1)) * w;
                    const y = pad + h * 0.5 - scopeRows[ci][idx] * h * 0.4;
                    p.vertex(x, y);
                }
                p.endShape();
            }
        };
    }, host);
}

function refreshToggleVisual() {
    for (let i = 0; i < 5; i++) {
        const btn = rootEl?.querySelector(`[data-omx-ch="${i}"]`);
        if (!btn) continue;
        const on = channelOn[i];
        btn.classList.toggle('omx-toggle--on', on);
        btn.classList.toggle('omx-toggle--off', !on);
    }
}

function wireUi() {
    for (let i = 0; i < 5; i++) {
        rootEl?.querySelector(`[data-omx-ch="${i}"]`)?.addEventListener('click', async () => {
            await resumeAudio();
            channelOn[i] = !channelOn[i];
            refreshToggleVisual();
            updateVoiceGainsWithAdsr();
        });
    }

    rootEl?.querySelector('#omx-enable')?.addEventListener('click', () => resumeAudio().catch(console.warn));
    rootEl?.querySelector('#omx-style')?.addEventListener('change', () => {
        refreshCustomInputs();
        applyOscTypeFromStyle();
        vizP5?.redraw();
    });
    rootEl?.querySelector('#omx-fmin')?.addEventListener('input', () => vizP5?.redraw());
    rootEl?.querySelector('#omx-fmax')?.addEventListener('input', () => vizP5?.redraw());
    rootEl?.querySelector('#omx-volume')?.addEventListener('input', (e) => {
        const v = Number(e.target?.value);
        volumeValue = Number.isFinite(v) ? v : 0.42;
        const label = rootEl?.querySelector('#omx-volume-label');
        if (label) label.textContent = `${Math.round(volumeValue * 100)}%`;
        applyMasterGain();
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
    if (si) si.innerText = '⚡ Omni混音機：GPIO 1–5 感測輸入';
}

function buildDom(root) {
    const toggles = CHANS.map(
        (_, idx) => `
<button type="button" class="omx-toggle omx-toggle--on" data-omx-ch="${idx}">
  <span class="omx-toggle-title">GPIO ${idx + 1}</span>
  <span class="omx-toggle-hz" id="omx-hz-${idx}">220 Hz</span>
</button>`
    ).join('');

    root.innerHTML = `
<div class="omx-root">
  <div class="omx-hero">
    <div class="omx-title">Omni混音機</div>
    <p class="omx-sub">五軌即時感測合成器 · 多音同時輸出 · 教室友善音色</p>
  </div>

  <div class="omx-grid">
    <div class="omx-card">
      <h3>音色與混音</h3>
      <div class="omx-row">
        <label for="omx-style">音色風格</label>
        <select id="omx-style" class="omx-select">
          <option value="elegant">優美（220–660 Hz）</option>
          <option value="magical">魔幻（880–3500 Hz）</option>
          <option value="custom">自訂</option>
        </select>
      </div>

      <div id="omx-custom-wrap" class="omx-custom hidden">
        <div class="omx-row">
          <label for="omx-fmin">下限頻率 (Hz)</label>
          <input id="omx-fmin" class="omx-input" type="number" value="220" min="20" step="1" />
        </div>
        <div class="omx-row">
          <label for="omx-fmax">上限頻率 (Hz)</label>
          <input id="omx-fmax" class="omx-input" type="number" value="1200" min="21" step="1" />
        </div>
      </div>

      <div class="omx-row">
        <label for="omx-volume">主音量</label>
        <div class="omx-volume">
          <input id="omx-volume" type="range" min="0" max="1" step="0.02" value="${volumeValue}" />
          <span id="omx-volume-label">${Math.round(volumeValue * 100)}%</span>
        </div>
      </div>

      <div class="omx-toggles">${toggles}</div>
      <button id="omx-enable" type="button" class="omx-enable">點擊啟用音訊（瀏覽器限制）</button>
      <p class="omx-hint">已加入 50ms 攻擊/釋放包絡與 Noise Gate，減少切換爆音與感測抖動飄音。</p>
    </div>

    <div class="omx-card">
      <h3>示波器（五軌重疊）</h3>
      <div id="omx-canvas" class="omx-viz"></div>
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
    refreshCustomInputs();
    refreshToggleVisual();
    refreshHzLabels();
    await loadP5();
    const host = root.querySelector('#omx-canvas');
    if (host) mountP5(host);
    dataHandler = (ev) => onData(ev);
    window.addEventListener('omnisense:data', dataHandler);
}

export async function onConnected() {
    await applyPreset();
}

async function teardown() {
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
    isAudioReady = false;

    if (rootEl) {
        rootEl.innerHTML = '';
        rootEl = null;
    }
}

export async function cleanup() {
    await teardown();
}

export async function unmount() {
    await cleanup();
}
