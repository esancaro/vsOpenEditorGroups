"""Generate a 256x256 Open Editor Groups VS Code extension icon."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SIZE = 256
OUT = Path(__file__).resolve().parents[1] / "media" / "icon.png"


def rounded_mask(size: int, radius: int) -> Image.Image:
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return m


def main() -> None:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    bg = (22, 32, 45, 255)
    draw.rectangle((0, 0, SIZE, SIZE), fill=bg)

    # Soft vignette so the glyph pops on a dark marketplace tile
    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((18, 28, 238, 248), fill=(0, 122, 204, 48))
    img = Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(18)))
    draw = ImageDraw.Draw(img)

    folder_blue = (0, 120, 212, 255)
    folder_deep = (14, 99, 168, 255)
    paper = (248, 250, 252, 255)
    paper_back = (198, 214, 230, 255)
    rule = (0, 120, 212, 255)
    rule_muted = (148, 168, 190, 255)

    # Folder tab
    draw.rounded_rectangle((46, 58, 128, 96), radius=12, fill=folder_deep)
    # Folder body
    draw.rounded_rectangle((40, 78, 216, 208), radius=26, fill=folder_blue)
    # Inner well
    draw.rounded_rectangle((52, 96, 204, 196), radius=18, fill=folder_deep)

    # Back document (grouped stack)
    draw.rounded_rectangle((78, 108, 168, 186), radius=12, fill=paper_back)
    # Front document
    draw.rounded_rectangle((96, 94, 198, 180), radius=14, fill=paper)

    # Dog-ear
    draw.polygon([(170, 94), (198, 94), (198, 122)], fill=(226, 234, 242, 255))
    draw.polygon([(170, 94), (170, 122), (198, 122)], fill=(210, 222, 234, 255))

    # Text-like rules on the front page — "open editors"
    draw.rounded_rectangle((112, 126, 176, 136), radius=4, fill=rule)
    draw.rounded_rectangle((112, 146, 164, 154), radius=3, fill=rule_muted)
    draw.rounded_rectangle((112, 162, 154, 170), radius=3, fill=rule_muted)

    img.save(OUT, "PNG")
    print(f"Wrote {OUT} ({SIZE}x{SIZE})")


if __name__ == "__main__":
    main()
