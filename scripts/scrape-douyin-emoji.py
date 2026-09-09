#!/usr/bin/env python3
"""
Scrape Douyin comment emoji pack:
 - Reads the emoji/list API JSON (captured from the live page).
 - Downloads each visible (hide=0) emoji image into an output folder.
 - Writes a mapping JSON (emoji display name -> expression / image file).
The "expression" (表达说明) is the plain text inside the [brackets], e.g. [微笑] -> 微笑.
"""
import json, os, re, sys, urllib.request, shutil

API_JSON = "/tmp/emoji_api.json"
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "douyin_comments_emoji")
IMG_DIR = os.path.join(OUT_DIR, "images")

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")

def sniff_ext(data):
    """Detect the real image format from magic bytes, so filenames match content."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:3] == b"GIF":
        return ".gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    if data[:2] == b"\xff\xd8":
        return ".jpg"
    return ".webp"

def download(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://www.douyin.com/"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()
    return data

def main():
    data = json.load(open(API_JSON))
    payload = data[list(data.keys())[0]]
    emoji_list = payload["emoji_list"]

    os.makedirs(IMG_DIR, exist_ok=True)

    records = []
    for e in emoji_list:
        # Only the visible (default comment picker) emojis, as shown in the red-box grid
        if e.get("hide") != 0:
            continue
        display = e["display_name"]          # e.g. "[微笑]"
        name = display.strip("[]")            # 表达说明, e.g. "微笑"
        origin = e["origin_uri"]              # e.g. "weixiao.png"
        url_list = e["emoji_url"]["url_list"]
        url = url_list[0]

        # Safe filename derived from origin_uri; extension follows the real content type
        stem = os.path.splitext(os.path.basename(origin))[0]

        try:
            data = download(url)
        except Exception as ex:
            print(f"  FAIL {name} {url} -> {ex}", file=sys.stderr)
            size = None
            fname = f"{stem}.webp"
            records.append({
                "name": name,
                "display_name": display,
                "file": fname,
                "url": url,
                "downloaded_bytes": None,
            })
            continue

        ext = sniff_ext(data)
        fname = f"{stem}{ext}"
        dest = os.path.join(IMG_DIR, fname)
        with open(dest, "wb") as f:
            f.write(data)
        size = len(data)

        records.append({
            "name": name,
            "display_name": display,
            "file": fname,
            "url": url,
            "downloaded_bytes": size,
        })
        print(f"  ok {name}  {fname}  {size}")

    # Write JSON mapping
    mapping = {
        "source": "https://www.douyin.com/jingxuan?modal_id=7682101129165867899",
        "description": "抖音评论区表情包（红框网格内）资源图与表达说明映射",
        "count": len(records),
        "emojis": records,
    }
    with open(os.path.join(OUT_DIR, "emojis.json"), "w", encoding="utf-8") as f:
        json.dump(mapping, f, ensure_ascii=False, indent=2)

    fail = sum(1 for r in records if not r["downloaded_bytes"])
    print(f"\nDONE: {len(records) - fail}/{len(records)} downloaded -> {OUT_DIR}")
    print(f"  mapping file: {os.path.join(OUT_DIR, 'emojis.json')}")

if __name__ == "__main__":
    main()
