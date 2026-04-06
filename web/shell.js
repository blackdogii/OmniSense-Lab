/**
 * App Shell：導覽、BLE 連線、動態載入實驗模組
 */

import { pushBlePacket, clearBleQueue, startEventLoop } from './core/events.js';
import * as ble from './core/ble.js';
import { omni } from './core/state.js';

let activeModule = null;
let activeId = null;
let cachedProjects = null;

async function getProjects() {
    if (cachedProjects) return cachedProjects;
    let r = await fetch(new URL('../projects.json', import.meta.url));
    if (!r.ok) r = await fetch(new URL('./projects.json', import.meta.url));
    if (!r.ok) throw new Error('projects.json 載入失敗');
    cachedProjects = await r.json();
    return cachedProjects;
}

function buildNav(projects, container, mobile) {
    container.innerHTML = '';
    projects.experiments.forEach((ex) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'nav-tab';
        b.dataset.experiment = ex.id;
        b.setAttribute('data-nav', '');
        const label = mobile ? ex.shortLabel : ex.label;
        b.innerHTML = `<i data-lucide="${ex.icon}" class="w-4 h-4"></i><span>${label}</span>`;
        if (ex.id === 'dashboard') b.classList.add('nav-tab-active');
        b.addEventListener('click', () => switchExperiment(ex.id));
        container.appendChild(b);
    });
    if (window.lucide) window.lucide.createIcons();
}

function setNavActive(id) {
    document.querySelectorAll('[data-nav]').forEach((btn) => {
        btn.classList.toggle('nav-tab-active', btn.dataset.experiment === id);
    });
}

async function switchExperiment(id) {
    if (id === activeId) return;
    const root = document.getElementById('experiment-root');
    if (!root) return;

    if (activeModule?.unmount) {
        try {
            await activeModule.unmount();
        } catch (e) {
            console.warn(e);
        }
    }

    activeModule = null;
    activeId = id;
    omni.currentViewId = id;
    setNavActive(id);

    const projects = await getProjects();
    const proj = projects.experiments.find((e) => e.id === id);
    const sub = document.getElementById('headerSubtitle');
    if (sub && proj) sub.textContent = proj.subtitle;

    const entryUrl = new URL(`../experiments/${id}/app.js`, import.meta.url);
    const mod = await import(entryUrl);
    activeModule = mod;
    if (mod.mount) await mod.mount(root);

    if (ble.isConnected() && mod.onConnected) {
        try {
            await mod.onConnected();
        } catch (e) {
            console.warn(e);
        }
    }
}

async function onConnectClick() {
    try {
        await ble.connectBle((copy) => pushBlePacket(copy));
        document.getElementById('connectBtn')?.classList.add('hidden');
        document.getElementById('disconnectBtn')?.classList.remove('hidden');
        const si = document.getElementById('syncIndicator');
        if (si) si.innerText = '✅ 裝置已就緒';
        if (activeModule?.onConnected) await activeModule.onConnected();
    } catch (e) {
        console.warn(e);
    }
}

function onDisconnectClick() {
    clearBleQueue();
    omni.packetHistory.length = 0;
    ble.disconnectBle();
    document.getElementById('connectBtn')?.classList.remove('hidden');
    document.getElementById('disconnectBtn')?.classList.add('hidden');
    const si = document.getElementById('syncIndicator');
    if (si) si.innerText = '已斷開藍牙';
}

async function init() {
    const projects = await getProjects();
    buildNav(projects, document.getElementById('navDesktop'), false);
    buildNav(projects, document.getElementById('navMobileInner'), true);

    document.getElementById('connectBtn')?.addEventListener('click', onConnectClick);
    document.getElementById('disconnectBtn')?.addEventListener('click', onDisconnectClick);
    window.addEventListener('omnisense:ble-disconnected', onDisconnectClick);

    if (window.lucide) window.lucide.createIcons();
    startEventLoop();
    await switchExperiment('dashboard');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init().catch(console.error));
} else {
    init().catch(console.error);
}
