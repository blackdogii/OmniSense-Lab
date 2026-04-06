import { writeConfig } from './ble.js';

/**
 * @param {{ freq: number, res: number, activeMask: number, pullupMask: number, touchMask: number }} p
 */
export async function applyDeviceConfig(p) {
    const buf = new Uint8Array([
        0x01,
        (p.activeMask >> 8) & 0xff,
        p.activeMask & 0xff,
        (p.pullupMask >> 8) & 0xff,
        p.pullupMask & 0xff,
        (p.freq >> 8) & 0xff,
        p.freq & 0xff,
        p.res & 0xff,
        (p.touchMask >> 8) & 0xff,
        p.touchMask & 0xff
    ]);
    await writeConfig(buf);
}
