/**
 * Web Bluetooth：連線、通知、下行寫入（實驗模組不直接持有特徵值，由 core 代理）
 */

export const SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
export const TX_UUID = '0000ffe1-0000-1000-8000-00805f9b34fb';
export const RX_UUID = '0000ffe2-0000-1000-8000-00805f9b34fb';

/** @type {BluetoothDevice | null} */
let device = null;
/** @type {BluetoothRemoteGATTCharacteristic | null} */
let txChar = null;
/** @type {BluetoothRemoteGATTCharacteristic | null} */
let rxChar = null;

/** @param {(copy: Uint8Array) => void} onNotificationPacket */
export async function connectBle(onNotificationPacket) {
    const ble = navigator.bluetooth;
    if (!ble) throw new Error('此瀏覽器不支援 Web Bluetooth');

    device = await ble.requestDevice({
        filters: [{ services: [SERVICE_UUID] }]
    });
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    txChar = await service.getCharacteristic(TX_UUID);
    rxChar = await service.getCharacteristic(RX_UUID);

    device.addEventListener('gattserverdisconnected', () => {
        disconnectBle();
        window.dispatchEvent(new CustomEvent('omnisense:ble-disconnected'));
    });

    await txChar.startNotifications();
    txChar.addEventListener('characteristicvaluechanged', (e) => {
        const v = e.target.value;
        if (!v || v.byteLength < 8) return;
        const copy = new Uint8Array(v.byteLength);
        copy.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        onNotificationPacket(copy);
    });

    return { device, txChar, rxChar };
}

export function disconnectBle() {
    try {
        if (device && device.gatt.connected) device.gatt.disconnect();
    } catch (_) {}
    device = null;
    txChar = null;
    rxChar = null;
}

export function isConnected() {
    return !!(device && device.gatt && device.gatt.connected);
}

export function getRxChar() {
    return rxChar;
}

/** @param {Uint8Array} buf */
export async function writeConfig(buf) {
    if (!rxChar) throw new Error('未連線');
    await rxChar.writeValue(buf);
}
