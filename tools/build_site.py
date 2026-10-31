"""Builds the published site in _site/ from prototypes/, with the app at the root (www.pistemtl.ca opens it directly).

  prototypes/a-positron/*   -> _site/            the app; its "../shared/..." style paths become "shared/..."
  prototypes/<everything else> -> _site/          shared data, vendor, icons, screens, phone.html, manifest
  prototypes/about.html     -> _site/about/       the about page, with its links pointed one folder up
  _site/about.html, _site/a-positron/             forward old links (and home-screen icons) to the new places,
                                                  keeping ?query and #hash
Every path stays relative, so the same build works at a domain root and under a folder (raphroyjauvin.ca/piste/).
Locally the app keeps running from prototypes/a-positron/ (tools/serve.py); this only shapes what gets published.

Usage: python tools/build_site.py [out_dir]     (default: _site next to tools/)
"""
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "prototypes"
APP = SRC / "a-positron"
OUT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / "_site"
SKIP = {"a-positron", "index.html", "about.html", "start-prototypes.bat"}   # replaced below, or local-only

UP = re.compile(r"""(["'`(])\.\./""")                                         # "../ '../ `../ (../ -> drop the ../
LOCAL = re.compile(r"""\b(href|src)="(?!https?:|//|#|mailto:|data:|/)""")      # a relative href/src in the about page


def forward(to, title="Piste"):
    """A tiny page that sends the visitor on to `to` (relative), keeping the query string and hash."""
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<title>{title}</title>
<script>location.replace({json.dumps(to)} + location.search + location.hash);</script>
<meta http-equiv="refresh" content="0; url={to}">
</head>
<body><p><a href="{to}">Piste has moved: continue</a></p></body>
</html>
"""


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.encode("utf-8"))


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    for p in SRC.iterdir():
        if p.name not in SKIP:
            (shutil.copytree if p.is_dir() else shutil.copy2)(p, OUT / p.name)

    # The app at the root
    for p in APP.iterdir():
        if p.is_dir():
            sys.exit(f"build_site: unexpected folder in the app: {p}")
        dst = OUT / p.name
        if dst.exists():
            sys.exit(f"build_site: the app's {p.name} would overwrite a site file")
        if p.suffix in (".html", ".js", ".css"):
            text = UP.sub(r"\1", p.read_bytes().decode("utf-8"))
            left = [line.strip() for line in text.splitlines() if "../" in line]
            if left:
                sys.exit(f"build_site: {p.name} still has a '../' path the build can't rewrite: {left[0][:140]}")
            write(dst, text)
        else:
            shutil.copy2(p, dst)

    # The home-screen app opens the root
    man = json.loads((SRC / "manifest.webmanifest").read_bytes().decode("utf-8"))
    man["start_url"] = "./"
    write(OUT / "manifest.webmanifest", json.dumps(man, indent=2, ensure_ascii=False) + "\n")

    # The about page one folder down, its links pointed back up; the app link goes to the root
    about = (SRC / "about.html").read_bytes().decode("utf-8")
    about = about.replace('href="a-positron/"', 'href="./"')
    about = LOCAL.sub(lambda m: f'{m.group(1)}="../', about)
    write(OUT / "about" / "index.html", about)

    # The phone preview frames the app at the root
    phone = OUT / "phone.html"
    text = phone.read_bytes().decode("utf-8")
    if "a-positron/index.html" not in text:
        sys.exit("build_site: phone.html no longer frames a-positron/index.html; update this script")
    write(phone, text.replace("a-positron/index.html", "index.html"))

    # Old links
    write(OUT / "a-positron" / "index.html", forward("../"))
    write(OUT / "about.html", forward("about/", "About Piste"))

    n = sum(1 for _ in OUT.rglob("*") if _.is_file())
    print(f"build_site: {n} files in {OUT}")


if __name__ == "__main__":
    main()
