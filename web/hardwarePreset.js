/**
 * 由 projects.json / config.json 的 hardwarePreset 套用至 omni 並下發韌體。
 */
import { omni, PINS_CONFIG } from './core/state.js';
import { applyDeviceConfig } from './core/configApply.js';
import { computeTouchModeMask } from './core/touchMask.js';

/**
 * @param {{
 *   activeMask?: number,
 *   pullupMask?: number,
 *   freq?: number,
 *   res?: number,
 *   channelModes?: string[]
 * }} preset
 */
export async function applyHardwarePreset(preset) {
    if (preset.activeMask != null) omni.activeMask = preset.activeMask & 0x01ff;
    if (preset.pullupMask != null) omni.pullupMask = preset.pullupMask & 0x01ff;
    if (preset.freq != null) omni.lastFreq = Math.max(10, Math.min(200, preset.freq | 0));
    if (preset.res != null) omni.lastRes = Math.max(0, Math.min(2, preset.res | 0));
    if (Array.isArray(preset.channelModes) && preset.channelModes.length === 9) {
        omni.channelMode = preset.channelModes.map((m, i) => m || omni.channelMode[i]);
    } else {
        omni.channelMode = PINS_CONFIG.map((pc) => (pc.type === 'digital' ? 'dig' : 'adc'));
    }
    await applyDeviceConfig({
        freq: omni.lastFreq,
        res: omni.lastRes,
        activeMask: omni.activeMask,
        pullupMask: omni.pullupMask,
        touchMask: computeTouchModeMask()
    });
}
