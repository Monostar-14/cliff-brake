/*!
 * 悬崖急刹 (Cliff Brake) — 视图 / 交互层
 * 依赖 game.js 暴露的 window.CarGame
 */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };

  // ---------------------------------------------------------------- 引用
  var canvas = $('#world');
  var ctx = canvas.getContext('2d');
  var stage = $('#stage');
  var el = {
    distText: $('#distText'), bestText: $('#bestText'),
    trackFill: $('#trackFill'), trackCar: $('#trackCar'), trackDanger: $('#trackDanger'),
    pedalFill: $('#pedalFill'), pedalVal: $('#pedalVal'), pedalSub: $('#pedalSub'),
    pedalPanel: $('#pedalPanel'), gaugeTicks: $('#gaugeTicks'), needText: $('#needText'),
    speedText: $('#speedText'), needle: $('#needle'), speedArcFill: $('#speedArcFill'),
    speedArc: $('#speedArc'), speedTicks: $('#speedTicks'),
    brakeBtn: $('#brakeBtn'), status: $('#status'),
    overlay: $('#overlay'), ovPanel: $('#ovPanel'),
    meters: $('#meters'), predictText: $('#predictText'),
    heldText: $('#heldText'), leftText: $('#leftText'), theoDist: $('#theoDist'),
    soundBtn: $('#soundBtn'), selftest: $('#selftest')
  };

  var THEO = window.carTheoretical();
  var FEATHER = 1.45;                        // 点刹比一脚踩死多滑的比例(实测 0.6/0.3 节奏)
  var DANGER = THEO.brakeDist * 1.5;         // 危险区长度: 在这里才开始刹车基本刹不住
  var game = new window.CarGame();
  var g = game;

  // ---------------------------------------------------------------- 状态
  var W = 0, H = 0, visM = 185, scale = 7, groundY = 0, camX = 0, roadH = 14;
  var CAR_VIS = 2.2;           // 车的视觉放大系数(只为好看)
  var smoke = [], skid = [], wheelRot = 0, prevPhase = 'idle', snapFired = false, flash = 0;
  var shakeX = 0, shakeY = 0;
  var paused = true;           // 浮层显示时暂停推进
  var runLoop = true;
  var best = null;

  try { best = JSON.parse(localStorage.getItem('cliffBrakeBest') || 'null'); } catch (e) { best = null; }

  // ---------------------------------------------------------------- 音效
  var Sound = (function () {
    var ac = null, noiseBuf = null, skidGain = null, ready = false, on = true;
    function init() {
      if (ready) return;
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ac = new AC();
        var len = Math.floor(ac.sampleRate * 1.2);
        noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
        var d = noiseBuf.getChannelData(0);
        for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        var src = ac.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
        var bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 1.1;
        skidGain = ac.createGain(); skidGain.gain.value = 0;
        src.connect(bp); bp.connect(skidGain); skidGain.connect(ac.destination);
        src.start();
        ready = true;
      } catch (e) { ready = false; }
    }
    function resume() { try { if (ac && ac.state === 'suspended') ac.resume(); } catch (e) {} }
    function skid(level) {
      if (!ready || !on) return;
      try { skidGain.gain.setTargetAtTime(Math.max(0, level) * 0.15, ac.currentTime, 0.06); } catch (e) {}
    }
    function noise(dur, vol, freq, toFreq) {
      if (!ready || !on) return;
      try {
        var s = ac.createBufferSource(); s.buffer = noiseBuf;
        var f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq;
        if (toFreq) { f.frequency.setValueAtTime(freq, ac.currentTime); f.frequency.exponentialRampToValueAtTime(Math.max(60, toFreq), ac.currentTime + dur); }
        var gn = ac.createGain();
        gn.gain.setValueAtTime(vol, ac.currentTime);
        gn.gain.exponentialRampToValueAtTime(0.0008, ac.currentTime + dur);
        s.connect(f); f.connect(gn); gn.connect(ac.destination);
        s.start(); s.stop(ac.currentTime + dur + 0.03);
      } catch (e) {}
    }
    function tone(freq, dur, vol, type) {
      if (!ready || !on) return;
      try {
        var o = ac.createOscillator(); o.type = type || 'sine'; o.frequency.value = freq;
        var gn = ac.createGain();
        gn.gain.setValueAtTime(0.0001, ac.currentTime);
        gn.gain.exponentialRampToValueAtTime(vol, ac.currentTime + 0.02);
        gn.gain.exponentialRampToValueAtTime(0.0008, ac.currentTime + dur);
        o.connect(gn); gn.connect(ac.destination);
        o.start(); o.stop(ac.currentTime + dur + 0.03);
      } catch (e) {}
    }
    return {
      init: init, resume: resume, skid: skid,
      snap: function () { noise(0.16, 0.5, 2600, 160); tone(180, 0.14, 0.22, 'square'); },
      crash: function () { noise(0.85, 0.55, 380, 70); tone(70, 0.7, 0.25, 'sawtooth'); },
      impact: function () { noise(0.6, 0.8, 900, 80); tone(56, 0.6, 0.38, 'sawtooth'); },
      win: function () { tone(660, 0.16, 0.2); setTimeout(function () { tone(880, 0.22, 0.2); }, 130); setTimeout(function () { tone(1180, 0.3, 0.16); }, 270); },
      toggle: function () { on = !on; if (!on) skid(0); return on; },
      isOn: function () { return on; }
    };
  })();

  // ---------------------------------------------------------------- 尺寸
  function resize() {
    var r = stage.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(320, Math.round(r.width));
    H = Math.max(180, Math.round(r.height));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    visM = W < 820 ? 132 : W < 1150 ? 152 : W < 1500 ? 172 : 188;
    scale = W / visM;
    groundY = Math.round(H * 0.66);
    roadH = Math.max(11, Math.min(18, scale * 1.7));
  }

  // ---------------------------------------------------------------- 绘图工具
  function sx(worldX) { return (worldX - camX) * scale; }
  function rr(x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  var CLOUDS = [
    { x: 40, y: 0.16, s: 1.1, p: 0.16 }, { x: 190, y: 0.10, s: 0.8, p: 0.2 },
    { x: 320, y: 0.20, s: 1.3, p: 0.14 }, { x: 470, y: 0.13, s: 0.95, p: 0.18 },
    { x: 640, y: 0.22, s: 1.05, p: 0.15 }
  ];

  function drawSky() {
    var g1 = ctx.createLinearGradient(0, 0, 0, groundY + 40);
    g1.addColorStop(0, '#0e1a2f');
    g1.addColorStop(0.42, '#26395c');
    g1.addColorStop(0.74, '#4d5c78');
    g1.addColorStop(1, '#c07a4e');
    ctx.fillStyle = g1;
    ctx.fillRect(0, 0, W, groundY + 40);
    // 落日
    var sunX = W * 0.78, sunY = groundY - H * 0.16;
    var glow = ctx.createRadialGradient(sunX, sunY, 4, sunX, sunY, H * 0.5);
    glow.addColorStop(0, 'rgba(255,206,140,.62)');
    glow.addColorStop(0.35, 'rgba(255,150,90,.2)');
    glow.addColorStop(1, 'rgba(255,120,60,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, groundY + 40);
    ctx.fillStyle = 'rgba(255,232,196,.95)';
    ctx.beginPath(); ctx.arc(sunX, sunY, Math.max(16, H * 0.058), 0, 6.2832); ctx.fill();
  }

  function drawClouds() {
    ctx.save();
    for (var i = 0; i < CLOUDS.length; i++) {
      var c = CLOUDS[i];
      var x = (c.x - camX * c.p) * scale, y = H * c.y, s = c.s * Math.max(0.6, scale * 0.36);
      if (x < -260 || x > W + 260) continue;
      ctx.fillStyle = 'rgba(216,230,255,.09)';
      ctx.beginPath();
      ctx.ellipse(x, y, 62 * s * 0.6, 12 * s * 0.6, 0, 0, 6.2832);
      ctx.ellipse(x + 34 * s * 0.6, y - 6 * s * 0.6, 40 * s * 0.6, 13 * s * 0.6, 0, 0, 6.2832);
      ctx.ellipse(x - 36 * s * 0.6, y + 3 * s * 0.6, 34 * s * 0.6, 9 * s * 0.6, 0, 0, 6.2832);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawRidge(par, baseY, amp, freq, phase, color) {
    ctx.beginPath();
    ctx.moveTo(-4, baseY + 60);
    for (var x = -4; x <= W + 4; x += 6) {
      var w = camX * par + x / scale;
      var y = baseY - amp * (0.62 * Math.sin(w * freq + phase) + 0.38 * Math.sin(w * freq * 2.6 + phase * 1.7));
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W + 4, baseY + 60);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  function drawGround() {
    var xEnd = sx(g.roadLen);
    var xStart = -60;
    // 远景峡谷(崖外)
    var vg = ctx.createLinearGradient(0, groundY - 4, 0, H);
    vg.addColorStop(0, '#16233a'); vg.addColorStop(0.5, '#0b1220'); vg.addColorStop(1, '#04060b');
    ctx.fillStyle = vg;
    ctx.fillRect(Math.min(xEnd, W) - 2, groundY - 4, Math.max(0, W - Math.min(xEnd, W)) + 4, H - groundY + 8);
    // 峡谷雾气
    ctx.fillStyle = 'rgba(120,150,190,.07)';
    ctx.fillRect(Math.max(0, xEnd), groundY + (H - groundY) * 0.35, W, (H - groundY) * 0.16);
    // 远处峡谷底
    ctx.save();
    ctx.beginPath();
    for (var x = Math.max(0, xEnd) - 4; x <= W + 4; x += 6) {
      var w = camX * 0.12 + x / scale;
      var y = H - 30 - 18 * Math.sin(w * 0.02) - 9 * Math.sin(w * 0.05 + 1.1);
      if (x <= Math.max(0, xEnd) - 3) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.lineTo(W + 4, H + 4); ctx.lineTo(Math.max(0, xEnd) - 4, H + 4); ctx.closePath();
    ctx.fillStyle = 'rgba(46,64,96,.6)'; ctx.fill();
    ctx.restore();

    // 高原(地面)
    ctx.save();
    ctx.beginPath();
    ctx.rect(xStart, groundY - 1, Math.max(0, xEnd - xStart), H - groundY + 2);
    ctx.clip();
    var rg = ctx.createLinearGradient(0, groundY, 0, H);
    rg.addColorStop(0, '#6a5c46'); rg.addColorStop(0.1, '#544838');
    rg.addColorStop(0.5, '#372f24'); rg.addColorStop(1, '#17140f');
    ctx.fillStyle = rg;
    ctx.fillRect(xStart, groundY - 1, xEnd - xStart, H - groundY + 2);
    // 岩层
    ctx.strokeStyle = 'rgba(0,0,0,.22)'; ctx.lineWidth = 1;
    for (var i = 0; i < 9; i++) {
      var yy = groundY + 22 + i * 22 + Math.sin(i * 2.7) * 4;
      if (yy > H) break;
      ctx.beginPath();
      for (var xx = xStart; xx <= xEnd; xx += 14) {
        var ww = camX * 0.995 + xx / scale;
        ctx.lineTo(sx(xx), yy + 5 * Math.sin(ww * 0.08 + i));
      }
      ctx.stroke();
    }
    // 路面
    ctx.fillStyle = '#3b414b';
    ctx.fillRect(xStart, groundY, xEnd - xStart, roadH);
    ctx.fillStyle = 'rgba(255,255,255,.16)';
    ctx.fillRect(xStart, groundY, xEnd - xStart, 2);
    // 中线
    ctx.fillStyle = 'rgba(255,205,80,.55)';
    for (var d = 0; d < xEnd - xStart; d += 46) {
      ctx.fillRect(sx(xStart + d), groundY + roadH * 0.45, 26, 2.5);
    }
    ctx.restore();

    // 悬崖立面
    if (xEnd > -30 && xEnd < W + 40) {
      var fg = ctx.createLinearGradient(xEnd, groundY, xEnd, H);
      fg.addColorStop(0, '#4a4133'); fg.addColorStop(0.3, '#2e2921'); fg.addColorStop(1, '#100e0c');
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.moveTo(xEnd - 2, groundY);
      ctx.lineTo(xEnd + 9, groundY + 16);
      ctx.lineTo(xEnd + 5, H); ctx.lineTo(xEnd - 6, H);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(255,190,120,.22)'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(xEnd - 1, groundY); ctx.lineTo(xEnd + 8, groundY + 15); ctx.stroke();
      // 崖边红白警示条
      var bw = 9, seg = 0;
      for (var bx = xEnd - 16; bx < xEnd + 2; bx += bw, seg++) {
        ctx.fillStyle = seg % 2 ? '#e14b3b' : '#f2f2f2';
        ctx.save();
        ctx.beginPath(); ctx.rect(sx(bx), groundY - 5, bw * scale, 5); ctx.clip();
        ctx.fillStyle = seg % 2 ? '#e14b3b' : '#f2f2f2';
        ctx.fillRect(sx(bx), groundY - 5, bw * scale, 5);
        ctx.restore();
      }
    }
  }

  function drawRoadMarks() {
    // 危险区红色带
    var danger = g.roadLen - DANGER;
    var x0 = sx(danger);
    ctx.save();
    ctx.beginPath();
    ctx.rect(Math.max(0, x0), groundY, Math.max(0, Math.min(W, sx(g.roadLen)) - Math.max(0, x0)), roadH);
    ctx.clip();
    var dg = ctx.createLinearGradient(x0, 0, sx(g.roadLen), 0);
    dg.addColorStop(0, 'rgba(226,68,52,.10)'); dg.addColorStop(1, 'rgba(226,68,52,.42)');
    ctx.fillStyle = dg;
    ctx.fillRect(x0, groundY, sx(g.roadLen) - x0, roadH);
    ctx.restore();
    // 分界虚线
    if (x0 > -20 && x0 < W + 20) {
      ctx.strokeStyle = 'rgba(255,120,90,.6)'; ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 5]);
      ctx.beginPath(); ctx.moveTo(x0, groundY - 12); ctx.lineTo(x0, groundY + roadH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,140,110,.85)';
      ctx.font = '600 10px "Segoe UI",system-ui'; ctx.textAlign = 'center';
      ctx.fillText('最后 ' + DANGER.toFixed(0) + 'm · 才开始刹车就晚了', x0, groundY - 44);
    }
    // 距离刻度(到崖边还剩多少米)
    ctx.textAlign = 'center';
    for (var d = 20; d < g.roadLen; d += 20) {
      var x = g.roadLen - d;
      var px = sx(x);
      if (px < -40 || px > W + 40) continue;
      ctx.fillStyle = 'rgba(255,255,255,.16)';
      ctx.fillRect(px - 1, groundY + roadH - 6, 2, 6);
      ctx.fillStyle = 'rgba(255,255,255,.42)';
      ctx.font = '700 10px "Segoe UI",system-ui';
      ctx.fillText(String(d), px, groundY - 5);
    }
    // 刹车痕迹
    ctx.fillStyle = 'rgba(10,10,12,.5)';
    for (var i = 0; i < skid.length; i++) {
      var s = skid[i], px2 = sx(s);
      if (px2 < -20 || px2 > W + 20) continue;
      ctx.fillRect(px2, groundY + 3, 6, 3);
      ctx.fillRect(px2, groundY + roadH - 7, 6, 3);
    }
  }

  function drawCar(px, py, rot, noShadow) {
    var S = scale * CAR_VIS;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(rot);
    ctx.scale(S, S);
    // 影子
    if (!noShadow) {
      ctx.fillStyle = 'rgba(0,0,0,.42)';
      ctx.beginPath(); ctx.ellipse(-2.3, 0.12, 2.5, 0.16, 0, 0, 6.2832); ctx.fill();
    }
    var braking = g.brakeOn || g.pedalBroken;
    // 车身
    var body = ctx.createLinearGradient(0, -1.1, 0, -0.2);
    body.addColorStop(0, braking ? '#ff6f5e' : '#4ea8f5');
    body.addColorStop(0.5, braking ? '#d8452f' : '#2b7fd4');
    body.addColorStop(1, braking ? '#8c2318' : '#17538f');
    ctx.fillStyle = body;
    rr(-4.55, -1.04, 4.42, 0.62, 0.14); ctx.fill();
    // 车顶
    ctx.beginPath();
    ctx.moveTo(-3.95, -1.02); ctx.lineTo(-3.32, -1.72);
    ctx.lineTo(-1.62, -1.78); ctx.lineTo(-1.02, -1.02);
    ctx.closePath();
    ctx.fillStyle = braking ? '#e6543c' : '#2f8be0';
    ctx.fill();
    // 车窗
    ctx.beginPath();
    ctx.moveTo(-3.72, -1.06); ctx.lineTo(-3.28, -1.6);
    ctx.lineTo(-2.62, -1.63); ctx.lineTo(-2.52, -1.06);
    ctx.closePath();
    ctx.fillStyle = 'rgba(210,240,255,.75)'; ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-2.34, -1.06); ctx.lineTo(-2.44, -1.63);
    ctx.lineTo(-1.72, -1.66); ctx.lineTo(-1.42, -1.06);
    ctx.closePath(); ctx.fill();
    // 车灯
    ctx.fillStyle = 'rgba(255,236,170,.95)';
    rr(-0.30, -0.90, 0.28, 0.22, 0.06); ctx.fill();
    if (braking) {
      ctx.save();
      ctx.shadowColor = '#ff3a2a'; ctx.shadowBlur = 10;
      ctx.fillStyle = '#ff5140';
      rr(-4.60, -0.92, 0.26, 0.26, 0.07); ctx.fill();
      ctx.restore();
    } else {
      ctx.fillStyle = 'rgba(190,60,50,.85)';
      rr(-4.60, -0.92, 0.24, 0.22, 0.07); ctx.fill();
    }
    // 车轮
    function wheel(wx) {
      ctx.save();
      ctx.translate(wx, -0.35);
      ctx.fillStyle = '#14171c';
      ctx.beginPath(); ctx.arc(0, 0, 0.36, 0, 6.2832); ctx.fill();
      ctx.strokeStyle = '#4b525c'; ctx.lineWidth = 0.07;
      ctx.beginPath(); ctx.arc(0, 0, 0.36, 0, 6.2832); ctx.stroke();
      ctx.rotate(wheelRot);
      ctx.strokeStyle = 'rgba(180,195,215,.55)'; ctx.lineWidth = 0.055;
      for (var k = 0; k < 3; k++) {
        var a = k * Math.PI / 3;
        ctx.beginPath();
        ctx.moveTo(-Math.cos(a) * 0.24, -Math.sin(a) * 0.24);
        ctx.lineTo(Math.cos(a) * 0.24, Math.sin(a) * 0.24);
        ctx.stroke();
      }
      ctx.restore();
    }
    wheel(-3.58); wheel(-0.98);
    ctx.restore();
  }

  function spawnP(x, y, o) {
    if (smoke.length > 340) smoke.shift();
    smoke.push({
      x: x, y: y,
      vx: o.vx || 0, vy: o.vy || 0,
      r: o.r || 0.2, grow: o.grow == null ? 0.5 : o.grow,
      life: o.life || 0.8, max: o.life || 0.8,
      col: o.col || '206,214,226',
      alpha: o.alpha == null ? 0.42 : o.alpha
    });
  }
  function updateSmoke(dt) {
    for (var i = smoke.length - 1; i >= 0; i--) {
      var p = smoke[i];
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.r += p.grow * dt;
      if (p.r < 0.02) p.r = 0.02;
      if (p.life <= 0) smoke.splice(i, 1);
    }
  }
  function drawSmoke() {
    for (var i = 0; i < smoke.length; i++) {
      var p = smoke[i], px = sx(p.x), py = groundY - p.y * scale;
      var a = Math.max(0, p.life / p.max) * p.alpha;
      ctx.fillStyle = 'rgba(' + p.col + ',' + a.toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(px, py, p.r * scale, 0, 6.2832); ctx.fill();
    }
  }

  /** 现在踩刹车大概会停在哪（mult>1 表示点刹比理论多滑） */
  function predictAt(mult) {
    var d = (g.v * g.v) / (2 * g.cfg.brakeDecel) * mult;
    return { dist: d, stopX: g.x + d };
  }

  function drawPredict() {
    if (g.phase !== 'run' || g.v < 1) return;
    var pr = predictAt(FEATHER);
    var px = sx(pr.stopX);
    if (px < -80 || px > W + 80) return;
    var safe = pr.stopX < g.roadLen;
    var col = safe ? (g.brakeOn ? '#5ee0a0' : 'rgba(94,224,160,.5)') : '#ff5d5d';
    ctx.save();
    ctx.strokeStyle = col; ctx.lineWidth = g.brakeOn ? 2 : 1.4;
    ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.moveTo(px, groundY - 54); ctx.lineTo(px, groundY + roadH + 6); ctx.stroke();
    ctx.setLineDash([]);
    var txt = safe ? ('点刹停点 · 还差 ' + (g.roadLen - pr.stopX).toFixed(0) + 'm') : '冲出去了!';
    ctx.font = '700 11px "Segoe UI",system-ui'; ctx.textAlign = 'center';
    var tw = ctx.measureText(txt).width + 14;
    ctx.fillStyle = 'rgba(6,10,18,.8)';
    rr(px - tw / 2, groundY - 76, tw, 20, 7); ctx.fill();
    ctx.fillStyle = col;
    ctx.fillText(txt, px, groundY - 62);
    ctx.restore();
  }

  function draw() {
    ctx.save();
    if (g.shake > 0) {
      var m = g.shake * 6;
      shakeX = (Math.random() - 0.5) * m; shakeY = (Math.random() - 0.5) * m;
    } else { shakeX = 0; shakeY = 0; }
    ctx.clearRect(0, 0, W, H);
    ctx.translate(shakeX, shakeY);
    drawSky();
    drawClouds();
    drawRidge(0.22, groundY - 6, 46, 0.0075, 0.6, '#31456a');
    drawRidge(0.45, groundY, 28, 0.013, 2.2, '#25344f');
    drawRidge(0.72, groundY + 5, 15, 0.024, 4.1, '#1a2438');
    drawGround();
    drawRoadMarks();
    drawSmoke();
    drawPredict();
    var airborne = (g.phase === 'falling' || g.phase === 'wreck');
    var px = sx(g.x), py = groundY - (airborne ? g.yOff * scale : 0);
    var spin = g.phase === 'falling' ? g.fallRot : (g.phase === 'wreck' ? g.rot : 0);
    ctx.save();
    if (spin) {
      var ccx = px - 2.3 * scale * CAR_VIS, ccy = py - 0.95 * scale * CAR_VIS;
      ctx.translate(ccx, ccy);
      ctx.rotate(spin);
      ctx.translate(-ccx, -ccy);
    }
    drawCar(px, py, 0, airborne);
    ctx.restore();
    // 速度感
    var kmh = g.kmh();
    if (kmh > 60 && g.phase !== 'won') {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,' + Math.min(0.16, (kmh - 60) / 500).toFixed(3) + ')';
      ctx.lineWidth = 1.2;
      for (var i = 0; i < 14; i++) {
        var yy = (i * 97 % Math.max(1, groundY - 40)) + 12;
        var len = 30 + (i % 4) * 22;
        var xx = (W - ((g.x * scale * 0.6 + i * 173) % (W + 200)));
        ctx.beginPath(); ctx.moveTo(xx, yy); ctx.lineTo(xx - len, yy); ctx.stroke();
      }
      ctx.restore();
    }
    // 撞地白闪
    if (flash > 0) {
      ctx.fillStyle = 'rgba(255,246,232,' + (flash * 0.26).toFixed(3) + ')';
      ctx.fillRect(-20, -20, W + 40, H + 40);
    }
    // 暗角
    var vg2 = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.42, W / 2, H / 2, Math.max(W, H) * 0.8);
    vg2.addColorStop(0, 'rgba(0,0,0,0)'); vg2.addColorStop(1, 'rgba(0,0,0,.42)');
    ctx.fillStyle = vg2; ctx.fillRect(-20, -20, W + 40, H + 40);
    ctx.restore();
  }

  // ---------------------------------------------------------------- UI
  var TICKS_DONE = false;
  function buildGauges() {
    if (TICKS_DONE) return;
    TICKS_DONE = true;
    var vals = [0, 400, 800, 1200, 1612];
    var html = '';
    for (var i = 0; i < vals.length; i++) {
      var pos = (vals[i] / 1612) * 100;
      html += '<i style="bottom:' + pos.toFixed(1) + '%">' + vals[i] + '</i>';
    }
    el.gaugeTicks.innerHTML = html;
    // 速度表刻度（半圆：180° -> 360°，圆心 103,92）
    var max = 160, a0 = 180, a1 = 360, CX = 103, CY = 92, t = '';
    for (var v = 0; v <= max; v += 20) {
      var a = (a0 + (v / max) * (a1 - a0)) * Math.PI / 180;
      var ca = Math.cos(a), sa = Math.sin(a);
      t += '<line x1="' + (CX + ca * 64).toFixed(1) + '" y1="' + (CY + sa * 64).toFixed(1) + '" x2="' + (CX + ca * 74).toFixed(1) +
        '" y2="' + (CY + sa * 74).toFixed(1) + '" stroke="rgba(255,255,255,' + (v % 40 === 0 ? '.42' : '.18') + ')" stroke-width="' + (v % 40 === 0 ? 2 : 1) + '"/>';
      if (v % 40 === 0) {
        t += '<text x="' + (CX + ca * 87).toFixed(1) + '" y="' + (CY + sa * 87 + 4).toFixed(1) + '" fill="rgba(255,255,255,.45)" font-size="11" font-weight="600" text-anchor="middle">' + v + '</text>';
      }
    }
    el.speedTicks.innerHTML = t;
    // 弧线
    function arc(r, a0d, a1d) {
      var s = (a0d) * Math.PI / 180, e = (a1d) * Math.PI / 180;
      var x0 = CX + Math.cos(s) * r, y0 = CY + Math.sin(s) * r;
      var x1 = CX + Math.cos(e) * r, y1 = CY + Math.sin(e) * r;
      return 'M' + x0.toFixed(1) + ' ' + y0.toFixed(1) + ' A' + r + ' ' + r + ' 0 ' + (Math.abs(a1d - a0d) > 180 ? 1 : 0) + ' 1 ' + x1.toFixed(1) + ' ' + y1.toFixed(1);
    }
    el.speedArc.setAttribute('d', arc(72, 180, 360));
    el.speedArcFill.setAttribute('d', arc(72, 180, 360));
    el.speedArcFill.style.strokeDasharray = '227';
    el.speedArcFill.style.strokeDashoffset = '227';
    el.theoDist.textContent = THEO.brakeDist.toFixed(0) + ' m';
    el.trackDanger.style.width = ((DANGER / g.roadLen) * 100).toFixed(1) + '%';
  }

  function phaseClass() {
    if (g.phase === 'run' && g.brakeOn) return 'brake';
    if (g.phase === 'accel' || g.phase === 'idle') return 'calm';
    if (g.phase === 'run') return 'go';
    if (g.phase === 'wreck' || g.phase === 'falling' || g.phase === 'lost') return 'bad';
    return 'go';
  }

  function updateUI() {
    var kmh = g.kmh();
    el.speedText.textContent = Math.round(kmh);
    var a = 180 + (Math.min(kmh, 160) / 160) * 180;
    el.needle.setAttribute('transform', 'translate(103,92) rotate(' + a.toFixed(1) + ')');
    el.speedArcFill.style.strokeDashoffset = (227 * (1 - Math.min(kmh, 160) / 160)).toFixed(1);

    el.pedalFill.style.height = (g.pedalPct() * 100).toFixed(1) + '%';
    el.pedalVal.innerHTML = Math.round(g.F) + '<small>N</small>';
    var left = g.holdLeft();
    el.pedalSub.innerHTML = '上限 1612 N<br>剩余可踩 ' + left.toFixed(2) + ' s';
    el.pedalPanel.classList.toggle('broken', g.pedalBroken);
    el.heldText.textContent = g.heldT.toFixed(2) + ' s';
    el.leftText.textContent = Math.max(0, left).toFixed(2) + ' s';

    el.distText.textContent = g.distToCliff().toFixed(1) + ' m';
    var frac = Math.min(1, Math.max(0, g.x / g.roadLen));
    el.trackFill.style.width = (frac * 100).toFixed(2) + '%';
    el.trackCar.style.left = (frac * 100).toFixed(2) + '%';

    // 状态胶囊
    var s = '';
    switch (g.phase) {
      case 'idle': s = '准备就绪 · 点开始'; break;
      case 'accel': s = '加速中 ' + Math.round(kmh) + ' km/h → 待 100'; break;
      case 'run': s = g.brakeOn ? ('刹车中 ' + Math.round(kmh) + ' km/h · 力度 ' + Math.round(g.F) + 'N') : '已到 100 km/h · 该点刹了!'; break;
      case 'wreck': s = g.airborne ? '失控飞出 · 空中翻滚!' : '踏板断裂 · 车辆失控甩尾!'; break;
      case 'falling': s = '冲过崖边 · 坠落中…'; break;
      case 'won': s = '成功刹停'; break;
      case 'lost': s = g.impact ? '撞毁 · 挑战失败' : '坠入悬崖'; break;
    }
    if (g.pedalBroken && g.phase === 'run') s = '踏板断裂! 刹车失效';
    el.status.textContent = s;
    el.status.className = 'pill ' + phaseClass();

    // 刹车按钮
    var locked = !(g.phase === 'run' && !g.pedalBroken);
    el.brakeBtn.disabled = locked;
    el.brakeBtn.classList.toggle('locked', locked);
    el.brakeBtn.classList.toggle('on', g.brakeOn);
    var bt = el.brakeBtn.firstChild;
    var label = g.pedalBroken ? '踏板已断裂' :
      (g.phase === 'accel' || g.phase === 'idle') ? '刹车锁定中' :
      (g.phase === 'falling') ? '坠落中…' :
      (g.phase === 'lost' || g.phase === 'won') ? '本局结束' :
      g.brakeOn ? '刹车中…' : '按住刹车';
    if (bt && bt.nodeType === 3) { if (bt.nodeValue !== label) bt.nodeValue = label; }

    // 踏板面板告警
    el.pedalPanel.classList.toggle('danger', !g.pedalBroken && g.pedalPct() > 0.9);

    // 落点预测 / 行动提示
    var need = predictAt(FEATHER).dist;
    el.needText.textContent = '≈ ' + need.toFixed(0) + ' m';
    if (g.phase === 'idle') {
      el.predictText.innerHTML = '— 开始后自动加速到 100 km/h —';
    } else if (g.phase === 'accel') {
      el.predictText.innerHTML = '— 到 100 km/h 才能踩刹车 —';
    } else if (g.phase === 'run') {
      var margin = g.roadLen - g.x - need;
      if (g.pedalBroken) {
        el.predictText.innerHTML = '<span class="warn">踏板已断裂 · 刹车失效</span>';
      } else if (g.brakeOn && g.pedalPct() > 0.93) {
        el.predictText.innerHTML = '<span class="warn">力度 ' + Math.round(g.F) + ' N —— 快断了，松一下!</span>';
      } else if (g.brakeOn) {
        el.predictText.innerHTML = '刹车中 · 力度 <b>' + Math.round(g.F) + ' N</b> · 还能连踩 <b>' + g.holdLeft().toFixed(2) + ' s</b>';
      } else if (margin >= 0) {
        el.predictText.innerHTML = '<span class="ok">还不算晚</span> · 现在点刹会停在崖前 ' + margin.toFixed(0) + ' m';
      } else {
        el.predictText.innerHTML = '<span class="warn">太晚了</span> · 现在踩要超出 ' + (-margin).toFixed(0) + ' m';
      }
    } else if (g.phase === 'won') {
      el.predictText.innerHTML = '<span class="ok">车头距崖边 ' + g.stopMargin.toFixed(1) + ' m</span>';
    } else if (g.phase === 'wreck') {
      el.predictText.innerHTML = '<span class="warn">车辆失控 · 挑战失败</span>';
    } else if (g.phase === 'falling') {
      el.predictText.innerHTML = '<span class="warn">坠落中 · 挑战失败</span>';
    } else {
      el.predictText.innerHTML = '<span class="warn">没能停下</span>';
    }
  }

  // ---------------------------------------------------------------- 浮层 / 流程
  function openOverlay(html) {
    el.ovPanel.innerHTML = html;
    el.overlay.classList.remove('hide');
    paused = true;
  }
  function closeOverlay() { el.overlay.classList.add('hide'); paused = false; }

  function showStart() {
    openOverlay(
      '<h1>悬崖急刹</h1>' +
      '<p class="lead">前方是悬崖。把 100 km/h 的车刹停 —— 停得越贴边，分越高。</p>' +
      '<ul>' +
      '<li>起步自动加速到 <b>100 km/h</b>，到速后才能踩刹车</li>' +
      '<li>刹车本身很猛(9.2 m/s²)，从 100 刹停总共只需踩住 <b>3.02 秒</b></li>' +
      '<li>可是踏板力度表会随踩住的时间涨：<b>一脚不松 2.86 秒就顶到 1612 N 断裂</b>，之后刹车彻底失效，车直接冲下悬崖</li>' +
      '<li>所以只能<b>点刹</b>：踩住半秒多、松一下让力度回落，反复点，踩够 3.02 秒才停得住</li>' +
      '<li>松手时车不减速：点刹要多滑 15~20 米，<b>得比"一脚踩死"提前开始</b></li>' +
      '<li>目标：停在离崖边 <b>3 米内</b>（满分 100）</li>' +
      '</ul>' +
      '<div class="row"><button class="btn" id="startBtn2">开始游戏</button></div>' +
      '<p class="lead" style="margin:12px 0 0">按住 <span class="kbd">空格</span> 或按住下方红色按钮点刹</p>'
    );
    var b = $('#startBtn2'); if (b) b.onclick = startRound;
  }

  function showResult(win) {
    var margin = g.stopMargin;
    var rk = g.rating;
    var reason = '';
    if (!win) {
      if (g.pedalBroken) reason = '刹车踏板在踩下 ' + g.brokeAtT.toFixed(2) + ' s 累积到 1612 N 后断裂，车速 ' +
        Math.round(g.brokeAtV * 3.6) + ' km/h 时彻底失去制动，车辆随即失控' + (g.impact ? '翻车撞毁。' : '，飞出路面坠入悬崖。');
      else if (g.heldT < 0.05) reason = '全程没有踩刹车，车直接冲出了崖边。';
      else reason = '刹车点太晚：车头越过崖边时还剩 ' + Math.round(g.brakeOn ? 0 : g.v * 3.6) + ' km/h，距离不够。';
    }
    var bestHtml = '';
    if (win && best && best.score === g.score && best.margin === margin) bestHtml = '<div style="font-size:12px;color:#ffd166;margin-bottom:8px">🎉 新纪录</div>';
    openOverlay(
      (win ? '<h2>刹住了！</h2>' : '<h2>坠入悬崖</h2>') +
      (win ?
        '<div class="res-score">' + g.score + '<span style="font-size:16px;color:#93a6bf"> 分</span></div>' +
        '<div class="res-meta"><span class="res-rank">' + rk.key + '</span> ' + rk.name + ' · ' + rk.tip + '<br>' +
        '车头距崖边 <b>' + margin.toFixed(1) + ' m</b>，刹停用了 <b>' + g.heldT.toFixed(2) + ' s</b>，峰值力度 <b>' + Math.round(g.F) + ' N</b></div>'
        : '<div class="res-meta" style="margin-top:12px">' + reason + '</div>') +
      bestHtml +
      '<div class="res-meta">本局：发动机加速度 ' + g.engineA.toFixed(2) + ' m/s²，崖边在 ' + g.roadLen.toFixed(0) + ' m 处' +
      (best ? ' ｜ 历史最佳 <b>' + best.score + ' 分</b>（距崖 ' + best.margin.toFixed(1) + ' m）' : '') + '</div>' +
      '<div class="row"><button class="btn" id="againBtn">再来一局</button>' +
      '<button class="btn ghost" id="rulesBtn">看规则</button></div>'
    );
    var a = $('#againBtn'); if (a) a.onclick = startRound;
    var r = $('#rulesBtn'); if (r) r.onclick = showStart;
  }

  function startRound() {
    Sound.init(); Sound.resume();
    g.reset();
    smoke = []; skid = []; wheelRot = 0; prevPhase = 'idle'; snapFired = false;
    el.trackDanger.style.width = ((DANGER / g.roadLen) * 100).toFixed(1) + '%';
    closeOverlay();
    g.start();
    clampCamera();
  }

  function finish() {
    Sound.skid(0);
    if (g.phase === 'won') {
      Sound.win();
      var sc = { score: g.score, margin: g.stopMargin, at: Date.now() };
      if (!best || sc.score > best.score || (sc.score === best.score && sc.margin < best.margin)) {
        best = sc;
        try { localStorage.setItem('cliffBrakeBest', JSON.stringify(best)); } catch (e) {}
      }
    }
    setTimeout(function () { if (g.isTerminal()) showResult(g.phase === 'won'); },
      g.phase === 'won' ? 650 : (g.impact ? 700 : 450));
  }

  function clampCamera() {
    if (g.phase === 'wreck' || g.phase === 'falling') return;   // 失控/坠落时锁死镜头
    camX = Math.max(-24, g.x - visM * 0.24);
  }

  // ---------------------------------------------------------------- 输入
  var holding = false;
  function press(on) {
    holding = on;
    g.setBrake(on);
    if (on) { Sound.init(); Sound.resume(); }
  }
  el.brakeBtn.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    if (el.brakeBtn.disabled) return;
    try { el.brakeBtn.setPointerCapture(e.pointerId); } catch (err) {}
    press(true);
  });
  window.addEventListener('pointerup', function () { if (holding) press(false); });
  window.addEventListener('pointercancel', function () { if (holding) press(false); });
  window.addEventListener('blur', function () { if (holding) press(false); });
  el.brakeBtn.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  window.addEventListener('keydown', function (e) {
    if (e.code === 'Space' || e.code === 'ArrowDown') {
      e.preventDefault();
      if (g.phase === 'idle' && !el.overlay.classList.contains('hide')) { startRound(); return; }
      if (!el.brakeBtn.disabled && !holding) press(true);
    } else if (e.code === 'Enter') {
      if (g.phase === 'idle' || g.isTerminal()) startRound();
    } else if (e.key === 'm' || e.key === 'M') {
      toggleSound();
    }
  });
  window.addEventListener('keyup', function (e) {
    if (e.code === 'Space' || e.code === 'ArrowDown') { e.preventDefault(); if (holding) press(false); }
  });

  function toggleSound() {
    var on = Sound.toggle();
    el.soundBtn.textContent = on ? '🔊' : '🔇';
  }
  el.soundBtn.addEventListener('click', toggleSound);
  window.addEventListener('resize', function () { resize(); clampCamera(); draw(); });
  if (window.ResizeObserver) new ResizeObserver(function () { resize(); draw(); }).observe(stage);

  // ---------------------------------------------------------------- 主循环
  var lastT = 0, acc = 0;
  function step(dt) {
    var wasPhase = g.phase;
    g.tick(dt);
    if (!g.pedalBroken) wheelRot += g.v * dt / 0.35;   // 抱死后车轮锁死不转

    // 正常刹车：轮胎冒烟 + 刹车痕
    if (g.phase === 'run' && g.brakeOn && g.v > 3) {
      if (Math.random() < 0.55) {
        spawnP(g.x - 1.2 - Math.random() * 3.4, 0.05 + Math.random() * 0.3,
          { vx: -1.2 - Math.random() * 1.6, vy: 0.5, r: 0.16 + Math.random() * 0.2, life: 0.7 + Math.random() * 0.5, grow: 0.5 });
      }
      if (!skid.length || g.x - skid[skid.length - 1] > 1.6) {
        skid.push(g.x - 1.0);
        if (skid.length > 420) skid.shift();
      }
    }
    // 失控第一阶段：抱死甩尾（地面浓烟 + 火花 + 横向擦痕）
    if (g.phase === 'wreck' && !g.airborne) {
      for (var s = 0; s < 2; s++) {
        spawnP(g.x - 1.5 - Math.random() * 3.2, 0.05 + Math.random() * 0.4,
          { vx: -3 - Math.random() * 4, vy: 1 + Math.random() * 2, r: 0.22 + Math.random() * 0.28, life: 0.6 + Math.random() * 0.5, grow: 1.0, col: '190,186,180', alpha: 0.5 });
      }
      if (Math.random() < 0.6) {
        spawnP(g.x - 2 - Math.random() * 2, 0.1 + Math.random() * 0.3,
          { vx: -5 - Math.random() * 6, vy: 2 + Math.random() * 3, r: 0.055, life: 0.25 + Math.random() * 0.2, grow: -0.05, col: '255,196,90', alpha: 0.95 });
      }
      if (!skid.length || g.x - skid[skid.length - 1] > 1.2) {
        skid.push(g.x - 1.2);
        if (skid.length > 420) skid.shift();
      }
    }
    // 失控第二阶段：空中拖尾
    if (g.phase === 'wreck' && g.airborne) {
      if (Math.random() < 0.8) {
        spawnP(g.x - 1.6 - Math.random() * 3, g.yOff + 0.15 + Math.random() * 0.7,
          { vx: -1 - Math.random() * 2, vy: 0.2, r: 0.2 + Math.random() * 0.26, life: 0.5 + Math.random() * 0.4, grow: 0.9, alpha: 0.4 });
      }
    }
    updateSmoke(dt);

    // 音效
    Sound.skid(g.phase === 'wreck' && !g.airborne ? 1 : (g.brakeOn && g.v > 3 ? Math.min(1, g.v / 20) : 0));

    if (flash > 0) flash = Math.max(0, flash - dt * 3.6);

    if (wasPhase !== g.phase) {
      if (g.phase === 'wreck') { Sound.snap(); Sound.crash(); }
      if (g.phase === 'falling') Sound.crash();
      if (g.phase === 'lost' && g.impact) {
        // 撞地：白闪 + 尘爆
        Sound.impact();
        flash = 1;
        for (var k = 0; k < 34; k++) {
          var ang = Math.random() * Math.PI, sp = 2 + Math.random() * 7;
          spawnP(g.x - 2.3, 0.1 + Math.random() * 0.5, {
            vx: (Math.random() < 0.5 ? -1 : 1) * Math.cos(ang) * sp,
            vy: Math.abs(Math.sin(ang)) * sp * 0.7,
            r: 0.25 + Math.random() * 0.5, life: 0.7 + Math.random() * 0.8, grow: 1.4,
            col: '176,166,150', alpha: 0.55
          });
        }
      }
      if (g.isTerminal()) finish();
      prevPhase = g.phase;
    }
    // 断裂：力度表面板闪红（一次性）
    if (g.pedalBroken && !snapFired) {
      snapFired = true;
      el.pedalPanel.classList.remove('flash');
      void el.pedalPanel.offsetWidth;
      el.pedalPanel.classList.add('flash');
    }
  }

  function loop(now) {
    if (!runLoop) return;
    requestAnimationFrame(loop);
    var dt = (now - lastT) / 1000;
    lastT = now;
    if (!(dt > 0) || dt > 0.3) dt = 0.016;
    if (!paused) {
      acc += dt;
      var n = 0;
      while (acc >= 1 / 120 && n < 48) { step(1 / 120); acc -= 1 / 120; n++; }
      if (n >= 48) acc = 0;
      clampCamera();
    } else {
      // 浮层期间也让尘烟慢慢消失
      updateSmoke(dt * 0.6);
    }
    updateUI();
    draw(now / 1000);
  }

  // ---------------------------------------------------------------- 自检
  /* 脚本驱动一局：从 brakeX 起按 h 踩 / r 松的点刹节奏 */
  function simScript(opt, brakeX, h, r, maxT) {
    g.reset(opt);
    g.start();
    smoke = []; skid = []; wheelRot = 0; snapFired = false;
    var dt = 1 / 120, n = 0, t0 = null, drawErr = null;
    while (!g.isTerminal() && n * dt < (maxT || 60)) {
      var on = false;
      if (g.phase === 'run' && g.x >= brakeX) {
        if (t0 === null) t0 = g.t;
        on = h == null ? true : ((g.t - t0) % (h + r)) < h;
      }
      g.setBrake(on);
      step(dt);
      if (n % 7 === 0) {
        try { clampCamera(); updateUI(); draw(n * dt); } catch (e) { if (!drawErr) drawErr = String(e && e.message || e); }
      }
      n++;
    }
    try { clampCamera(); updateUI(); draw(0); } catch (e) { if (!drawErr) drawErr = String(e && e.message || e); }
    return { drawErr: drawErr, frames: n };
  }

  /* 只跑物理，量出"从 startX 起按 h 踩 / r 松"的点刹刹车距离（崖边放很远，不会掉下去） */
  function probeFeatherDist(startX, h, r) {
    g.reset({ engineA: 5.5, roadLen: 1e6 }); g.start();
    var dt = 1 / 120, n = 0, t0 = null;
    while (!g.isTerminal() && n * dt < 40) {
      var on = false;
      if (g.phase === 'run' && g.x >= startX) {
        if (t0 === null) t0 = g.t;
        on = ((g.t - t0) % (h + r)) < h;
      }
      g.setBrake(on); g.tick(dt); n++;
    }
    return g.x - startX;
  }

  window.__selftest = function () {
    var rep = { ok: true, err: [], checks: {} };
    try {
      runLoop = false; paused = false;

      // 1) 点刹(0.6/0.3) 从 120m 起 -> 应成功（崖边按实测刹车距离摆放，免得数值一调测试就假红）
      var probe = probeFeatherDist(120, 0.6, 0.3);
      var A = simScript({ engineA: 5.5, roadLen: 120 + probe + 1 }, 120, 0.6, 0.3);
      rep.checks.feather = { brakeDist: +probe.toFixed(1), phase: g.phase, margin: g.stopMargin, score: g.score, Fpeak: Math.round(g.F), drawErr: A.drawErr };

      // 2) 一脚踩到底 -> 踏板断裂 -> 坠落
      g.reset({ engineA: 5.5, roadLen: 240 }); g.start();
      var broke = null, k = 0;
      while (!g.isTerminal() && k < 120 * 60) {
        g.setBrake(g.phase === 'run' && g.x >= 120);
        step(1 / 120);
        if (g.pedalBroken && !broke) broke = { t: g.t, F: Math.round(g.F), v: +(g.v * 3.6).toFixed(1) };
        k++;
      }
      rep.checks.fullHold = {
        broke: broke, phase: g.phase,
        afterBreak: broke ? +(g.t - broke.t).toFixed(2) : null,
        events: g.events.map(function (e) { return e.type; }).join(',')
      };

      // 3) 完全不刹车 -> 坠崖
      var C = simScript({ engineA: 5.5, roadLen: 300 }, 1e9, null, null, 40);
      var noBrakePhase = g.phase;
      rep.checks.noBrake = { phase: noBrakePhase, drawErr: C.drawErr };

      // 4) 渲染像素非空
      try {
        var img = ctx.getImageData(0, 0, Math.min(W, 240), Math.min(H, 160)).data;
        var set = 0, sum = 0;
        for (var i = 0; i < img.length; i += 4) { if (img[i + 3] > 0) set++; sum += img[i] + img[i + 1] + img[i + 2]; }
        rep.checks.pixels = { nonEmpty: set, avg: +(sum / Math.max(1, set)).toFixed(1) };
      } catch (e) { rep.err.push('pixel:' + e.message); }

      rep.checks.dom = {
        speed: el.speedText.textContent, dist: el.distText.textContent,
        need: el.needText.textContent, pedal: el.pedalVal.textContent,
        status: el.status.textContent, predict: el.predictText.textContent,
        brakeDisabled: el.brakeBtn.disabled, ticks: el.gaugeTicks.children.length,
        overlayShown: !el.overlay.classList.contains('hide')
      };
      rep.checks.theo = THEO;

      // 5) 真实输入通路：键盘 + 指针事件
      runLoop = false;
      el.overlay.style.transition = 'none';
      g.reset({ engineA: 5.5, roadLen: 300 }); closeOverlay(); g.start();
      var k = 0;
      while (g.phase === 'accel' && k < 120 * 20) { step(1 / 120); k++; }
      updateUI();                        // 真实游戏里每帧都会刷新按钮可用态
      rep.checks.input = { phase: g.phase, btnDisabled: el.brakeBtn.disabled };
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
      rep.checks.input.keyBrake = g.brakeInput;
      for (var q = 0; q < 120; q++) step(1 / 120);
      rep.checks.input.FAfter1s = Math.round(g.F);
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
      rep.checks.input.keyRelease = g.brakeInput === false;
      el.brakeBtn.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, bubbles: true, cancelable: true }));
      rep.checks.input.btnPress = g.brakeInput;
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
      rep.checks.input.btnRelease = g.brakeInput === false;
      if (!rep.checks.input.keyBrake) { rep.ok = false; rep.err.push('空格键未触发刹车'); }
      if (!(rep.checks.input.FAfter1s > 350)) { rep.ok = false; rep.err.push('按住1秒力度异常: ' + rep.checks.input.FAfter1s); }
      if (!rep.checks.input.keyRelease) { rep.ok = false; rep.err.push('松键未释放刹车'); }
      if (!rep.checks.input.btnPress) { rep.ok = false; rep.err.push('按钮 pointerdown 未触发刹车'); }
      if (!rep.checks.input.btnRelease) { rep.ok = false; rep.err.push('按钮 pointerup 未释放刹车'); }

      // 6) 结算面板 + 重开（最常点的路径）
      try {
        g.stopMargin = 2.5; g.score = 97; g.rating = window.carRating(97); g.heldT = 3.5;
        showResult(true);
        var wLen = el.ovPanel.innerHTML.length;
        showResult(false);
        var lLen = el.ovPanel.innerHTML.length;
        startRound();
        rep.checks.flow = { winHtml: wLen, loseHtml: lLen, restartPhase: g.phase, overlayHidden: el.overlay.classList.contains('hide') };
        if (g.phase !== 'accel') { rep.ok = false; rep.err.push('重开未进入 accel: ' + g.phase); }
        if (!(wLen > 200 && lLen > 120)) { rep.ok = false; rep.err.push('结算面板内容异常'); }
      } catch (e) { rep.ok = false; rep.err.push('结算/重开异常:' + (e && e.message || e)); }

      if (!(noBrakePhase === 'lost')) { rep.ok = false; rep.err.push('不刹车应坠崖'); }
      if (rep.checks.feather.phase !== 'won') { rep.ok = false; rep.err.push('点刹应刹停: ' + rep.checks.feather.phase); }
      if (!broke) { rep.ok = false; rep.err.push('一脚不松应断裂'); }
      if (rep.checks.fullHold.phase !== 'lost') { rep.ok = false; rep.err.push('断裂后应坠崖/撞毁'); }
      if (!(rep.checks.fullHold.afterBreak != null && rep.checks.fullHold.afterBreak < 3.5)) {
        rep.ok = false; rep.err.push('断裂后结束太慢: ' + rep.checks.fullHold.afterBreak + 's');
      }
      if (rep.checks.fullHold.events.indexOf('air') < 0) { rep.ok = false; rep.err.push('缺少弹射飞出动画'); }
      if (A.drawErr || C.drawErr) { rep.ok = false; rep.err.push('渲染异常:' + (A.drawErr || C.drawErr)); }
      if (!rep.checks.pixels || rep.checks.pixels.nonEmpty < 100) { rep.ok = false; rep.err.push('画布空白'); }
      if (!(rep.checks.dom.ticks >= 5)) { rep.ok = false; rep.err.push('刻度未生成'); }
      if (!rep.checks.dom.need || rep.checks.dom.need.indexOf('m') < 0) { rep.ok = false; rep.err.push('needText 未更新'); }
    } catch (e) {
      rep.ok = false; rep.err.push('exception:' + (e && e.stack || e));
    }
    var str = JSON.stringify(rep);
    el.selftest.textContent = str;
    try { document.title = (rep.ok ? 'SELFTEST-OK ' : 'SELFTEST-FAIL ') + str.slice(0, 300); } catch (e) {}
    return rep;
  };

  // ---------------------------------------------------------------- 调试快照 (仅 ?shot=xxx 时启用)
  function debugShot(mode) {
    runLoop = false; paused = false;
    var dt = 1 / 120;
    function adv(n) { for (var i = 0; i < n; i++) step(dt); }
    function until(cond, maxT) { var k = 0; while (!cond() && k * dt < (maxT || 60)) { step(dt); clampCamera(); k++; } }
    function featherRun(startX, stopCond) {
      until(function () { return g.phase === 'run' && g.x >= startX; }, 30);
      var t0 = g.t, k = 0;
      while (!stopCond() && k * dt < 30) {
        g.setBrake(((g.t - t0) % 0.9) < 0.6);
        step(dt); k++;
      }
    }
    if (mode === 'start') { /* 起始界面 */ }
    else if (mode === 'accel') {
      g.reset({ engineA: 5.5, roadLen: 300 }); g.start();
      until(function () { return g.kmh() > 82; }, 20);
    } else if (mode === 'braking') {
      g.reset({ engineA: 5.5, roadLen: 300 }); g.start();
      featherRun(150, function () { return g.kmh() < 50; });
    } else if (mode === 'breaking') {
      g.reset({ engineA: 5.5, roadLen: 300 }); g.start();
      until(function () { return g.x >= 150; }, 20);
      g.setBrake(true);
      until(function () { return g.pedalBroken; }, 20);
      adv(20);
    } else if (mode === 'wreck') {
      g.reset({ engineA: 5.5, roadLen: 300 }); g.start();
      until(function () { return g.x >= 150; }, 20);
      g.setBrake(true);
      until(function () { return g.pedalBroken; }, 20);
      adv(24);                                   // 抱死甩尾中
    } else if (mode === 'air') {
      g.reset({ engineA: 5.5, roadLen: 300 }); g.start();
      until(function () { return g.x >= 150; }, 20);
      g.setBrake(true);
      until(function () { return g.pedalBroken; }, 20);
      adv(100);                                  // 已弹射腾空(接近最高点)
    } else if (mode === 'impact') {
      g.reset({ engineA: 5.5, roadLen: 300 }); g.start();
      until(function () { return g.x >= 150; }, 20);
      g.setBrake(true);
      until(function () { return g.pedalBroken; }, 20);
      until(function () { return g.phase === 'lost'; }, 10);
      adv(6);                                    // 撞地瞬间
    } else if (mode === 'fall') {
      g.reset({ engineA: 5.5, roadLen: 190 }); g.start();
      until(function () { return g.phase === 'falling'; }, 40);   // 不刹车，直接冲出崖边
      adv(34);
    } else if (mode === 'win') {
      var dw = probeFeatherDist(150, 0.6, 0.3);                   // 先量点刹距离，再摆崖边
      g.reset({ engineA: 5.5, roadLen: 150 + dw + 1.2 }); g.start();
      featherRun(150, function () { return g.isTerminal(); });
    }
    if (mode !== 'start') {
      el.overlay.style.transition = 'none';
      closeOverlay();
    }
    clampCamera(); updateUI(); draw(1);
  }

  // ---------------------------------------------------------------- 启动
  function boot() {
    resize();
    buildGauges();
    updateUI();
    draw();
    showStart();
    lastT = performance.now();
    requestAnimationFrame(loop);
    var m = /shot=([a-z]+)/.exec(location.search);
    if (m) { try { debugShot(m[1]); } catch (e) { el.selftest.textContent = 'shot error: ' + (e && e.stack || e); } }
    else if (/selftest=1/.test(location.search)) { window.__selftest(); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
