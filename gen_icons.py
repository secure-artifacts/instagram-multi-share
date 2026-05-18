"""Generate extension icons - fully opaque, no transparency issues."""
from PIL import Image, ImageDraw

def draw_icon(size):
    s = size
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img, 'RGBA')

    # Background: rounded square, Messenger blue
    radius = s // 5
    bg_color = (0, 132, 255, 255)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=bg_color)

    # Now create a separate layer for white elements to avoid alpha issues
    white = (255, 255, 255, 255)
    light_blue = (100, 180, 255, 255)

    # === Monitor ===
    mx1 = int(s * 0.15)
    my1 = int(s * 0.15)
    mx2 = int(s * 0.85)
    my2 = int(s * 0.58)
    lw = max(1, s // 20)
    mr = max(2, s // 16)

    # Monitor body (white outline, light blue fill)
    d.rounded_rectangle([mx1, my1, mx2, my2], radius=mr,
                        fill=light_blue, outline=white, width=lw)

    # === Share/broadcast icon inside monitor (simplified arrow) ===
    # A simple "play" triangle
    tri_cx = (mx1 + mx2) // 2
    tri_cy = (my1 + my2) // 2
    tri_s = int(s * 0.10)
    if tri_s >= 2:
        d.polygon([
            (tri_cx - tri_s, tri_cy - int(tri_s * 1.2)),
            (tri_cx + int(tri_s * 1.2), tri_cy),
            (tri_cx - tri_s, tri_cy + int(tri_s * 1.2)),
        ], fill=white)

    # Monitor stand
    cx = s // 2
    stand_w = max(1, int(s * 0.04))
    stand_h = max(2, int(s * 0.10))
    d.rectangle([cx - stand_w, my2, cx + stand_w, my2 + stand_h], fill=white)

    # Monitor base
    base_w = int(s * 0.14)
    base_h = max(1, int(s * 0.035))
    base_top = my2 + stand_h
    d.rounded_rectangle([cx - base_w, base_top, cx + base_w, base_top + base_h],
                        radius=max(1, base_h // 2), fill=white)

    # === Camera icon (bottom-right area) ===
    cam_x1 = int(s * 0.42)
    cam_y1 = int(s * 0.72)
    cam_x2 = int(s * 0.72)
    cam_y2 = int(s * 0.90)
    cam_r = max(1, s // 20)
    d.rounded_rectangle([cam_x1, cam_y1, cam_x2, cam_y2],
                        radius=cam_r, fill=white)

    # Camera lens (triangle on right side)
    lens_x1 = cam_x2 + max(1, int(s * 0.02))
    lens_x2 = int(s * 0.85)
    lens_ymid = (cam_y1 + cam_y2) // 2
    lens_yoff = int(s * 0.06)
    if lens_x2 > lens_x1:
        d.polygon([
            (lens_x1, lens_ymid - lens_yoff),
            (lens_x2, lens_ymid - int(lens_yoff * 0.6)),
            (lens_x2, lens_ymid + int(lens_yoff * 0.6)),
            (lens_x1, lens_ymid + lens_yoff),
        ], fill=white)

    return img


for sz in [16, 48, 128]:
    icon = draw_icon(sz)
    path = f'D:/新建文件夹/instagram-multi-share/icons/icon{sz}.png'
    icon.save(path, format='PNG')
    # Verify opacity
    v = Image.open(path)
    center = v.getpixel((sz // 2, sz // 2))
    print(f'icon{sz}.png: size={v.size}, center_pixel={center}')
