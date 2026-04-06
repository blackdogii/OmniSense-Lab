/**
 * 魔法弓箭（插件實驗）：訂閱 omnisense:data，在此擴充蓄力／發射邏輯與動畫。
 */

import { omni, PINS_CONFIG } from '../../web/core/state.js';
import { applyDeviceConfig } from '../../web/core/configApply.js';
import { computeTouchModeMask } from '../../web/core/touchMask.js';
import * as ble from '../../web/core/ble.js';

const PRESET = { activeMask: 0x001f, pullupMask: 0x001f };

let rootEl = null;
let dataHandler = null;

async function applyPreset() {
    if (!ble.getRxChar()) return;
    omni.channelMode = PINS_CONFIG.map((pc) => (pc.type === 'digital' ? 'dig' : 'adc'));
    omni.activeMask = PRESET.activeMask & 0x01ff;
    omni.pullupMask = PRESET.pullupMask & 0x01ff;
    await applyDeviceConfig({
        freq: omni.lastFreq,
        res: omni.lastRes,
        activeMask: omni.activeMask,
        pullupMask: omni.pullupMask,
        touchMask: computeTouchModeMask()
    });
    const si = document.getElementById('syncIndicator');
    if (si) si.innerText = '⚡ 已套用弓箭實驗預設腳位';
}

export async function mount(root) {
    rootEl = root;
    omni.currentViewId = 'magic-bow';
    root.innerHTML = `
        <div class="glass-card p-8 md:p-12 rounded-[2rem] shadow-2xl text-center max-w-2xl mx-auto">
            <i data-lucide="target" class="w-14 h-14 mx-auto mb-4 text-emerald-500/80"></i>
            <h2 class="text-xl font-bold text-slate-100 mb-2">魔法弓箭</h2>
            <p class="text-slate-400 text-sm leading-relaxed">資料由 <code class="text-cyan-400/90 text-xs">omnisense:data</code> 事件送出；請於此檔擴充蓄力與動畫。</p>
            <p class="text-slate-500 text-xs mt-4">進入時會嘗試套用 ADC 0–4 等預設（需已連線）。</p>
        </div>`;
    if (window.lucide) window.lucide.createIcons();

    dataHandler = (ev) => {
        void ev.detail;
    };
    window.addEventListener('omnisense:data', dataHandler);
}

export async function onConnected() {
    if (typeof window !== 'undefined' && window.__omnisenseSkipExperimentDefaultPreset) return;
    await applyPreset();
}

export async function unmount() {
    if (dataHandler) {
        window.removeEventListener('omnisense:data', dataHandler);
        dataHandler = null;
    }
    if (rootEl) {
        rootEl.innerHTML = '';
        rootEl = null;
    }
}
