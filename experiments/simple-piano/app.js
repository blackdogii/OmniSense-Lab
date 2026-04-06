/**
 * 七音階電子琴（插件實驗）：訂閱 omnisense:data，在此擴充琴鍵與音效。
 */

import { omni, PINS_CONFIG } from '../../web/core/state.js';
import { applyDeviceConfig } from '../../web/core/configApply.js';
import { computeTouchModeMask } from '../../web/core/touchMask.js';
import * as ble from '../../web/core/ble.js';

const PRESET = { activeMask: 0x7f, pullupMask: 0x7f };

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
    if (si) si.innerText = '⚡ 已套用電子琴預設腳位';
}

export async function mount(root) {
    rootEl = root;
    omni.currentViewId = 'simple-piano';
    root.innerHTML = `
        <div class="glass-card p-8 md:p-12 rounded-[2rem] shadow-2xl text-center max-w-2xl mx-auto">
            <i data-lucide="music" class="w-14 h-14 mx-auto mb-4 text-cyan-500/80"></i>
            <h2 class="text-xl font-bold text-slate-100 mb-2">七音階電子琴</h2>
            <p class="text-slate-400 text-sm leading-relaxed">資料由 <code class="text-cyan-400/90 text-xs">omnisense:data</code> 事件送出；請於此檔擴充琴鍵與音效。</p>
            <p class="text-slate-500 text-xs mt-4">進入時會嘗試套用預設腳位（需已連線）。</p>
        </div>`;
    if (window.lucide) window.lucide.createIcons();

    dataHandler = (ev) => {
        /* 範例：可讀取 ev.detail.channels */
        void ev.detail;
    };
    window.addEventListener('omnisense:data', dataHandler);
}

export async function onConnected() {
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
