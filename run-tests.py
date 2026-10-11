#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""悬崖急刹 —— 无头验证 runner

用法:  python run-tests.py  [--shots]
  1) 用 headless Edge 打开 verify.html  -> 纯物理内核断言
  2) 打开 index.html?selftest=1        -> 页面/渲染/输入通路自检
  --shots 额外生成 shot-*.png 截图
"""
import json
import os
import re
import subprocess
import sys
import html as _html

HERE = os.path.dirname(os.path.abspath(__file__))
EDGE = os.environ.get(
    "EDGE", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
TMP = os.path.join(HERE, "edge-tmp")
URL = "file:///" + HERE.replace("\\", "/") + "/"


def edge(args, timeout=120):
    cmd = [EDGE, "--headless=new", "--disable-gpu", "--no-first-run",
           "--user-data-dir=" + TMP, "--hide-scrollbars"] + args
    p = subprocess.run(cmd, capture_output=True, timeout=timeout)
    return p.stdout.decode("utf-8", "replace")


def dump(url):
    return edge(["--window-size=1560,900", "--force-device-scale-factor=1",
                 "--dump-dom", url])


def main():
    rc = 0
    print("=" * 66)
    print("1) 物理内核验证  verify.html")
    print("=" * 66)
    dom = dump(URL + "verify.html")
    m = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
    if not m:
        print("!! 未取到验证输出（页面脚本可能报错）")
        print(dom[:1200])
        return 1
    text = _html.unescape(m.group(1))
    for line in text.splitlines():
        if "FAIL" in line or "passed," in line or line.startswith("理论") or "=>" in line:
            print(line)
    fails = text.count("FAIL")
    if fails:
        rc = 1
        print("\n---- 失败明细 ----")
        for line in text.splitlines():
            if "FAIL" in line:
                print(line)

    print()
    print("=" * 66)
    print("2) 页面自检  index.html?selftest=1")
    print("=" * 66)
    dom2 = dump(URL + "index.html?selftest=1")
    m2 = re.search(r'id="selftest"[^>]*>(.*?)</div>', dom2, re.S)
    raw = _html.unescape(m2.group(1)).strip() if m2 else ""
    if not raw:
        print("!! 自检未输出（脚本可能在加载阶段就抛错了）")
        return 1
    try:
        rep = json.loads(raw)
    except Exception as e:
        print("!! 自检输出无法解析:", e)
        print(raw[:1500])
        return 1
    c = rep.get("checks", {})
    print("ok =", rep.get("ok"), "  errors =", rep.get("err"))
    print("  点刹成功     :", c.get("feather"))
    print("  一脚不松     :", c.get("fullHold"))
    print("  不刹车       :", c.get("noBrake"))
    print("  输入通路     :", c.get("input"))
    print("  画布像素     :", c.get("pixels"))
    print("  DOM          :", c.get("dom"))
    if not rep.get("ok"):
        rc = 1

    print()
    print("=" * 66)
    print("3) 3D 版页面自检  index-3d.html?selftest=1")
    print("=" * 66)
    dom3 = dump(URL + "index-3d.html?selftest=1")
    m3 = re.search(r'id="selftest"[^>]*>(.*?)</div>', dom3, re.S)
    raw3 = _html.unescape(m3.group(1)).strip() if m3 else ""
    if not raw3:
        print("!! 3D 自检未输出（脚本可能在加载阶段就抛错了）")
        rc = 1
    else:
        try:
            r3 = json.loads(raw3)
        except Exception as e:
            print("!! 3D 自检输出无法解析:", e)
            print(raw3[:1200])
            rc = 1
        else:
            c3 = r3.get("checks", {})
            print("ok =", r3.get("ok"), "  errors =", r3.get("err"))
            print("  点刹成功 :", c3.get("feather"))
            print("  一脚不松 :", c3.get("fullHold"))
            print("  不刹车   :", c3.get("noBrake"))
            print("  相机(相对车):", c3.get("camera"), " 图元数:", (c3.get("geometry") or {}).get("items"))
            print("  像素     :", c3.get("pixels"))
            print("  输入通路 :", c3.get("input"))
            print("  结算/重开:", c3.get("flow"))
            if not r3.get("ok"):
                rc = 1

    if "--shots" in sys.argv:
        print()
        print("=" * 66)
        print("4) 截图")
        print("=" * 66)
        for mode in ("start", "accel", "braking", "breaking", "wreck", "air", "impact", "win", "fall"):
            out = os.path.join(HERE, "shot-%s.png" % mode)
            edge(["--window-size=1560,900", "--force-device-scale-factor=1",
                  "--screenshot=" + out.replace("/", "\\"),
                  URL + "index.html?shot=" + mode])
            print("  ", out, os.path.getsize(out), "bytes")
        for mode in ("accel", "braking", "near", "win", "wreck", "air", "impact"):
            out = os.path.join(HERE, "shot3d-%s.png" % mode)
            edge(["--window-size=1560,900", "--force-device-scale-factor=1",
                  "--screenshot=" + out.replace("/", "\\"),
                  URL + "index-3d.html?shot=" + mode])
            print("  ", out, os.path.getsize(out), "bytes")

    print()
    print("结果:", "全部通过 PASS" if rc == 0 else "存在失败 FAIL")
    return rc


if __name__ == "__main__":
    sys.exit(main())
