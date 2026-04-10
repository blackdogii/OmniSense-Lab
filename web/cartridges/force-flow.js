/**
 * ForceFlow 3.8: 專業水果大戰 (圖片路徑修正版)
 * 資源路徑：./force-flow-assets/
 */

// --- 資源路徑自動解析 ---
const SCRIPT_URL = import.meta.url;
const ASSETS_BASE = SCRIPT_URL.substring(0, SCRIPT_URL.lastIndexOf('/')) + '/force-flow-assets/';

const ASSET_FILES = {
    bg: ASSETS_BASE + 'bg.png',               // 
    apple: ASSETS_BASE + 'note-light.png',    // 修正為 png
    watermelon: ASSETS_BASE + 'note-heavy.png',// 修正為 png
    appleSplat: ASSETS_BASE + 'note-light-splat.png',   // 分別對應蘋果爆炸圖
    watermelonSplat: ASSETS_BASE + 'note-heavy-splat.png' // 分別對應西瓜爆炸圖
};

const images = {};
let assetsLoaded = false;

// --- 遊戲狀態 ---
let gameState = 'INTRO'; 
let minRaw = 4095, maxRaw = 0;
let currentPressureRaw = 0;
let normalizedPressure = 0;
const notes = [];
const particles = [];
let score = 0, combo = 0;
let lastJudgment = "";
let shakeIntensity = 0;
let animationId = 0;
/** @type {AudioContext | null} */
let audioCtx = null;
let ffResize = null;
let ffOnData = null;
let ffRoot = null;

// --- 硬體配置 ---
let selectedAdcId = 2; // 預設 GPIO 2

export async function mount(root) {
    ffRoot = root;
    // 1. 預載圖片
    await loadAllAssets();

    // 2. 建立 UI
    root.innerHTML = `
        <div id="ff-root" style="position:absolute; inset:0; background:#0f172a; color:white; font-family:sans-serif; overflow:hidden; user-select:none;">
            <canvas id="ff-canvas" style="display:block; width:100%; height:100%;"></canvas>
            
            <div id="ff-hud" style="position:absolute; top:20px; left:20px; right:20px; display:flex; justify-content:space-between; pointer-events:none;">
                <div style="font-size:1.5rem; font-weight:800;">SCORE: <span id="ff-score">0</span></div>
                <div style="font-size:1.5rem; font-weight:800;">COMBO: <span id="ff-combo">0</span></div>
            </div>

            <div id="ff-overlay" style="position:absolute; inset:0; background:rgba(15,23,42,0.95); display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; z-index:20;">
                <h1 style="color:#facc15; font-size:2.5rem; margin-bottom:10px;">水果大戰 3.8</h1>
                <p id="ff-msg" style="color:#cbd5e1; margin-bottom:20px;">請確保感測器接在 GPIO 2<br>按下按鈕後有 5 秒時間：<br><b>「先完全放開，再用力壓到底」</b></p>
                <div id="ff-timer" style="font-size:4rem; color:#facc15; font-weight:800; margin-bottom:20px;"></div>
                <button id="ff-btn" style="padding:15px 45px; font-size:1.2rem; background:#4ecca3; border:none; border-radius:35px; cursor:pointer; font-weight:bold; color:#0f172a;">開始 5 秒自動校準</button>
            </div>
        </div>
    `;

    const canvas = root.querySelector('#ff-canvas');
    const ctx = canvas.getContext('2d');
    const btn = root.querySelector('#ff-btn');
    const timerEl = root.querySelector('#ff-timer');
    const msg = root.querySelector('#ff-msg');

    const resize = () => {
        canvas.width = root.clientWidth;
        canvas.height = root.clientHeight;
    };
    ffResize = resize;
    window.addEventListener('resize', resize);
    resize();

    // 3. 監聽 OmniSense 數據
    const onData = (ev) => {
        const ch = ev.detail.channels[selectedAdcId];
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
    ffOnData = onData;
    window.addEventListener('omnisense:data', onData);
    window.__ffDataHandler = onData;

    // 4. 校準邏輯
    btn.onclick = () => {
        gameState = 'CALIBRATING';
        btn.style.display = 'none';
        minRaw = 4095; maxRaw = 0;
        let count = 5;
        timerEl.innerText = count + "s";
        
        const timer = setInterval(() => {
            count--;
            timerEl.innerText = count + "s";
            if (count <= 0) {
                clearInterval(timer);
                if (maxRaw - minRaw > 250) {
                    gameState = 'PLAYING';
                    root.querySelector('#ff-overlay').style.display = 'none';
                    startAudio();
                } else {
                    gameState = 'INTRO';
                    msg.innerHTML = "<b style='color:#f87171'>校準失敗</b><br>數值變化不足，請確認 GPIO 2 接線並重試";
                    btn.style.display = 'block';
                    btn.innerText = "重試校準";
                    timerEl.innerText = "";
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

async function loadAllAssets() {
    const load = (src) => new Promise((res) => {
        const img = new Image();
        img.crossOrigin = "anonymous"; 
        img.src = src;
        img.onload = () => res(img);
        img.onerror = () => {
            console.warn("Failed to load:", src);
            res(null); // 失敗也繼續，避免卡死
        };
    });
    
    images.bg = await load(ASSET_FILES.bg);
    images.apple = await load(ASSET_FILES.apple);
    images.watermelon = await load(ASSET_FILES.watermelon);
    images.appleSplat = await load(ASSET_FILES.appleSplat);       // 載入蘋果碎裂圖
    images.watermelonSplat = await load(ASSET_FILES.watermelonSplat); // 載入西瓜碎裂圖
    assetsLoaded = true;
}

function update(canvas) {
    if (gameState !== 'PLAYING') return;

    if (shakeIntensity > 0) shakeIntensity *= 0.9;

    // 產生水果
    if (Math.random() < 0.02) {
        notes.push({
            x: canvas.width / 2,
            y: -50,
            type: Math.random() > 0.4 ? 'APPLE' : 'WATERMELON',
            state: 'FALLING', 
            vx: 0, vy: 5, rot: 0
        });
    }

    const judgeY = canvas.height * 0.85;

    for (let i = notes.length - 1; i >= 0; i--) {
        const n = notes[i];
        
        if (n.state === 'FALLING') {
            n.y += n.vy;
            // 判定窗 (時機正確)
            if (Math.abs(n.y - judgeY) < 35) {
                const isHeavy = n.type === 'WATERMELON';
                const targetMin = isHeavy ? 0.75 : 0.25;
                const targetMax = isHeavy ? 1.1 : 0.65;

                if (normalizedPressure >= targetMin && normalizedPressure <= targetMax) {
                    // 【射爆】時機對 + 壓力對
                    n.state = 'EXPLODED';
                    n.timer = 15; // 顯示噴濺圖的幀數
                    score += isHeavy ? 200 : 100;
                    combo++;
                    shakeIntensity = isHeavy ? 15 : 6;
                    createParticles(n.x, n.y, isHeavy ? '#10b981' : '#f43f5e');
                    playHitSound(isHeavy ? 250 : 500);
                } else if (normalizedPressure > 0.08) {
                    // 【彈開】時機對 + 壓力不對
                    n.state = 'BOUNCING';
                    n.vx = (Math.random() - 0.5) * 12;
                    n.vy = -10; 
                    combo = 0;
                    playHitSound(150); // 低沈的彈開聲
                }
            }
        } else if (n.state === 'BOUNCING') {
            n.x += n.vx;
            n.y += n.vy;
            n.vy += 0.4; // 重力
            n.rot += 0.1;
        } else if (n.state === 'EXPLODED') {
            n.timer--;
            if (n.timer <= 0) notes.splice(i, 1);
            continue;
        }

        // 移除出界音符
        if (n.y > canvas.height + 100 || n.y < -300) {
            if (n.state === 'FALLING') combo = 0;
            notes.splice(i, 1);
        }
    }

    // 粒子更新
    for (let i = particles.length - 1; i >= 0; i--) {
        particles[i].update();
        if (particles[i].life <= 0) particles.splice(i, 1);
    }
}

function draw(ctx, canvas) {
    ctx.save();
    if (shakeIntensity > 1) {
        ctx.translate(Math.random()*shakeIntensity - shakeIntensity/2, Math.random()*shakeIntensity - shakeIntensity/2);
    }

    // 背景
    if (images.bg) {
        ctx.drawImage(images.bg, 0, 0, canvas.width, canvas.height);
    } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    const judgeY = canvas.height * 0.85;

    // 判定線
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 10]);
    ctx.strokeRect(canvas.width/2 - 60, judgeY - 25, 120, 50);
    ctx.setLineDash([]);

    // 壓力條
    drawPressureBar(ctx, canvas, judgeY);

    // 水果繪製
    notes.forEach(n => {
        const img = n.type === 'APPLE' ? images.apple : images.watermelon;
        const splatImg = n.type === 'APPLE' ? images.appleSplat : images.watermelonSplat; // 判定碎裂圖類型
        const size = n.type === 'APPLE' ? 60 : 100;

        if (n.state === 'EXPLODED') {
            if (splatImg) {
                ctx.globalAlpha = n.timer / 15;
                ctx.drawImage(splatImg, n.x - size, n.y - size, size * 2, size * 2);
                ctx.globalAlpha = 1;
            }
        } else {
            ctx.save();
            ctx.translate(n.x, n.y);
            if (n.state === 'BOUNCING') ctx.rotate(n.rot);
            if (img) {
                ctx.drawImage(img, -size/2, -size/2, size, size);
            } else {
                // 備援圖形
                ctx.fillStyle = n.type === 'APPLE' ? 'red' : 'green';
                ctx.beginPath(); ctx.arc(0,0,size/2,0,Math.PI*2); ctx.fill();
            }
            ctx.restore();
        }
    });

    particles.forEach(p => p.draw(ctx));
    ctx.restore();

    document.getElementById('ff-score').innerText = score;
    document.getElementById('ff-combo').innerText = combo;
}

function drawPressureBar(ctx, canvas, judgeY) {
    const barW = 30, barH = 200;
    const x = canvas.width - 50, y = judgeY - barH;
    
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(x, y, barW, barH);
    
    // 目標區間標示
    ctx.fillStyle = 'rgba(244, 63, 94, 0.3)'; // Apple Zone
    ctx.fillRect(x, y + barH*(1-0.65), barW, barH*0.4);
    ctx.fillStyle = 'rgba(16, 185, 129, 0.3)'; // Watermelon Zone
    ctx.fillRect(x, y, barW, barH*0.2);

    const fillH = normalizedPressure * barH;
    ctx.fillStyle = '#facc15';
    ctx.fillRect(x, y + barH - fillH, barW, fillH);
}

// --- 特效與音效 ---
class Particle {
    constructor(x, y, color) {
        this.x = x; this.y = y; this.color = color;
        this.vx = (Math.random() - 0.5) * 15;
        this.vy = (Math.random() - 0.5) * 15;
        this.life = 1.0;
    }
    update() { this.x += this.vx; this.y += this.vy; this.vy += 0.6; this.life -= 0.03; }
    draw(ctx) {
        ctx.globalAlpha = this.life;
        ctx.fillStyle = this.color;
        ctx.beginPath(); ctx.arc(this.x, this.y, 4, 0, Math.PI*2); ctx.fill();
        ctx.globalAlpha = 1;
    }
}
function createParticles(x, y, color) {
    for (let i = 0; i < 20; i++) {
        particles.push(new Particle(x, y, color));
    }
}

function getAudioContext() {
    if (!audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) audioCtx = new Ctx();
    }
    return audioCtx;
}

function startAudio() {
    try {
        const ctx = getAudioContext();
        ctx?.resume?.();
    } catch {
        /* 略 */
    }
}

function playHitSound(freq) {
    try {
        const ctx = getAudioContext();
        if (!ctx) return;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        o.connect(g);
        g.connect(ctx.destination);
        const t = ctx.currentTime;
        g.gain.setValueAtTime(0.12, t);
        g.gain.exponentialRampToValueAtTime(0.01, t + 0.1);
        o.start(t);
        o.stop(t + 0.12);
    } catch {
        /* 略 */
    }
}

export async function unmount() {
    if (ffResize) {
        window.removeEventListener('resize', ffResize);
        ffResize = null;
    }
    if (ffOnData) {
        window.removeEventListener('omnisense:data', ffOnData);
        ffOnData = null;
    }
    try {
        delete window.__ffDataHandler;
    } catch {
        window.__ffDataHandler = undefined;
    }
    cancelAnimationFrame(animationId);
    animationId = 0;
    try {
        await audioCtx?.close();
    } catch {
        /* 略 */
    }
    audioCtx = null;
    if (ffRoot) {
        ffRoot.innerHTML = '';
        ffRoot = null;
    }
    notes.length = 0;
    particles.length = 0;
}