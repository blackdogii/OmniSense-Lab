import { omni } from './state.js';

export function computeTouchModeMask() {
    let m = 0;
    for (let i = 0; i < 9; i++) {
        if (omni.channelMode[i] === 'touch' && (omni.activeMask >> i) & 1) m |= 1 << i;
    }
    return m & 0xffff;
}

export function hasActiveTouchChannel() {
    return (computeTouchModeMask() & omni.activeMask & 0xffff) !== 0;
}
