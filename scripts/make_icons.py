"""Generate the extension's PNG icons (16/48/128) + a 128x128 store icon.

Concept: a stylized podcast microphone — capsule-shaped head with a U-shaped
stand and base — over a deep red rounded square. Designed to stay legible at
16px (the smallest size Chrome shows in the toolbar context menu) by dropping
fine details (the U-arc, base feet) while keeping the proportions.

Run from repo root:
    python scripts/make_icons.py
Output:
    icons/icon16.png
    icons/icon48.png
    icons/icon128.png
    icons/store-icon-128.png  (same as icon128.png; Chrome Web Store listing)
"""
from PIL import Image, ImageDraw

BG = (17, 17, 17, 255)         # near-black (#111)
FG = (255, 255, 255, 255)
SUPERSAMPLE = 4

def draw_icon(size: int, simplified: bool) -> Image.Image:
    s = size * SUPERSAMPLE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded-square background
    pad = int(s * 0.04)
    radius = int(s * 0.20)
    d.rounded_rectangle(
        [pad, pad, s - pad - 1, s - pad - 1],
        radius=radius,
        fill=BG,
    )

    cx = s // 2

    # Mic head — vertical capsule
    head_w = int(s * 0.34)
    head_h = int(s * 0.46)
    head_top = int(s * 0.18)
    head_left = cx - head_w // 2
    head_bottom = head_top + head_h
    head_radius = head_w // 2
    d.rounded_rectangle(
        [head_left, head_top, head_left + head_w, head_bottom],
        radius=head_radius,
        fill=FG,
    )

    if simplified:
        # 16px: just the head + a short stem so the mic silhouette reads.
        stem_w = int(s * 0.10)
        stem_top = head_bottom + int(s * 0.04)
        stem_bot = int(s * 0.84)
        d.rounded_rectangle(
            [cx - stem_w // 2, stem_top, cx + stem_w // 2, stem_bot],
            radius=stem_w // 2,
            fill=FG,
        )
        return img.resize((size, size), Image.LANCZOS)

    # Full version: U-arc + stem + base bar
    stroke = max(int(s * 0.045), 2)

    arc_w = int(s * 0.56)
    arc_h = int(s * 0.30)
    arc_left = cx - arc_w // 2
    arc_top = head_top + int(head_h * 0.55)
    d.arc(
        [arc_left, arc_top, arc_left + arc_w, arc_top + arc_h * 2],
        start=10, end=170,
        fill=FG, width=stroke,
    )

    stem_w = stroke
    stem_top = arc_top + arc_h
    stem_bot = int(s * 0.86)
    d.rectangle(
        [cx - stem_w // 2, stem_top, cx + stem_w // 2, stem_bot],
        fill=FG,
    )

    base_w = int(s * 0.36)
    base_h = stroke
    d.rounded_rectangle(
        [cx - base_w // 2, stem_bot, cx + base_w // 2, stem_bot + base_h],
        radius=base_h // 2,
        fill=FG,
    )

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    import os
    os.makedirs("icons", exist_ok=True)
    for size in (16, 48, 128):
        out = f"icons/icon{size}.png"
        img = draw_icon(size, simplified=(size <= 24))
        img.save(out, "PNG", optimize=True)
        print(f"wrote {out} ({img.size[0]}x{img.size[1]})")
    # Store listing icon — same artwork at 128.
    draw_icon(128, simplified=False).save("icons/store-icon-128.png", "PNG", optimize=True)
    print("wrote icons/store-icon-128.png (128x128)")


if __name__ == "__main__":
    main()
