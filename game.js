/*!
 * 悬崖急刹 (Cliff Brake) — 物理内核
 * 纯逻辑，无 DOM / Canvas 依赖，可被测试脚本直接驱动。
 *
 * 规则：
 *   1) 车从起点静止，以 engineA 加速，到 100km/h 后进入巡航(定速)。
 *   2) 到 100km/h 后才允许踩刹车（之前按钮锁定）。
 *   3) 刹车生效期间给车一个固定减速度 brakeDecel（9.2 m/s²，≈0.94g 真车感）。
 *   4) 踏板力度随"按住刹车的累计时间"以 forceRamp 累积；松开后以 forceDecay 回落。
 *      力度到 forceBreak(1612N) 踏板断裂：立刻判负，并播放"失控甩尾→弹射飞出→空中翻滚→
 *      落地撞毁 / 飞过崖边坠入峡谷"的动画（不再让车慢慢溜到崖边，省掉等待）。
 *   5) 车头(x) 越过 roadLen 即坠崖；在越过之前速度归零 = 成功刹停。
 *
 * 数值设计的核心（决定了游戏是否"真的能玩"）：
 *   · 从 100km/h 刹停需要按住 3.02 s（v0/brakeDecel = 27.78/9.2）。
 *   · 力度表上限 1612N ÷ 564N/s = 2.86 s —— 比 3.02 s 短！
 *   => 一脚踩到底必然在刹停前 0.16 秒断裂、车随即冲下悬崖。
 *   => 唯一活路是"点刹"：踩 ~0.6s / 松 ~0.3s，让力度表反复回落，
 *      累计踩够 3.02 s 才能停下。松手期间车不减速，所以要提前开始点刹。
 *   （速度从 120 改成 100 时，forceRamp/forceDecay 按 564/204 同比例缩放，
 *     保证"一脚不松必断"这条前提仍然成立；roadLen 按 v² 缩放，反应窗口手感不变。）
 *   注意：若把减速度改成"正比于累积力度"，则刹停与断裂会在数学上互斥
 *   （让力度涨到 1612N 所需的最小冲量恒大于把车从 100 刹停所需冲量），
 *   所以减速度必须取固定值。
 */
(function (global) {
  'use strict';

  var CFG = {
    carStartX: 8,        // m，车头初始位置
    carLen: 4.6,         // m，车长(仅用于绘图/悬空判定)
    roadLenMin: 200,     // m，悬崖位置随机区间
    roadLenMax: 245,
    kmhCruise: 100,      // 巡航速度（也是解锁刹车的门槛）
    engineMin: 4.5,      // m/s^2，本局发动机加速度随机区间
    engineMax: 6.0,
    brakeDecel: 9.2,     // m/s^2，刹车减速度(固定)
    forceRamp: 564,      // N/s，按住时踏板力度累积速率
    forceDecay: 204,     // N/s，松开时力度回落速率
    forceBreak: 1612,    // N，踏板断裂阈值
    stopEps: 0.12,       // m/s，判定"已停稳"
    fallGravity: 20,     // m/s^2，坠崖动画重力
    fallingMaxT: 1.9     // s，坠崖动画时长（够走出画面即可，别拖时间）
  };

  var RATINGS = [
    { min: 97, key: 'S', name: '神之刹停', tip: '车头几乎悬在崖边，一脚定乾坤' },
    { min: 90, key: 'A', name: '贴边急刹', tip: '险到骨子里' },
    { min: 75, key: 'B', name: '干脆利落', tip: '稳、准、狠' },
    { min: 40, key: 'C', name: '安全稳妥', tip: '停住了，但还能再冒险一点' },
    { min: 0, key: 'D', name: '过于保守', tip: '刹太早，白瞎了这一段路' }
  ];

  function rand(a, b) { return a + Math.random() * (b - a); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /** 理论值（解析解），供 UI 提示与测试使用 */
  function theoretical(cfg) {
    var c = Object.assign({}, CFG, cfg || {});
    var v0 = c.kmhCruise / 3.6;
    var holdToStop = v0 / c.brakeDecel;             // 刹停需要按住的总时间
    var brakeDist = v0 * v0 / (2 * c.brakeDecel);   // 一脚不松的刹停距离(理想)
    var rampToBreak = c.forceBreak / c.forceRamp;   // 一脚不松多久断裂
    var maxHold = Math.min(rampToBreak, holdToStop);
    return {
      holdToStop: holdToStop,       // 3.62 s
      brakeDist: brakeDist,         // 60.4 m
      rampToBreak: rampToBreak,     // 3.43 s —— 小于 holdToStop 才有戏
      maxHold: maxHold,
      mustFeather: rampToBreak < holdToStop,
      shortfall: holdToStop - rampToBreak,                       // 需要靠松手补回的时间
      minRelease: (c.forceRamp * holdToStop - c.forceBreak) / c.forceDecay  // 最少累计松手时间
    };
  }

  function CarGame(cfg) {
    this.cfg = Object.assign({}, CFG, cfg || {});
    this.reset();
  }

  CarGame.prototype.reset = function (opt) {
    opt = opt || {};
    var c = this.cfg;
    this.vCruise = opt.vCruise != null ? opt.vCruise : c.kmhCruise / 3.6;
    this.roadLen = opt.roadLen != null ? opt.roadLen : rand(c.roadLenMin, c.roadLenMax);
    this.engineA = opt.engineA != null ? opt.engineA : rand(c.engineMin, c.engineMax);

    this.x = opt.carStartX != null ? opt.carStartX : c.carStartX; // 车头位置(m)
    this.v = 0;              // m/s
    this.t = 0;              // s，本局已运行时间
    this.F = 0;              // N，踏板力度表读数
    this.heldT = 0;          // s，累计按住刹车时间
    this.brakeInput = false; // 玩家当前是否按着按钮
    this.brakeOn = false;    // 本帧刹车是否实际生效
    this.pedalBroken = false;
    this.brokeAtT = null;
    this.brokeAtV = null;
    this.phase = 'idle';     // idle | accel | run | wreck | falling | won | lost
    this.yOff = 0;           // m，离地高度(坠落/腾空)
    this.fallVy = 0;
    this.fallRot = 0;
    this.fallVr = 0;
    this.fallT = 0;
    this.wreckT = 0;         // 失控动画计时
    this.wreckDir = 1;       // 甩尾方向
    this.airborne = false;
    this.impact = false;     // 是否撞地收场(区别于坠入峡谷)
    this.rot = 0;            // 车身翻滚角(2D 视图用)
    this.rotYaw = 0;         // 偏航(地面甩尾, 3D 视图用)
    this.rotPitch = 0;       // 俯仰(空中翻滚, 3D 视图用)
    this.rotLaunch = 0;      // 起飞瞬间已累计的转角
    this.launchX = 0;        // 失控滑行速度(动画用)
    this.shake = 0;
    this.stopMargin = null;  // m，停稳后车头距崖边距离
    this.score = null;
    this.rating = null;
    this.cruiseX = null;     // 达到 100km/h 时的位置
    this.events = [];
    return this;
  };

  CarGame.prototype.pushEvent = function (type) {
    this.events.push({ t: Math.round(this.t * 1000) / 1000, type: type, x: this.x, v: this.v, F: this.F });
    if (this.events.length > 64) this.events.shift();
  };

  CarGame.prototype.start = function () {
    if (this.phase === 'idle' || this.phase === 'won' || this.phase === 'lost') {
      if (this.phase !== 'idle') this.reset();
      this.phase = 'accel';
      this.pushEvent('start');
    }
    return this;
  };

  CarGame.prototype.setBrake = function (on) {
    this.brakeInput = !!on;
    return this;
  };

  CarGame.prototype.tick = function (dt) {
    var c = this.cfg;
    if (!(dt > 0)) return this;
    dt = Math.min(dt, 0.05);
    if (this.phase === 'idle' || this.phase === 'won' || this.phase === 'lost') {
      if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 1.5);
      return this;
    }
    this.t += dt;

    if (this.phase === 'accel') {
      this.v += this.engineA * dt;
      if (this.v >= this.vCruise) {
        this.v = this.vCruise;
        this.phase = 'run';
        this.cruiseX = this.x;
        this.pushEvent('cruise');
      }
    } else if (this.phase === 'run') {
      this.brakeOn = !!(this.brakeInput && !this.pedalBroken);
      if (this.brakeOn) {
        this.heldT += dt;
        this.F = Math.min(c.forceBreak, this.F + c.forceRamp * dt);
        this.v = Math.max(0, this.v - c.brakeDecel * dt);
        if (this.F >= c.forceBreak) {           // 踏板断裂 -> 立即失控
          this.pedalBroken = true;
          this.brokeAtT = this.t;
          this.brokeAtV = this.v;
          this.pushEvent('break');
          this.startWreck();
        }
      } else if (!this.pedalBroken && this.F > 0) {
        // 松开踏板：力度回落（断裂后仪表冻结）
        this.F = Math.max(0, this.F - c.forceDecay * dt);
      }
    } else if (this.phase === 'wreck') {
      this.wreckT += dt;
      var w = this.wreckT;
      if (!this.airborne) {
        // 一、抱死甩尾（还在地面）
        this.rot += this.wreckDir * 2.4 * dt;
        this.rotYaw = this.rot;
        this.x += this.launchX * Math.max(0, 1 - w / 1.2) * dt;
        if (w >= 0.45) {
          this.airborne = true;
          this.vy = 14 + Math.min(this.v * 0.15, 3);   // 弹射初速(约飞起 5 m 高)
          this.rotV = this.wreckDir * 5.4;
          this.rotLaunch = this.rot;
          this.pushEvent('air');
        }
      } else {
        // 二、弹射飞出 + 空中翻滚
        this.vy -= c.fallGravity * dt;
        this.yOff += this.vy * dt;
        this.rot += this.rotV * dt;
        this.rotPitch = this.rot - this.rotLaunch;
        this.x += Math.max(this.launchX, 12) * dt;
        if (this.shake < 0.45) this.shake = 0.45;
        if (this.yOff <= 0 && w > 0.62) {
          if (this.x >= this.roadLen) {
            // 飞过了崖边 -> 直接坠入峡谷
            this.phase = 'falling';
            this.v = Math.max(this.launchX, 12);
            this.fallVy = Math.max(1.5, -this.vy);
            this.fallVr = this.rotV;
            this.fallRot = this.rot;
            this.fallT = 0;
            this.yOff = 0;
            this.pushEvent('fall');
          } else {
            // 三、砸回地面 -> 撞毁收场
            this.yOff = 0;
            this.impact = true;
            this.shake = 1.2;
            this.lose();
          }
        }
      }
    }

    if (this.phase === 'accel' || this.phase === 'run') {
      this.x += this.v * dt;
    } else if (this.phase === 'falling') {
      this.fallT += dt;
      this.fallVy += c.fallGravity * dt;
      this.yOff += this.fallVy * dt;
      this.x += this.v * dt;
      this.fallRot += this.fallVr * dt;
      if (this.fallT >= c.fallingMaxT) {
        this.phase = 'lost';
        this.pushEvent('lost');
      }
    }

    if (this.phase === 'accel' || this.phase === 'run') {
      if (this.x >= this.roadLen) {
        this.startFall();
      } else if (this.phase === 'run' && this.v <= c.stopEps) {
        this.win();
      }
    }
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 1.5);
    return this;
  };

  CarGame.prototype.startWreck = function () {
    this.phase = 'wreck';
    this.wreckT = 0;
    this.wreckDir = Math.random() < 0.5 ? -1 : 1;
    this.airborne = false;
    this.impact = false;
    this.yOff = 0;
    this.vy = 0;
    this.rot = 0;
    this.rotYaw = 0;
    this.rotPitch = 0;
    this.rotLaunch = 0;
    this.rotV = 0;
    this.launchX = Math.max(this.v, 6);   // 动画用滑行速度(即使车已很慢也要有戏)
    this.shake = 1;
    this.pushEvent('wreck');
    return this;
  };

  CarGame.prototype.startFall = function () {
    this.phase = 'falling';
    this.fallVy = 2.5;
    this.fallVr = -(1.7 + Math.min(this.v * 0.06, 1.8));
    this.fallT = 0;
    this.yOff = 0;
    this.shake = 1;
    this.pushEvent('fall');
  };

  CarGame.prototype.win = function () {
    this.v = 0;
    this.phase = 'won';
    this.stopMargin = this.roadLen - this.x;
    this.score = clamp(Math.round(100 - this.stopMargin), 0, 100);
    this.rating = ratingFor(this.score);
    this.pushEvent('win');
  };

  CarGame.prototype.lose = function () {
    this.phase = 'lost';
    this.stopMargin = null;
    this.score = 0;
    this.rating = null;
    this.pushEvent('lost');
  };

  /** 落点预测：假设继续踩住（固定减速度，所以是解析准确的） */
  CarGame.prototype.predict = function () {
    var c = this.cfg;
    var v = this.v;
    var dist = v * v / (2 * c.brakeDecel);
    var tau = v / c.brakeDecel;                 // 剩余刹车时间
    var needN = this.F + c.forceRamp * tau;     // 刹停时力度表读数
    return {
      tau: tau,
      dist: dist,
      stopX: this.x + dist,
      needN: needN,
      willBreak: needN > c.forceBreak,
      overCliff: this.x + dist > this.roadLen
    };
  };

  CarGame.prototype.snapshot = function () {
    return {
      phase: this.phase, t: this.t, x: this.x, v: this.v, kmh: this.kmh(),
      F: this.F, pedalBroken: this.pedalBroken, heldT: this.heldT,
      stopMargin: this.stopMargin, score: this.score,
      rating: this.rating ? this.rating.key : null,
      roadLen: this.roadLen, engineA: this.engineA
    };
  };

  /** 剩余可按住时间(s)，到 0 即断裂 */
  CarGame.prototype.holdLeft = function () { return Math.max(0, (this.cfg.forceBreak - this.F) / this.cfg.forceRamp); };
  CarGame.prototype.kmh = function () { return this.v * 3.6; };
  CarGame.prototype.pedalPct = function () { return this.F / this.cfg.forceBreak; };
  CarGame.prototype.distToCliff = function () { return Math.max(0, this.roadLen - this.x); };
  CarGame.prototype.isTerminal = function () { return this.phase === 'won' || this.phase === 'lost'; };

  function ratingFor(score) {
    for (var i = 0; i < RATINGS.length; i++) if (score >= RATINGS[i].min) return RATINGS[i];
    return RATINGS[RATINGS.length - 1];
  }

  global.CarGame = CarGame;
  global.CAR_CFG = CFG;
  global.CAR_RATINGS = RATINGS;
  global.carRating = ratingFor;
  global.carTheoretical = theoretical;
})(typeof window !== 'undefined' ? window : globalThis);
