/**
 * ForceFlow 3.9: 終極水果大戰 (合併優化版)
 * 特色：5s 自動校準、物理彈開機制、專屬碎裂特效、打擊文字反饋
 */

// --- 資源路徑自動解析 ---
const SCRIPT_URL = import.meta.url;
const ASSETS_BASE = SCRIPT_URL.substring(0, SCRIPT_URL.lastIndexOf('/')) + '/force-flow-assets/';

const ASSET_FILES = {
    bg: ASSETS_BASE + 'bg.png',
    apple: ASSETS_BASE + 'note-light.png',
    watermelon: ASSETS_BASE + 'note-heavy.png',
    appleSplat: ASSETS_BASE + 'note-light-splat.png',
    watermelonSplat: ASSETS_BASE + 'note-heavy-splat.png'
};

const images = {};
let assetsLoaded = false;

// --- 遊戲狀態與參數 ---
let gameState = 'INTRO'; // INTRO, CALIBRATING, PLAYING
let minRaw = 4095, maxRaw = 0;
let currentPressureRaw = 0;
let normalizedPressure = 0;
const notes = [];
const particles = [];
const labels = []; // 存放 "Perfect", "Miss" 等文字標籤
let score = 0, combo = 0;
let shakeIntensity = 0;
let animationId = 0;
let audioCtx = null;
let ffResize = null, ffOnData = null, ffRoot = null;

const SELECTED_ADC_ID = 2; // 預設使用 GPIO 2

// --- 核心入口 ---
export async function mount(root) {
    ffRoot = root;
    await loadAllAssets();

    root.innerHTML = `
        <div id="ff-root" style="position:absolute; inset:0; background:#0f172a; color:white; font-family:sans-serif; overflow:hidden; user-select:none;">
            <canvas id="ff-canvas" style="display:block; width:100%; height:100%;"></canvas>
            
            <div id="ff-hud" style="position:absolute; top:20px; left:20px; right:20px; display:flex; justify-content:space-between; pointer-events:none; z-index:5;">
                <div style="font-size:1.8rem; font-weight:900; color:#facc15; text-shadow:2px 2px 4px #000;">SCORE: <span id="ff-score">0</span></div>
                <div style="font-size:1.8rem; font-weight:900; color:#facc15; text-shadow:2px 2px 4px #000;">COMBO: <span id="ff-combo">0</span></div>
            </div>

            <div id="ff-overlay" style="position:absolute; inset:0; background:rgba(15,23,42,0.9); display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; z-index:20;">
                <h1 style="color:#facc15; font-size:3rem; margin-bottom:10px;">ForceFlow 3.9</h1>
                <p id="ff-msg" style="color:#cbd5e1; font-size:1.2rem; line-height:1.6; margin-bottom:20px;">
                    請確保感測器接在 <b>GPIO 2</b><br>
                    校準開始後，有 5 秒時間：<br>
                    <span style="color:#4ecca3"><b>完全放開 → 用力壓到底</b></span>
                </p>
                <div id="ff-timer" style="font-size:5rem; color:#facc15; font-weight:900; margin-bottom:30px; height:80px;"></div>
                <button id="ff-btn" style="padding:15px 50px; font-size:1.4rem; background:#4ecca3; border:none; border-radius:40px; cursor:pointer; font-weight:bold; color:#0f172a; transition: transform 0.2s;">開始全自動校準</button>
            </div>
        </div>
    `;

    const canvas = root.querySelector('#ff-canvas');
    const ctx = canvas.getContext('2d');
    const btn = root.querySelector('#ff-btn');
    const timerEl = root.querySelector('#ff-timer');
    const msg = root.querySelector('#ff-msg');

    const resize = () => { canvas.width = root.clientWidth; canvas.height = root.clientHeight; };
    ffResize = resize;
    window.addEventListener('resize', resize);
    resize();

    // 數據接收
    ffOnData = (ev) => {
        const ch = ev.detail.channels[SELECTED_ADC_ID];
        if (ch) {
            currentPressureRaw = ch.filtered;
            if (gameState === 'CALIBRATING') {
                minRaw = Math.min(minRaw, currentPressureRaw);
                maxRaw = Math.max(maxRaw, currentPressureRaw);
            }
            if (gameState === 'PLAYING') {
                normalizedPressure = Math.max(0, Math.min(1, (currentPressureRaw - minRaw) / (maxRaw - minRaw)));
            }
        }
    };
    window.addEventListener('omnisense:data', ffOnData);

    btn.onclick = () => {
        gameState = 'CALIBRATING';
        btn.style.display = 'none';
        minRaw = 4095; maxRaw = 0;
        let count = 5;
        timerEl.innerText = count + "s";
        
        const timer = setInterval(() => {
            count--;
            timerEl.innerText = count > 0 ? count + "s" : "";
            if (count <= 0) {
                clearInterval(timer);
                if (maxRaw - minRaw > 300) { // 增加校準寬度閾值確保品質
                    gameState = 'PLAYING';
                    root.querySelector('#ff-overlay').style.display = 'none';
                    startAudio();
                } else {
                    gameState = 'INTRO';
                    msg.innerHTML = "<b style='color:#f87171; font-size:1.5rem;'>校準失敗！</b><br>數值變化太小，請確認接線並再次嘗試。";
                    btn.style.display = 'block';
                    btn.innerText = "重試校準";
                }
            }
        }, 1000);
    };

    const loop = () => {
        update(canvas);
        draw(ctx, canvas);
        animationId = requestAnimationFrame(loop);
    };
    loop();
}

// --- 邏輯更新 ---
function update(canvas) {
    if (gameState !== 'PLAYING') return;

    if (shakeIntensity > 0) shakeIntensity *= 0.85;

    // 隨機產生水果 (頻率稍微調整提高流暢感)
    if (Math.random() < 0.025) {
        notes.push({
            x: canvas.width / 2,
            y: -60,
            type: Math.random() > 0.4 ? 'APPLE' : 'WATERMELON',
            state: 'FALLING',
            vx: 0, vy: 4 + Math.random() * 2, rot: 0,
            seed: Math.random() // 用於彈開時的隨機方向
        });
    }

    const judgeY = canvas.height * 0.85;

    for (let i = notes.length - 1; i >= 0; i--) {
        const n = notes[i];
        
        if (n.state === 'FALLING') {
            n.y += n.vy;
            if (Math.abs(n.y - judgeY) < 40) {
                const isHeavy = n.type === 'WATERMELON';
                const tMin = isHeavy ? 0.70 : 0.20; // 稍微放寬判定寬度提高打擊爽度
                const tMax = isHeavy ? 1.05 : 0.65;

                if (normalizedPressure >= tMin && normalizedPressure <= tMax) {
                    n.state = 'EXPLODED';
                    n.timer = 18; // 碎裂圖持續時間
                    score += isHeavy ? 200 : 100;
                    combo++;
                    shakeIntensity = isHeavy ? 18 : 8;
                    createParticles(n.x, n.y, isHeavy ? '#4ade80' : '#f87171');
                    addLabel(n.x, n.y - 50, "PERFECT", "#facc15");
                    playHitSound(isHeavy ? 240 : 480);
                } else if (normalizedPressure > 0.1) {
                    n.state = 'BOUNCING';
                    n.vx = (n.seed - 0.5) * 15;
                    n.vy = -12; 
                    combo = 0;
                    addLabel(n.x, n.y - 50, "BAD PRESSURE", "#94a3b8");
                    playHitSound(120);
                }
            }
        } else if (n.state === 'BOUNCING') {
            n.x += n.vx; n.y += n.vy; n.vy += 0.5; n.rot += 0.15;
        } else if (n.state === 'EXPLODED') {
            n.timer--;
            if (n.timer <= 0) notes.splice(i, 1);
            continue;
        }

        if (n.y > canvas.height + 100 || n.y < -300) {
            if (n.state === 'FALLING') {
                combo = 0;
                addLabel(n.x, judgeY, "MISS", "#ef4444");
            }
            notes.splice(i, 1);
        }
    }

    // 更新粒子與文字標籤
    particles.forEach((p, i) => { p.update(); if (p.life <= 0) particles.splice(i, 1); });
    labels.forEach((l, i) => { l.y -= 1; l.life -= 0.02; if (l.life <= 0) labels.splice(i, 1); });
}

// --- 畫面繪製 ---
function draw(ctx, canvas) {
    ctx.save();
    if (shakeIntensity > 1) {
        ctx.translate((Math.random()-0.5)*shakeIntensity, (Math.random()-0.5)*shakeIntensity);
    }

    if (images.bg) ctx.drawImage(images.bg, 0, 0, canvas.width, canvas.height);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);

    const judgeY = canvas.height * 0.85;

    // 判定框
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 4;
    ctx.setLineDash([8, 8]);
    ctx.strokeRect(canvas.width/2 - 70, judgeY - 30, 140, 60);
    ctx.setLineDash([]);

    drawPressureBar(ctx, canvas, judgeY);

    notes.forEach(n => {
        const img = n.type === 'APPLE' ? images.apple : images.watermelon;
        const splat = n.type === 'APPLE' ? images.appleSplat : images.watermelonSplat;
        const size = n.type === 'APPLE' ? 70 : 110;

        if (n.state === 'EXPLODED' && splat) {
            ctx.globalAlpha = n.timer / 18;
            ctx.drawImage(splat, n.x - size, n.y - size, size * 2, size * 2);
            ctx.globalAlpha = 1;
        } else if (img) {
            ctx.save();
            ctx.translate(n.x, n.y);
            if (n.state === 'BOUNCING') ctx.rotate(n.rot);
            ctx.drawImage(img, -size/2, -size/2, size, size);
            ctx.restore();
        }
    });

    particles.forEach(p => p.draw(ctx));
    labels.forEach(l => {
        ctx.globalAlpha = l.life;
        ctx.fillStyle = l.color;
        ctx.font = `bold ${20 + l.life*10}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(l.text, l.x, l.y);
        ctx.globalAlpha = 1;
    });

    ctx.restore();
    document.getElementById('ff-score').innerText = score;
    document.getElementById('ff-combo').innerText = combo;
}

// --- 輔助功能 ---
function drawPressureBar(ctx, canvas, judgeY) {
    const w = 35, h = 250;
    const x = canvas.width - 60, y = judgeY - h;
    ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(244, 63, 94, 0.3)'; ctx.fillRect(x, y + h*0.35, w, h*0.4); // Apple Zone
    ctx.fillStyle = 'rgba(34, 197, 94, 0.3)'; ctx.fillRect(x, y, w, h*0.3); // Watermelon Zone
    ctx.fillStyle = '#facc15'; ctx.fillRect(x, y + h - (normalizedPressure * h), w, normalizedPressure * h);
    ctx.strokeStyle = '#fff'; ctx.strokeRect(x, y, w, h);
}

function addLabel(x, y, text, color) { labels.push({ x, y, text, color, life: 1.0 }); }

async function loadAllAssets() {
    const load = (src) => new Promise(res => {
        const img = new Image(); img.crossOrigin = "anonymous"; img.src = src;
        img.onload = () => res(img); img.onerror = () => res(null);
    });
    for (let k in ASSET_FILES) images[k] = await load(ASSET_FILES[k]);
    assetsLoaded = true;
}

class Particle {
    constructor(x, y, color) {
        this.x = x; this.y = y; this.color = color;
        this.vx = (Math.random()-0.5)*18; this.vy = (Math.random()-0.5)*18; this.life = 1.0;
    }
    update() { this.x += this.vx; this.y += this.vy; this.vy += 0.7; this.life -= 0.03; }
    draw(ctx) {
        ctx.globalAlpha = this.life; ctx.fillStyle = this.color;
        ctx.beginPath(); ctx.arc(this.x, this.y, 5, 0, Math.PI*2); ctx.fill();
        ctx.globalAlpha = 1;
    }
}
function createParticles(x, y, color) { for(let i=0; i<25; i++) particles.push(new Particle(x, y, color)); }

function startAudio() { 
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
}

function playHitSound(freq) {
    if (!audioCtx) return;
    const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.frequency.setValueAtTime(freq, audioCtx.currentTime);
    g.gain.setValueAtTime(0.15, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
    o.start(); o.stop(audioCtx.currentTime + 0.1);
}

export async function unmount() {
    window.removeEventListener('resize', ffResize);
    window.removeEventListener('omnisense:data', ffOnData);
    cancelAnimationFrame(animationId);
    await audioCtx?.close();
    if (ffRoot) ffRoot.innerHTML = '';
}