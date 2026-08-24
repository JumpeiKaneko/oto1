/* ============================================================
   時間軸：現実の暦時間で1年かけて朽ちる（6用・9用で共通の時間軸）
   ※展示初日に合わせて GLOBAL_START を書き換えること。
============================================================ */
const GLOBAL_START = new Date('2026-08-24T00:00:00+09:00');
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const GLOBAL_END = new Date(GLOBAL_START.getTime() + YEAR_MS);

function decayFraction(){
  const now = Date.now();
  const t = (now - GLOBAL_START.getTime()) / (GLOBAL_END.getTime() - GLOBAL_START.getTime());
  return Math.min(1, Math.max(0, t));
}

/* ============================================================
   疑似乱数
============================================================ */
function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedFromString(str){
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++){
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^ (h >>> 16)) >>> 0;
}

/* イヴ・クラインのモノクロームの発想：器は全部同じ一色 */
const KLEIN = [0, 40, 168];
const PALETTE = [KLEIN, KLEIN, KLEIN];
const ACCENT = [242, 239, 233]; // 衝突の閃きは白

/* ============================================================
   和音：長音階上で3度堆積、ちょうどn音のコードを作る
============================================================ */
const MAJOR_SCALE = [0,2,4,5,7,9,11];
function stackTones(n){
  const tones = [];
  let idx = 0;
  while (tones.length < n){
    const step = idx*2;
    const octave = Math.floor(step/7);
    const degree = step % 7;
    tones.push(MAJOR_SCALE[degree] + octave*12);
    idx++;
  }
  return tones;
}
function buildChord(seedNum, n){
  const rootMidiOffset = seedNum % 12;
  const root = 130.81 * Math.pow(2, rootMidiOffset/12);
  return stackTones(n).map(iv => root * Math.pow(2, iv/12));
}

/* ============================================================
   球体（このページ固有の個数は window.BALL_COUNT で渡される）
============================================================ */
let ballCount = window.BALL_COUNT || 6;
const BALL_R = 26;
let balls = [];
let chordFreqs = [];
let rng = Math.random;

let audioCtx = null;
let masterGain = null;
let masterFilter = null;
let convolver = null;
let wetGain = null;
let running = false;
let activeVoices = 0;
const MAX_VOICES = 28;
const HIT_COOLDOWN = 160;

let ripples = [];

class Ball{
  constructor(x,y,freq,colorIdx,rank,noiseSeed){
    this.x=x; this.y=y; this.vx=0; this.vy=0;
    this.freq=freq; this.colorIdx=colorIdx; this.rank=rank;
    this.noiseSeed = noiseSeed;
    this.lastHit = -9999;
    this.flash = 0;
  }
}

let basinCX, basinCY, basinR;
const BASIN_SCALE = 0.30;

function initBalls(seedNum){
  const r = mulberry32(seedNum);
  balls = [];
  const ranks = Array.from({length: ballCount}, (_,i)=>i);
  for (let i=ranks.length-1; i>0; i--){
    const j = Math.floor(r()*(i+1));
    [ranks[i], ranks[j]] = [ranks[j], ranks[i]];
  }
  for (let i=0; i<ballCount; i++){
    const angle = r()*Math.PI*2;
    const rad = r()*basinR*0.7;
    const x = basinCX + Math.cos(angle)*rad;
    const y = basinCY + Math.sin(angle)*rad;
    const colorIdx = i % PALETTE.length;
    balls.push(new Ball(x,y, chordFreqs[i], colorIdx, ranks[i], r()*1000));
  }
}

/* ---------- 発音：アンビエントなパッド＋薄い鐘のアタック ---------- */
function createImpulseResponse(ctx, duration, decay){
  const rate = ctx.sampleRate;
  const length = Math.floor(rate*duration);
  const impulse = ctx.createBuffer(2, length, rate);
  for (let ch=0; ch<2; ch++){
    const data = impulse.getChannelData(ch);
    for (let i=0; i<length; i++){
      data[i] = (Math.random()*2-1) * Math.pow(1 - i/length, decay);
    }
  }
  return impulse;
}

function playChime(freq, panX, velMag, volumeScale){
  if (!audioCtx || activeVoices >= MAX_VOICES || volumeScale <= 0.003) return;
  activeVoices++;
  const now = audioCtx.currentTime;

  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 0.3;
  filter.frequency.setValueAtTime(700, now);
  filter.frequency.linearRampToValueAtTime(2400, now + 1.2);
  filter.frequency.linearRampToValueAtTime(500, now + 3.2);

  const gain = audioCtx.createGain();
  const peak = Math.min(0.34, 0.09 + velMag*0.6) * volumeScale;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(peak, now + 0.32);
  gain.gain.linearRampToValueAtTime(peak*0.7, now + 1.0);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 3.4);

  const panner = audioCtx.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, panX));

  const detunes = [0, 7, -9];
  const oscs = detunes.map(det => {
    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.detune.value = det;
    osc.connect(filter);
    osc.start(now);
    osc.stop(now + 3.6);
    return osc;
  });
  const upper = audioCtx.createOscillator();
  upper.type = 'sine';
  upper.frequency.value = freq*2;
  const upperGain = audioCtx.createGain();
  upperGain.gain.value = 0.12;
  upper.connect(upperGain); upperGain.connect(filter);
  upper.start(now); upper.stop(now + 3.6);

  filter.connect(gain); gain.connect(panner); panner.connect(masterGain);

  const strikeGain = audioCtx.createGain();
  const strikePeak = Math.min(0.22, 0.05 + velMag*0.35) * volumeScale;
  strikeGain.gain.setValueAtTime(0.0001, now);
  strikeGain.gain.linearRampToValueAtTime(strikePeak, now + 0.005);
  strikeGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.1);
  const strikeFund = audioCtx.createOscillator();
  strikeFund.type = 'sine'; strikeFund.frequency.value = freq;
  const strikePartial = audioCtx.createOscillator();
  strikePartial.type = 'sine'; strikePartial.frequency.value = freq*2.76;
  const strikePartialGain = audioCtx.createGain();
  strikePartialGain.gain.value = 0.22;
  strikeFund.connect(strikeGain);
  strikePartial.connect(strikePartialGain); strikePartialGain.connect(strikeGain);
  strikeGain.connect(panner);
  strikeFund.start(now); strikePartial.start(now);
  strikeFund.stop(now + 1.2); strikePartial.stop(now + 1.2);

  oscs[0].onended = () => {
    try{
      oscs.forEach(o=>o.disconnect());
      upper.disconnect(); upperGain.disconnect();
      strikeFund.disconnect(); strikePartial.disconnect(); strikePartialGain.disconnect(); strikeGain.disconnect();
      filter.disconnect(); gain.disconnect(); panner.disconnect();
    }catch(e){}
    activeVoices--;
  };
}

/* ============================================================
   物理：緩い水流に押されて漂う。球同士の衝突でのみ発音＋波紋
============================================================ */
function updatePhysics(aliveCount, speedScale, volumeScale, ballRadiusNow, nowMs){
  const active = balls.filter(b => b.rank < aliveCount);

  const timeScale = frameCount * 0.0025;
  for (const b of active){
    const angle = noise(b.noiseSeed, timeScale) * Math.PI * 4;
    const force = 0.018 * speedScale;
    b.vx += Math.cos(angle) * force;
    b.vy += Math.sin(angle) * force;
    b.vx *= 0.975; b.vy *= 0.975;

    const sp = Math.hypot(b.vx, b.vy);
    const maxSp = 0.55 * speedScale;
    if (sp > maxSp && sp > 0){ b.vx = b.vx/sp*maxSp; b.vy = b.vy/sp*maxSp; }

    b.x += b.vx; b.y += b.vy;

    const dx = b.x-basinCX, dy = b.y-basinCY;
    const dist = Math.hypot(dx,dy);
    const limit = basinR - ballRadiusNow;
    if (dist > limit && dist > 0){
      const nx = dx/dist, ny = dy/dist;
      b.x = basinCX + nx*limit; b.y = basinCY + ny*limit;
      const vn = b.vx*nx + b.vy*ny;
      b.vx -= 1.6*vn*nx; b.vy -= 1.6*vn*ny;
    }
  }

  for (let i=0; i<active.length; i++){
    for (let j=i+1; j<active.length; j++){
      const a = active[i], b = active[j];
      const dx = b.x-a.x, dy = b.y-a.y;
      const dist = Math.hypot(dx,dy);
      if (dist > 0 && dist < ballRadiusNow*2){
        const nx = dx/dist, ny = dy/dist;
        const overlap = (ballRadiusNow*2 - dist)/2;
        a.x -= nx*overlap; a.y -= ny*overlap;
        b.x += nx*overlap; b.y += ny*overlap;
        const relVel = (b.vx-a.vx)*nx + (b.vy-a.vy)*ny;
        if (relVel < 0){
          a.vx += nx*relVel*0.9; a.vy += ny*relVel*0.9;
          b.vx -= nx*relVel*0.9; b.vy -= ny*relVel*0.9;
          const impact = Math.abs(relVel);
          const midX = (a.x+b.x)/2, midY = (a.y+b.y)/2;
          if (nowMs - a.lastHit > HIT_COOLDOWN){
            a.lastHit = nowMs;
            a.flash = 1;
            playChime(a.freq, (a.x/width)*2-1, impact, volumeScale);
          }
          if (nowMs - b.lastHit > HIT_COOLDOWN){
            b.lastHit = nowMs;
            b.flash = 1;
            playChime(b.freq, (b.x/width)*2-1, impact, volumeScale);
          }
        }
      }
    }
  }
  return active;
}

/* ============================================================
   p5 セットアップ／描画
============================================================ */
function setup(){
  const cnv = createCanvas(windowWidth, windowHeight);
  cnv.parent(document.getElementById('sketch-holder'));
  colorMode(RGB, 255);
  computeBasin();
}
function computeBasin(){
  basinCX = width/2; basinCY = height/2;
  basinR = Math.min(width, height) * BASIN_SCALE;
}
function windowResized(){ resizeCanvas(windowWidth, windowHeight); computeBasin(); }

function draw(){
  noStroke();
  fill(5,5,6);
  rect(0,0,width,height);

  if (!running) return;

  const t = decayFraction();
  const aliveCount = Math.round(ballCount * (1 - t));
  const speedScale = lerp(1.0, 0.05, t);
  const volumeScale = Math.max(0, 1 - t);
  const colorFade = lerp(1.0, 0.15, t);
  const ballRadiusNow = Math.max(BALL_R*0.12, BALL_R * lerp(1.0, 0.12, t));

  if (masterFilter){
    const cutoff = lerp(9000, 180, t);
    masterFilter.frequency.setTargetAtTime(cutoff, audioCtx.currentTime, 1.2);
  }

  const active = updatePhysics(aliveCount, speedScale, volumeScale, ballRadiusNow, Date.now());

  for (const b of active){
    const col = PALETTE[b.colorIdx];
    noStroke();
    if (b.flash > 0.01){
      fill(ACCENT[0], ACCENT[1], ACCENT[2]);
      b.flash -= 0.12;
    } else {
      fill(col[0], col[1], col[2]);
    }
    circle(b.x, b.y, ballRadiusNow*2);
  }

  const liveEl = document.getElementById('liveCount');
  liveEl.textContent = String(aliveCount).padStart(2,'0');
  liveEl.classList.add('show');
}

/* ============================================================
   ピンチで水槽の範囲を調整
============================================================ */
let userBasinScale = BASIN_SCALE;
function touchDist(touches){
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx,dy);
}
function setupPinch(){
  const holder = document.getElementById('sketch-holder');
  let startDist = null, startScale = null;
  holder.addEventListener('touchstart', (e)=>{
    if (e.touches.length === 2){
      startDist = touchDist(e.touches);
      startScale = userBasinScale;
    }
  }, {passive:true});
  holder.addEventListener('touchmove', (e)=>{
    if (e.touches.length === 2 && startDist){
      e.preventDefault();
      const d = touchDist(e.touches);
      const ratio = d / startDist;
      userBasinScale = Math.max(0.14, Math.min(0.48, startScale*ratio));
      basinR = Math.min(width, height) * userBasinScale;
    }
  }, {passive:false});
  holder.addEventListener('touchend', (e)=>{
    if (e.touches.length < 2) startDist = null;
  });
}

/* ============================================================
   起動：URLの ?seed= から個体差を決める（シールごとに固有のURL）
============================================================ */
document.getElementById('startOverlay').addEventListener('click', async ()=>{
  if (!audioCtx){
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.9;
    masterFilter = audioCtx.createBiquadFilter();
    masterFilter.type = 'lowpass';
    masterFilter.frequency.value = 9000;

    convolver = audioCtx.createConvolver();
    convolver.buffer = createImpulseResponse(audioCtx, 7.5, 2.2);
    wetGain = audioCtx.createGain();
    wetGain.gain.value = 0.68;

    masterGain.connect(masterFilter);
    masterGain.connect(convolver);
    convolver.connect(wetGain);
    wetGain.connect(masterFilter);
    masterFilter.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  startPiece();
  document.getElementById('startOverlay').classList.add('hidden');
});

function startPiece(){
  setupPinch();
  computeBasin();
  const params = new URLSearchParams(location.search);
  const seedText = params.get('seed') || '';
  const seedNum = seedText ? seedFromString(seedText) : Math.floor(Math.random()*1e9);
  rng = mulberry32(seedNum);
  chordFreqs = buildChord(seedNum, ballCount);
  initBalls(seedNum);
  ripples = [];
  running = true;
  console.log('seed:', seedNum, '/ ballCount:', ballCount, '/ 経過率:', (decayFraction()*100).toFixed(2)+'%');
}
