"""Membuat semua ikon & logo aplikasi dari logo perusahaan (gambar bulat, latar putih).

Pakai:  python tools/make-icons.py path/ke/logo.jpg
Butuh:  pip install pillow
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"


def load_square(path):
    im = Image.open(path).convert("RGB")
    s = min(im.size)
    left, top = (im.width - s) // 2, (im.height - s) // 2
    return im.crop((left, top, left + s, top + s))


def circle(src, n):
    """Logo bulat dengan sudut transparan (tepi halus)."""
    im = src.resize((n, n), Image.LANCZOS).convert("RGBA")
    ss = 4
    mask = Image.new("L", (n * ss, n * ss), 0)
    ImageDraw.Draw(mask).ellipse((ss, ss, n * ss - ss - 1, n * ss - ss - 1), fill=255)
    im.putalpha(mask.resize((n, n), Image.LANCZOS))
    return im


def on_white(src, n, scale):
    """Kotak putih penuh dengan logo di tengah (untuk ikon maskable & iOS)."""
    bg = Image.new("RGBA", (n, n), (255, 255, 255, 255))
    c = circle(src, round(n * scale))
    off = (n - c.width) // 2
    bg.alpha_composite(c, (off, off))
    return bg.convert("RGB")


def save(im, name, colors=96):
    # Kuantisasi warna: logo hanya biru, merah, putih → PNG jauh lebih kecil tanpa terlihat beda
    im.quantize(colors=colors, method=Image.Quantize.FASTOCTREE).save(OUT / name, optimize=True)
    print(f"{name:24} {(OUT / name).stat().st_size / 1024:6.1f} KB")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = load_square(sys.argv[1])
    OUT.mkdir(parents=True, exist_ok=True)
    save(circle(src, 512), "icon-512.png")
    save(circle(src, 192), "icon-192.png")
    save(circle(src, 128), "logo.png")          # logo di tampilan aplikasi & dashboard
    save(circle(src, 48), "favicon.png", 64)
    # Area aman ikon maskable = lingkaran 80% → logo diperkecil supaya tulisan tidak terpotong
    save(on_white(src, 512, 0.84), "icon-maskable-512.png")
    save(on_white(src, 180, 0.94), "apple-touch-icon.png")


if __name__ == "__main__":
    main()
