#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""打包成可单独分享的单文件 HTML（内联 CSS + JS，零依赖零联网）。

用法: python make-standalone.py
输入: index.html（站点唯一入口/3D）+ game.js + view3d.js + hud.css
输出: 悬崖急刹-单文件版.html
"""
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_HTML = "index.html"
SCRIPTS = ["game.js", "view3d.js"]
OUT_NAME = "悬崖急刹-单文件版.html"
TAG = "（单文件版）"


def read(name):
    with io.open(os.path.join(HERE, name), encoding="utf-8") as f:
        return f.read()


def build():
    html = read(SRC_HTML)
    css = read("hud.css")
    link = '<link rel="stylesheet" href="hud.css" />'
    if link not in html:
        print("!! %s 里找不到 hud.css 的 link" % SRC_HTML)
        return 1
    html = html.replace(link, "<style>\n" + css + "\n</style>")
    for src in SCRIPTS:
        js = read(src)
        if "</script" in js:
            print("!! %s 含 </script 字面量，无法内联" % src)
            return 1
        stag = '<script src="%s"></script>' % src
        if stag not in html:
            print("!! %s 里找不到 %s" % (SRC_HTML, stag))
            return 1
        html = html.replace(stag, "<script>\n" + js + "\n</script>")
    html = html.replace("</title>", " " + TAG + "</title>")
    out = os.path.join(HERE, OUT_NAME)
    with io.open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)
    print("已生成:", out, os.path.getsize(out), "bytes")
    return 0


if __name__ == "__main__":
    sys.exit(build())
