/**
 * ForceFlow 2.0: 壓力感測節奏遊戲 (進階校準版)
 */

// --- 遊戲常數 ---
const JUDGE_LINE_Y_RATIO = 0.85;
const NOTE_SPEED = 5;
const COLORS = {
    bg: '#0f172a',
    light: '#4ecca3',
    heavy: '#ff4b2b',
    judge: '#94a3b8',
    perfect: '#fbbf24',
    miss: '#ef4444'
};

// --- 狀態管理 ---
let gameState = 'CALIBRATING'; // CALIBRATING, PLAYING
let calibStep = 0; // 0: 靜止, 1: 重壓
let minRaw = 4095, maxRaw = 0;
let calibTimer = 0;

let animationId = null;
let audioCtx = null;
let currentPressureRaw = 0;
let normalizedPressure = 0; // 0.0 ~ 1.0
const notes = [];
const particles = [];
let score = 0;
let combo = 0;
let lastJudgment = "";
let shakeIntensity = 0;

let selectedAdcId = 2; // 預設 GPIO 2

export async function mount(root) {
    // 1. 全螢幕 UI 建立
    root.innerHTML = `
        <div id="ff-root" style="position:absolute; inset:0; background:${COLORS.bg}; color:white; font-family:system-ui, sans-serif; overflow:hidden; user-select:none;">
            <canvas id="ff-canvas" style="display:block; width:100%; height:100%;"></canvas>
            
            <div id="ff-hud" style="position:absolute; top:20px; left:20px; right:20px; display:flex; justify-content:space-between; pointer-events:none;">
                <div style="font-size:1.5rem; font-weight:800; text-shadow:0 2px 4px rgba(0,0,0,0.5);">SCORE: <span id="ff-score">0</span></div>
                <div style="font-size:1.5rem; font-weight:800; text-shadow:0 2px 4px rgba(0,0,0,0.5);">COMBO: <span id="ff-combo">0</span></div>
            </div>

            <div id="ff-overlay" style="position:absolute; inset:0; background:rgba(15, 23, 42, 0.9); display:flex; flex-direction:column; align-items:center; justify-content:center; z-index:10;">
                <h1 style="margin-bottom:10px; color:${COLORS.heavy}">ForceFlow 2.0</h1>
                <p id="ff-msg" style="margin-bottom:30px; text-align:center; color:#cbd5e1; padding:0 20px;">準備進行硬體校準</p>
                <button id="ff-btn" style="padding:12px 30px; font-size:1.2rem; background:${COLORS.light}; border:none; border-radius:30px; color:#1a1a2e; font-weight:bold; cursor:pointer;">開始校準 (請放開按鈕)</button>
                <div style="margin-top:20px;">
                    <select id="ff-ch-select" style="background:#1e293b; color:white; border:1px solid #475569; padding:5px 10px; border-radius:5px;">
                        <option value="0">GPIO 0</option><option value="1">GPIO 1</option><option value="2" selected>GPIO 2</option>
                        <option value="3">GPIO 3</option><option value="4">GPIO 4</option>
                    </select>
                </div>
            </div>
        </div>
    `;

    const canvas = root.querySelector('#ff-canvas');
    const ctx = canvas.getContext('2d');
    const overlay = root.querySelector('#ff-overlay');
    const msg = root.querySelector('#ff-msg');
    const btn = root.querySelector('#ff-btn');
    const chSelect = root.querySelector('#ff-ch-select');

    // 2. 視窗調整
    const resize = () => {
        canvas.width = root.clientWidth;
        canvas.height = root.clientHeight;
    };
    window.addEventListener('resize', resize);
    resize();

    // 3. 資料監聽
    const onData = (ev) => {
        const ch = ev.detail.channels[selectedAdcId];
        if (ch) {
            currentPressureRaw = ch.filtered;
            // 根據校準值計算正規化壓力 (0~1)
            if (gameState === 'PLAYING') {
                normalizedPressure = Math.max(0, Math.min(1, (currentPressureRaw - minRaw) / (maxRaw - minRaw)));
            }
        }
    };
    window.addEventListener('omnisense:data', onData);
    window.__ffDataHandler = onData;

    // 4. 校準邏輯
    btn.onclick = () => {
        if (calibStep === 0) {
            // 步驟一：抓取底噪
            btn.style.display = 'none';
            msg.innerText = "正在讀取靜止數值，請勿觸碰...";
            setTimeout(() => {
                minRaw = currentPressureRaw;
                calibStep = 1;
                msg.innerHTML = "底噪已讀取！<br><br>現在，請用力壓住感測器並保持住";
                btn.style.display = 'block';
                btn.innerText = "我正用力壓著，設定最大值";
            }, 1500);
        } else if (calibStep === 1) {
            // 步驟二：抓取最大值
            maxRaw = currentPressureRaw;
            if (Math.abs(maxRaw - minRaw) < 200) {
                msg.innerText = "誤差過小，請確認接線或用力按壓後重試";
                calibStep = 0;
                btn.innerText = "重試校準";
                return;
            }
            gameState = 'PLAYING';
            overlay.style.display = 'none';
            startAudio();
        }
    };

    chSelect.onchange = (e) => selectedAdcId = parseInt(e.target.value);

    // 5. 繪圖與更新
    const gameLoop = () => {
        update(canvas);
        render(canvas, ctx);
        animationId = requestAnimationFrame(gameLoop);
    };
    gameLoop();
}

function update(canvas) {
    if (gameState !== 'PLAYING') return;

    // 震動衰減
    if (shakeIntensity > 0) shakeIntensity *= 0.9;

    // 隨機產生音符
    if (Math.random() < 0.02) {
        notes.push({
            x: canvas.width / 2,
            y: -50,
            type: Math.random() > 0.3 ? 'LIGHT' : 'HEAVY', // LIGHT: 0.3~0.6, HEAVY: 0.8~1.0
            hit: false
        });
    }

    const judgeY = canvas.height * JUDGE_LINE_Y_RATIO;

    for (let i = notes.length - 1; i >= 0; i--) {
        const n = notes[i];
        n.y += NOTE_SPEED;

        // 判定邏輯
        if (!n.hit && Math.abs(n.y - judgeY) < 30) {
            let success = false;
            if (n.type === 'LIGHT' && normalizedPressure > 0.25 && normalizedPressure < 0.65) success = true;
            if (n.type === 'HEAVY' && normalizedPressure > 0.8) success = true;

            if (success) {
                n.hit = true;
                score += (n.type === 'HEAVY' ? 200 : 100);
                combo++;
                lastJudgment = "PERFECT!";
                shakeIntensity = n.type === 'HEAVY' ? 10 : 3;
                createParticles(n.x, judgeY, n.type === 'HEAVY' ? COLORS.heavy : COLORS.light);
                playHitSound(n.type === 'HEAVY' ? 300 : 600);
            }
        }

        // Miss 判定
        if (n.y > judgeY + 50 && !n.hit) {
            n.hit = true; // 標記為處理過
            combo = 0;
            lastJudgment = "MISS";
            setTimeout(() => lastJudgment = "", 500);
        }

        if (n.y > canvas.height + 50) notes.splice(i, 1);
    }

    // 更新粒子
    for (let i = particles.length - 1; i >= 0; i--) {
        particles[i].update();
        if (particles[i].life <= 0) particles.splice(i, 1);
    }
}

function render(canvas, ctx) {
    ctx.save();
    
    // 畫面震動
    if (shakeIntensity > 0) {
        ctx.translate(Math.random() * shakeIntensity - shakeIntensity/2, Math.random() * shakeIntensity - shakeIntensity/2);
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const judgeY = canvas.height * JUDGE_LINE_Y_RATIO;

    // 1. 繪製判定線
    ctx.strokeStyle = COLORS.judge;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(canvas.width * 0.2, judgeY);
    ctx.lineTo(canvas.width * 0.8, judgeY);
    ctx.stroke();

    // 2. 繪製壓力長條 (打擊感核心)
    const barWidth = 40;
    const barHeight = 250;
    const barX = canvas.width - 60;
    const barY = judgeY - barHeight;
    
    // 背景
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(barX, barY, barWidth, barHeight);
    
    // 繪製目標區間 (視覺提示)
    ctx.fillStyle = 'rgba(78, 204, 163, 0.3)'; // Light 區間
    ctx.fillRect(barX, barY + barHeight * (1-0.65), barWidth, barHeight * (0.65-0.25));
    ctx.fillStyle = 'rgba(255, 75, 43, 0.3)'; // Heavy 區間
    ctx.fillRect(barX, barY, barWidth, barHeight * 0.2);

    // 當前壓力
    const pHeight = normalizedPressure * barHeight;
    const grad = ctx.createLinearGradient(0, barY + barHeight, 0, barY);
    grad.addColorStop(0, COLORS.light);
    grad.addColorStop(1, COLORS.heavy);
    ctx.fillStyle = grad;
    ctx.fillRect(barX, barY + barHeight - pHeight, barWidth, pHeight);

    // 3. 繪製音符
    notes.forEach(n => {
        if (n.hit) return;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.type === 'HEAVY' ? 30 : 18, 0, Math.PI*2);
        ctx.fillStyle = n.type === 'HEAVY' ? COLORS.heavy : COLORS.light;
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.stroke();
    });

    // 4. 繪製粒子
    particles.forEach(p => p.draw(ctx));

    // 5. 繪製判定文字
    if (lastJudgment) {
        ctx.font = "bold 40px system-ui";
        ctx.fillStyle = lastJudgment === "PERFECT!" ? COLORS.perfect : COLORS.miss;
        ctx.textAlign = "center";
        ctx.fillText(lastJudgment, canvas.width/2, judgeY - 100);
    }

    ctx.restore();

    // 更新 HUD
    const sEl = document.getElementById('ff-score');
    const cEl = document.getElementById('ff-combo');
    if (sEl) sEl.innerText = score;
    if (cEl) cEl.innerText = combo;
}

// --- 特效輔助 ---
class Particle {
    constructor(x, y, color) {
        this.x = x; this.y = y; this.color = color;
        this.vx = (Math.random() - 0.5) * 10;
        this.vy = (Math.random() - 0.5) * 10;
        this.life = 1.0;
    }
    update() { this.x += this.vx; this.y += this.vy; this.life -= 0.05; }
    draw(ctx) {
        ctx.globalAlpha = this.life;
        ctx.fillStyle = this.color;
        ctx.fillRect(this.x, this.y, 4, 4);
        ctx.globalAlpha = 1.0;
    }
}

function createParticles(x, y, color) {
    for (let i=0; i<15; i++) particles.push(new Particle(x, y, color));
}

function startAudio() {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

function playHitSound(freq) {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.connect(g); g.connect(audioCtx.destination);
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.2, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
    osc.start(); osc.stop(audioCtx.currentTime + 0.1);
}

export async function cleanup() {
    if (animationId) cancelAnimationFrame(animationId);
    window.removeEventListener('omnisense:data', window.__ffDataHandler);
    if (audioCtx) audioCtx.close();
    console.log("ForceFlow 2.0 Cleanup");
}