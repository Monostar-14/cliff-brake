#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""打包成可单独分享的单文件 HTML（2D 版 / 3D 版各一份，内联 CSS + JS，零依赖零联网）。

用法: python make-standalone.py
输出:
  悬崖急刹-单文件版.html      (2D)
  悬崖急刹-3D-单文件版.html   (3D)
"""
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
JOBS = [
    ("index.html", ["game.js", "app.js"], "悬崖急刹-单文件版.html", "（单文件版）"),
    ("index-3d.html", ["game.js", "view3d.js"], "悬崖急刹-3D-单文件版.html", "（3D 单文件版）"),
]


def read(name):
    with io.open(os.path.join(HERE, name), encoding="utf-8") as f:
        return f.read()


def build(src_html, scripts, out_name, tag):
    html = read(src_html)
    css = read("hud.css")
    link = '<link rel="stylesheet" href="hud.css" />'
    if link not in html:
        print("!! %s 里找不到 hud.css 的 link" % src_html)
        return 1
    html = html.replace(link, "<style>\n" + css + "\n</style>")
    for src in scripts:
        js = read(src)
        if "</script" in js:
            print("!! %s 含 </script 字面量，无法内联" % src)
            return 1
        stag = '<script src="%s"></script>' % src
        if stag not in html:
            print("!! %s 里找不到 %s" % (src_html, stag))
            return 1
        html = html.replace(stag, "<script>\n" + js + "\n</script>")
    html = html.replace("</title>", " " + tag + "</title>")
    # 单文件里去掉跨版本跳转（没有对应文件了）
    html = html.replace('<a class="icon-btn" href="index-3d.html"', '<a class="icon-btn" href="#" style="display:none"')
    html = html.replace('<a class="icon-btn" href="index.html"', '<a class="icon-btn" href="#" style="display:none"')
    out = os.path.join(HERE, out_name)
    with io.open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)
    print("已生成:", out, os.path.getsize(out), "bytes")
    return 0


def main():
    rc = 0
    for src, scripts, out, tag in JOBS:
        rc |= build(src, scripts, out, tag)
    return rc


if __name__ == "__main__":
    sys.exit(main())
