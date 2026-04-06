/**
 * BLE 上行封包解析（與 firmware BitPacker 對齊）
 */

/**
 * @param {DataView} view
 * @returns {{ ts: number, mask: number, values: number[] } | null}
 */
export function unpack(view) {
    if (view.getUint8(0) !== 0xaa) return null;
    const mask = (view.getUint8(1) << 8) | view.getUint8(2);
    const res = view.getUint8(3);
    const ts = view.getUint32(4, true);
    const values = [];
    let pos = 8;
    let count = 0;
    for (let i = 0; i < 9; i++) if ((mask >> i) & 1) count++;

    if (res === 0) {
        for (let i = 0; i < count; i++) values.push(view.getUint8(pos++) << 4);
    } else if (res === 1) {
        for (let i = 0; i < count; i += 2) {
            const b1 = view.getUint8(pos++);
            const b2 = view.getUint8(pos++);
            const b3 = view.getUint8(pos++);
            values.push((b1 << 4) | (b2 >> 4));
            if (values.length < count) values.push(((b2 & 0x0f) << 8) | b3);
        }
    } else {
        for (let i = 0; i < count; i++) values.push((view.getUint8(pos++) << 8) | view.getUint8(pos++));
    }
    return { ts, mask, values };
}

export function u32Delta(a, b) {
    return (a - b + 0x100000000) % 0x100000000;
}
