/* 悬崖急刹 — 纯物理内核验证（在真实浏览器里跑，输出到 #out 供 --dump-dom 抓取） */
(function () {
  'use strict';
  var L = [], pass = 0, fail = 0;
  function log(s) { L.push(s); }
  function ok(c, m) { if (!c) throw new Error(m || 'assert failed'); }
  function near(a, b, tol, m) { ok(Math.abs(a - b) <= tol, (m || '') + ' got=' + (+a).toFixed(3) + ' want=' + (+b).toFixed(3) + ' +-' + tol); }
  function T(name, fn) {
    try { var r = fn(); pass++; log('  PASS  ' + name + (r ? '   ' + r : '')); }
    catch (e) { fail++; log('  FAIL  ' + name + '  -> ' + (e && e.message || e)); }
  }

  var CFG = CAR_CFG, THEO = carTheoretical();
  var DT = 1 / 120;

  /* 驱动一局：policy(g) -> 是否踩刹车 */
  function simulate(cfg, opt, policy, maxT) {
    var g = new CarGame(cfg); g.reset(opt); g.start();
    var n = 0, tmax = maxT || 60;
    while (!g.isTerminal() && n * DT < tmax) { g.setBrake(policy ? !!policy(g) : false); g.tick(DT); n++; }
    return g;
  }
  function run(opt, policy, maxT) { return simulate(null, opt, policy, maxT); }

  function holdFrom(x) { return function (g) { return g.phase === 'run' && g.x >= x; }; }
  function rhythm(x, h, r) {
    var t0 = null, cyc = h + r;
    return function (g) {
      if (g.phase !== 'run' || g.x < x) { t0 = null; return false; }
      if (t0 === null) t0 = g.t;
      return ((g.t - t0) % cyc) < h;
    };
  }
  function adaptive(x, hi, lo) {
    var pin = false;
    return function (g) {
      if (g.phase !== 'run' || g.x < x) { pin = false; return false; }
      if (g.F >= hi) pin = true; else if (g.F <= lo) pin = false;
      return !pin;
    };
  }
  function ev(g, type) { return g.events.filter(function (e) { return e.type === type; })[0]; }

  log('=== 悬崖急刹 物理验证 ===');
  log('配置 brakeDecel=' + CFG.brakeDecel + ' forceRamp=' + CFG.forceRamp + ' forceDecay=' + CFG.forceDecay + ' forceBreak=' + CFG.forceBreak);
  log('理论: 刹停需按住 ' + THEO.holdToStop.toFixed(3) + 's ｜ 一脚不松 ' + THEO.rampToBreak.toFixed(3) + 's 就断 ｜ 理想刹停距离 ' + THEO.brakeDist.toFixed(1) + 'm');
  log('理论: mustFeather=' + THEO.mustFeather + ' 时间缺口=' + THEO.shortfall.toFixed(3) + 's 最少累计松手=' + THEO.minRelease.toFixed(2) + 's');
  log('');

  log('--- 关键性质 ---');
  T('一脚踩到底必然断裂（玩法成立的前提）', function () {
    ok(THEO.rampToBreak < THEO.holdToStop, '断裂时间必须短于刹停时间');
    return '断裂 ' + THEO.rampToBreak.toFixed(2) + 's < 刹停 ' + THEO.holdToStop.toFixed(2) + 's';
  });
  T('加速到 100km/h 后定速巡航', function () {
    var g = simulate(null, { engineA: 5, roadLen: 5000 }, null);
    ok(g.phase === 'run', 'phase=' + g.phase);
    var v0 = CFG.kmhCruise / 3.6;
    var cru = ev(g, 'cruise');
    near(cru.t, v0 / 5, 0.03, '到速时刻');
    near(g.v, v0, 1e-9, '巡航速度');
    near(g.cruiseX, 8 + v0 * v0 / (2 * 5), 0.8, '到速位置');
    return 't=' + cru.t.toFixed(2) + 's x=' + g.cruiseX.toFixed(1) + 'm v=' + (g.v * 3.6).toFixed(1) + 'km/h';
  });
  T('加速阶段刹车无效（按钮锁定）', function () {
    var g = new CarGame(); g.reset({ engineA: 5, roadLen: 5000 }); g.start();
    for (var i = 0; i < 300; i++) { g.setBrake(true); g.tick(DT); }
    ok(g.phase === 'accel', 'phase=' + g.phase);
    ok(g.F === 0 && g.heldT === 0, '力度/按住时间应为 0，实际 ' + g.F + '/' + g.heldT);
    return 'F=0 heldT=0';
  });
  T('松手力度回落', function () {
    var g = new CarGame(); g.reset({ engineA: 5, roadLen: 5000 }); g.start();
    while (g.phase !== 'run') g.tick(DT);
    for (var i = 0; i < 120; i++) { g.setBrake(true); g.tick(DT); }
    var f1 = g.F; ok(Math.abs(f1 - CFG.forceRamp) < 5, '踩 1s 力度约 ' + CFG.forceRamp + '，实际 ' + f1.toFixed(1));
    for (var j = 0; j < 120; j++) { g.setBrake(false); g.tick(DT); }
    near(g.F, f1 - CFG.forceDecay, 5, '松 1s 后力度');
    return f1.toFixed(0) + 'N -> ' + g.F.toFixed(0) + 'N';
  });

  log('');
  log('--- 各种死法可达性 ---');
  T('不刹车 -> 坠崖', function () {
    var g = run({ engineA: 5.5, roadLen: 300 }, null);
    ok(g.phase === 'lost', 'phase=' + g.phase);
    return 'phase=lost';
  });
  T('一脚踩到底 -> 踏板断裂（车仍在动）-> 滚下悬崖', function () {
    var g = run({ engineA: 5.5, roadLen: 190 }, holdFrom(120), 90);
    var br = ev(g, 'break');
    ok(g.pedalBroken && br, '应断裂');
    ok(br.v > 0.5, '断裂时车应仍在行驶，实际 ' + (br.v * 3.6).toFixed(2) + 'km/h');
    ok(g.phase === 'lost', '断裂后应坠崖，实际 ' + g.phase);
    return '断裂时已按住 ' + (br.F / CFG.forceRamp).toFixed(2) + 's ｜ v=' + (br.v * 3.6).toFixed(1) + 'km/h F=' + br.F.toFixed(0) + 'N';
  });
  T('太晚刹车 -> 刹不住 -> 坠崖', function () {
    var g = run({ engineA: 5.5, roadLen: 300 }, holdFrom(285), 60);
    ok(g.phase === 'lost', 'phase=' + g.phase);
    return 'phase=lost';
  });

  log('');
  log('--- 点刹策略可行性（刹车起点 x=120m） ---');
  var cands = [
    ['一脚不松', holdFrom(120)],
    ['点刹 0.6/0.3', rhythm(120, 0.6, 0.3)],
    ['点刹 0.5/0.25', rhythm(120, 0.5, 0.25)],
    ['点刹 0.8/0.4', rhythm(120, 0.8, 0.4)],
    ['点刹 0.4/0.2', rhythm(120, 0.4, 0.2)],
    ['自适应 顶1580/松1500', adaptive(120, 1580, 1500)],
    ['自适应 顶1560/松1430', adaptive(120, 1560, 1430)],
    ['自适应 顶1500/松1350', adaptive(120, 1500, 1350)]
  ];
  var results = [];
  cands.forEach(function (c) {
    var g = run({ engineA: 5.5, roadLen: 900 }, c[1], 90);
    var r = { label: c[0], phase: g.phase, x: g.x, dist: g.x - 120, Fpeak: 0, heldT: g.heldT, t: g.t, broken: g.pedalBroken };
    var mx = 0; // 峰值力度（用事件+终值近似）
    r.Fpeak = Math.max(g.F, 0);
    results.push(r);
    log('  ' + c[0] + '  '.repeat(Math.max(1, 22 - c[0].length)) +
      'phase=' + g.phase + '  停点=' + g.x.toFixed(1) + 'm  刹车距离=' + (g.phase === 'won' ? r.dist.toFixed(1) + 'm' : '--') +
      '  末力度=' + g.F.toFixed(0) + 'N  累计踩=' + g.heldT.toFixed(2) + 's  用时=' + g.t.toFixed(2) + 's');
  });
  var works = results.filter(function (r) { return r.phase === 'won'; });

  T('存在能刹停的点刹节奏', function () {
    ok(works.length > 0, '没有任何策略能刹停：' + results.map(function (r) { return r.label + '=' + r.phase; }).join(', '));
    return '可用: ' + works.map(function (r) { return r.label; }).join(' , ');
  });
  T('一脚不松必定失败（不能一直按着）', function () {
    var h = results[0];
    ok(h.broken, '一脚不松应断裂');
    ok(h.phase !== 'won', '一脚不松不该能刹停，实际 ' + h.phase);
    return '断裂后滚下悬崖（' + h.phase + '）';
  });
  T('踏板断裂后迅速判负（不再慢慢溜车等半天）', function () {
    var g = run({ engineA: 5.5, roadLen: 900 }, holdFrom(120), 90);
    var br = ev(g, 'break');
    ok(br, '应断裂');
    ok(g.phase === 'lost', '应已判负，实际 ' + g.phase);
    var dt = g.t - br.t;
    ok(dt < 3.5, '断裂到结束耗时 ' + dt.toFixed(2) + 's，太久');
    var types = g.events.map(function (e) { return e.type; });
    ok(types.indexOf('wreck') >= 0 && types.indexOf('air') >= 0, '缺少失控/弹射事件: ' + types.join(','));
    return '断裂后 ' + dt.toFixed(2) + 's 结束（失控甩尾->弹射飞出->撞毁），事件=' + types.join(',');
  });
  T('低速断裂也会飞出去（不是慢慢溜）', function () {
    var g = run({ engineA: 5.5, roadLen: 900 }, holdFrom(120), 90);
    var br = ev(g, 'break');
    ok(br.v < 8 / 3.6, '本局断裂时应当很慢(' + (br.v * 3.6).toFixed(1) + 'km/h)');
    ok(g.phase === 'lost' && g.t - br.t < 3.5, '低速断裂也必须很快结束');
    return '断裂速度 ' + (br.v * 3.6).toFixed(1) + ' km/h，动画照常播出';
  });

  if (works.length) {
    var dmin = Math.min.apply(null, works.map(function (r) { return r.dist; }));
    var dmax = Math.max.apply(null, works.map(function (r) { return r.dist; }));
    log('  => 可行点刹的刹车距离区间: ' + dmin.toFixed(1) + ' ~ ' + dmax.toFixed(1) + ' m（理想一脚 ' + THEO.brakeDist.toFixed(1) + ' m）');
  }

  log('');
  log('--- 贴边判定 / 评分 / 预测 ---');
  T('在刹车距离刚好位置开始点刹 -> 停稳且贴边', function () {
    ok(works.length > 0, '无可用策略');
    var W = works[works.length - 1];   // 取自适应，最可复现
    var g = run({ engineA: 5.5, roadLen: 120 + W.dist + 0.8 }, adaptive(120, 1580, 1500), 90);
    ok(g.phase === 'won', 'phase=' + g.phase);
    ok(g.stopMargin >= 0 && g.stopMargin < 10, 'margin=' + g.stopMargin);
    return 'margin=' + g.stopMargin.toFixed(2) + 'm score=' + g.score + ' rank=' + g.rating.key;
  });
  T('刹太早 -> 停住了但低分', function () {
    var g = run({ engineA: 5.5, roadLen: 330 }, rhythm(100, 0.6, 0.3), 90);
    ok(g.phase === 'won', 'phase=' + g.phase);
    ok(g.score <= 45, 'score=' + g.score);
    return 'margin=' + g.stopMargin.toFixed(1) + 'm score=' + g.score + ' rank=' + g.rating.key;
  });
  T('车头越过崖边 -> 坠落 -> lost', function () {
    var g = run({ engineA: 5.5, roadLen: 300 }, holdFrom(292), 60);
    var f = ev(g, 'fall');
    ok(f, '应有 fall 事件');
    ok(g.phase === 'lost', 'phase=' + g.phase);
    return 'fall@x=' + f.x.toFixed(1) + 'm -> lost';
  });
  T('predict() 与 tick() 物理一致（关掉断裂）', function () {
    var cfg = { forceBreak: 1e9 };
    var g = new CarGame(cfg); g.reset({ engineA: 5.5, roadLen: 900 }); g.start();
    while (g.phase !== 'run') g.tick(DT);
    g.setBrake(true); g.tick(DT);
    var pr = g.predict();
    var g2 = simulate(cfg, { engineA: 5.5, roadLen: 900 }, holdFrom(0), 90);
    ok(g2.phase === 'won', 'forceBreak 关掉后应能刹停，实际 ' + g2.phase);
    near(pr.stopX, g2.x, 1.5, '预测停点 vs 实际停点');
    near(pr.dist, THEO.brakeDist, 2, '预测刹车距离');
    near(pr.needN, CFG.forceRamp * THEO.holdToStop, 60, '预测所需力度(粗)');
    return 'stopX=' + pr.stopX.toFixed(1) + ' 实际=' + g2.x.toFixed(1);
  });
  T('评分档位正确', function () {
    ok(carRating(100).key === 'S' && carRating(97).key === 'S', 'S');
    ok(carRating(90).key === 'A' && carRating(80).key === 'B', 'A/B');
    ok(carRating(50).key === 'C' && carRating(10).key === 'D', 'C/D');
    return 'S/A/B/C/D ok';
  });
  T('边界：速度极低时不会越界/负值', function () {
    var g = new CarGame(); g.reset({ engineA: 5.5, roadLen: 900 }); g.start();
    for (var i = 0; i < 20000; i++) { g.setBrake(false); g.tick(DT); }
    ok(g.v >= 0 && g.F >= 0 && isFinite(g.x), 'v=' + g.v + ' F=' + g.F + ' x=' + g.x);
    return 'v=' + (g.v * 3.6).toFixed(1) + 'km/h F=' + g.F.toFixed(0);
  });

  log('');
  log('=== ' + pass + ' passed, ' + fail + ' failed ===');
  document.getElementById('out').textContent = L.join('\n');
  document.title = (fail === 0 ? 'VERIFY-OK ' : 'VERIFY-FAIL ') + pass + '/' + (pass + fail);
  window.__verify = { pass: pass, fail: fail, log: L };
})();
