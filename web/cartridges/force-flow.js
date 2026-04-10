/**
 * ForceFlow: 壓力感測節奏遊戲
 * OmniSense Lab 自訂卡帶 — 見 docs/CUSTOM_MODULE.md
 *
 * 邏輯通道：
 * - Channel 0: 壓力／類比輸入 (ADC 0–4095)
 */

let animationId = null;
let audioCtx = null;
let currentPressure = 0;
const notes = [];
let score = 0;
let combo = 0;

let resizeHandler = null;
let dataHandler = null;

const PRESSURE_THRESHOLD_LIGHT = 800;
const PRESSURE_THRESHOLD_HEAVY = 3000;
const JUDGE_LINE_Y = 0.85;
const NOTE_SPEED = 4;

export async function mount(root) {
    root.innerHTML = `
        <div id="game-container" style="position:relative; width:100%; height:100%; min-height:320px; background:#1a1a2e; color:#e94560; font-family:sans-serif; overflow:hidden; display:flex; flex-direction:column;">
            <div id="hud" style="padding:15px; display:flex; justify-content:space-between; font-size:1.2rem; font-weight:bold; background:rgba(0,0,0,0.3);">
                <div>分數: <span id="score-val">0</span></div>
                <div>Combo: <span id="combo-val">0</span></div>
            </div>
            <canvas id="game-canvas" style="flex:1; width:100%; min-height:200px; touch-action:none;"></canvas>
            <div id="pressure-bar-container" style="position:absolute; right:20px; bottom:100px; width:30px; height:200px; background:#333; border:2px solid #555; border-radius:15px; overflow:hidden;">
                <div id="pressure-bar" style="position:absolute; bottom:0; width:100%; height:0%; background:linear-gradient(to top, #4ecca3, #f8fe85, #ff4b2b); transition: height 0.05s;"></div>
            </div>
            <div id="guide" style="position:absolute; bottom:20px; left:20px; color:#aaa; font-size:0.8rem;">
                邏輯通道 0（GPIO 0）· 主控台須啟用該 ADC
            </div>
        </div>`;

    const canvas = root.querySelector('#game-canvas');
    const ctx = canvas.getContext('2d');
    const scoreEl = root.querySelector('#score-val');
    const comboEl = root.querySelector('#combo-val');
    const pressureBar = root.querySelector('#pressure-bar');

    resizeHandler = () => {
        canvas.width = Math.max(1, canvas.clientWidth);
        canvas.height = Math.max(1, canvas.clientHeight);
    };
    window.addEventListener('resize', resizeHandler);
    resizeHandler();

    dataHandler = (ev) => {
        const ch0 = ev.detail.channels[0];
        if (ch0) {
            currentPressure = ch0.filtered;
            const percent = (currentPressure / 4095) * 100;
            pressureBar.style.height = `${percent}%`;
        }
    };
    window.addEventListener('omnisense:data', dataHandler);

    const loop = () => {
        update(canvas, scoreEl, comboEl);
        draw(canvas, ctx);
        animationId = requestAnimationFrame(loop);
    };

    const update = (c, sEl, cEl) => {
        if (Math.random() < 0.02) {
            notes.push({
                y: 0,
                type: Math.random() > 0.3 ? 'LIGHT' : 'HEAVY',
                hit: false
            });
        }

        const judgeY = c.height * JUDGE_LINE_Y;

        for (let i = notes.length - 1; i >= 0; i--) {
            const note = notes[i];
            note.y += NOTE_SPEED;

            if (!note.hit && note.y > judgeY - 30 && note.y < judgeY + 30) {
                let isHit = false;
                if (note.type === 'LIGHT' && currentPressure > PRESSURE_THRESHOLD_LIGHT && currentPressure < PRESSURE_THRESHOLD_HEAVY) {
                    isHit = true;
                } else if (note.type === 'HEAVY' && currentPressure > PRESSURE_THRESHOLD_HEAVY) {
                    isHit = true;
                }

                if (isHit) {
                    note.hit = true;
                    score += note.type === 'HEAVY' ? 200 : 100;
                    combo++;
                    playHitSound(note.type === 'HEAVY' ? 440 : 880);
                }
            }

            if (note.y > c.height) {
                if (!note.hit) combo = 0;
                notes.splice(i, 1);
            }
        }

        sEl.innerText = String(score);
        cEl.innerText = String(combo);
    };

    const draw = (c, cx) => {
        cx.clearRect(0, 0, c.width, c.height);
        const judgeY = c.height * JUDGE_LINE_Y;

        cx.strokeStyle = '#555';
        cx.setLineDash([5, 5]);
        cx.beginPath();
        cx.moveTo(0, judgeY);
        cx.lineTo(c.width, judgeY);
        cx.stroke();
        cx.setLineDash([]);

        notes.forEach((note) => {
            if (note.hit) return;
            cx.beginPath();
            if (note.type === 'HEAVY') {
                cx.fillStyle = '#ff4b2b';
                cx.arc(c.width / 2, note.y, 25, 0, Math.PI * 2);
            } else {
                cx.fillStyle = '#4ecca3';
                cx.arc(c.width / 2, note.y, 15, 0, Math.PI * 2);
            }
            cx.fill();
        });

        cx.fillStyle = '#aaa';
        cx.textAlign = 'center';
        cx.fillText(
            currentPressure > PRESSURE_THRESHOLD_HEAVY ? '強壓中!' : currentPressure > PRESSURE_THRESHOLD_LIGHT ? '輕壓中' : '',
            c.width / 2,
            judgeY + 50
        );
    };

    loop();
}

export async function cleanup() {
    if (animationId != null) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }
    if (resizeHandler) {
        window.removeEventListener('resize', resizeHandler);
        resizeHandler = null;
    }
    if (dataHandler) {
        window.removeEventListener('omnisense:data', dataHandler);
        dataHandler = null;
    }
    notes.length = 0;
    score = 0;
    combo = 0;
    if (audioCtx) {
        try {
            await audioCtx.close();
        } catch (_) {}
        audioCtx = null;
    }
}

function playHitSound(freq) {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start();
    osc.stop(audioCtx.currentTime + 0.1);
}

export async function onConnected() {
    console.log('ForceFlow：已連線，請在主控台啟用邏輯通道 0（ADC）');
}
