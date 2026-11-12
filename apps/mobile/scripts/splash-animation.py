"""Bay's launch animation as Lottie: the desktop icon building itself.

Run `python3 scripts/splash-animation.py assets/splash/bay.json` after changing it, render its frame 0 at 640 px with a
transparent background into assets/splash/bay-first-frame.png (the launch screens show it), then rebuild both apps.

The dusk tile settles in, the towers rise from the water, the main cable draws across them, the hangers and the roadway
follow, then the water catches the light. While Bay loads, the stars twinkle and the glow breathes (the "loop" marker);
"outro" lifts the whole tile up a touch before the splash fades.
"""
import json
import sys

FPS = 60
SIZE = 512
TILE = 400
OFF = (SIZE - TILE) / 2
S = TILE / 1024  # the desktop icon is drawn on a 1024 grid
LOOP_START, LOOP_END, OUTRO_END = 100, 196, 220


def P(x, y):
    return [round(OFF + x * S, 2), round(OFF + y * S, 2)]


def hexc(h, a=1):
    h = h.lstrip("#")
    return [int(h[i : i + 2], 16) / 255 for i in (0, 2, 4)] + [a]


def static(v):
    return {"a": 0, "k": v}


def ease_out():
    return {"o": {"x": [0.2], "y": [0]}, "i": {"x": [0.1], "y": [1]}}


def anim(keys):
    """keys: [(frame, value)], eased out between them."""
    frames = []
    for i, (t, v) in enumerate(keys):
        k = {"t": t, "s": v if isinstance(v, list) else [v]}
        if i < len(keys) - 1:
            k.update(ease_out())
        frames.append(k)
    return {"a": 1, "k": frames}


def transform(p=(256, 256), a=(256, 256), s=None, o=None, r=0):
    return {
        "o": o or static(100),
        "r": static(r),
        "p": static([p[0], p[1], 0]),
        "a": static([a[0], a[1], 0]),
        "s": s or static([100, 100, 100]),
    }


def group_tr(o=None, s=None, p=(0, 0), a=(0, 0)):
    return {"ty": "tr", "p": static(list(p)), "a": static(list(a)), "s": s or static([100, 100]), "r": static(0), "o": o or static(100), "sk": static(0), "sa": static(0)}


def rect(x, y, w, h, r):
    (cx, cy) = P(x + w / 2, y + h / 2)
    return {"ty": "rc", "d": 1, "p": static([cx, cy]), "s": static([round(w * S, 2), round(h * S, 2)]), "r": static(round(r * S, 2))}


def fill(c, a=1):
    return {"ty": "fl", "c": static(hexc(c)), "o": static(a * 100), "r": 1}


def gradient(stops, start, end, kind=1, alphas=None):
    k = []
    for off, c in stops:
        k += [off] + hexc(c)[:3]
    if alphas:
        for off, a in alphas:
            k += [off, a]
    g = {"ty": "gf", "o": static(100), "r": 1, "t": kind, "s": static(start), "e": static(end), "g": {"p": len(stops), "k": static(k)}}
    if kind == 2:
        g["h"] = static(0)
        g["a"] = static(0)
    return g


def stroke(c, w, o=None):
    return {"ty": "st", "c": static(hexc(c)), "o": o or static(100), "w": static(round(w * S, 2)), "lc": 2, "lj": 2, "ml": 4}


def path(points, closed=False):
    """points: list of (vertex, in_tangent, out_tangent) in icon space, tangents relative."""
    v, i, o = [], [], []
    for (x, y), (ix, iy), (ox, oy) in points:
        v.append(P(x, y))
        i.append([round(ix * S, 2), round(iy * S, 2)])
        o.append([round(ox * S, 2), round(oy * S, 2)])
    return {"ty": "sh", "d": 1, "ks": static({"i": i, "o": o, "v": v, "c": closed})}


def cubic(start, segments):
    """An SVG-style run of cubic segments as Lottie vertices."""
    pts = [[start, [0, 0], [0, 0]]]
    for c1, c2, end in segments:
        pts[-1][2] = [c1[0] - pts[-1][0][0], c1[1] - pts[-1][0][1]]
        pts.append([end, [c2[0] - end[0], c2[1] - end[1]], [0, 0]])
    return path([tuple(p) for p in pts])


def line(x1, y1, x2, y2):
    return path([((x1, y1), (0, 0), (0, 0)), ((x2, y2), (0, 0), (0, 0))])


def rounded_square(x, y, w, r):
    """A rounded square as a bezier, for the tile's mask; a long handle makes the corner close to a squircle."""
    k = r * 0.62
    pts = [
        ((x + r, y), (-k, 0), (0, 0)),
        ((x + w - r, y), (0, 0), (k, 0)),
        ((x + w, y + r), (0, -k), (0, 0)),
        ((x + w, y + w - r), (0, 0), (0, k)),
        ((x + w - r, y + w), (k, 0), (0, 0)),
        ((x + r, y + w), (0, 0), (-k, 0)),
        ((x, y + w - r), (0, k), (0, 0)),
        ((x, y + r), (0, 0), (0, -k)),
    ]
    return {"i": [[i[0], i[1]] for _, i, _ in pts], "o": [[o[0], o[1]] for _, _, o in pts], "v": [[px, py] for (px, py), _, _ in pts], "c": True}


layers = []


def layer(name, shapes, ks=None, ip=0, mask=None):
    entry = {
        "ddd": 0,
        "ind": len(layers) + 2,
        "ty": 4,
        "nm": name,
        "sr": 1,
        "ks": ks or transform(),
        "ao": 0,
        "shapes": shapes,
        "ip": ip,
        "op": OUTRO_END,
        "st": 0,
        "bm": 0,
        "parent": 1,
    }
    if mask:
        entry["hasMask"] = True
        entry["masksProperties"] = [{"inv": False, "mode": "a", "pt": static(mask), "o": static(100), "x": static(0), "nm": "Tile"}]
    layers.append(entry)


STEEL = "#EC6A43"
SHADE = "#C9502E"
tile_mask = rounded_square(OFF, OFF, TILE, TILE * 0.235)

# The dusk: sky, water and the glow on the horizon, clipped to the tile.
layer(
    "Dusk",
    [
        # The first shape in a Lottie group draws on top: the water over the sky.
        {"ty": "gr", "nm": "Water", "it": [rect(0, 690, 1024, 334, 0), gradient([(0, "#C6805A"), (0.08, "#63495A"), (0.5, "#242C46"), (1, "#141B2F")], P(512, 690), P(512, 1024)), group_tr()]},
        {"ty": "gr", "nm": "Sky", "it": [rect(0, 0, 1024, 1024, 0), gradient([(0, "#151C36"), (0.4, "#3C3358"), (0.74, "#8E5C63"), (1, "#E0925F")], P(512, 0), P(512, 1024)), group_tr()]},
    ],
    mask=tile_mask,
)

# The glow on the horizon: brightens once the bridge stands, then breathes while Bay loads.
glow_keys = [(0, 30), (80, 100), (LOOP_START, 100), (LOOP_START + 48, 70), (LOOP_END, 100)]
layer(
    "Glow",
    [
        {
            "ty": "gr",
            "nm": "Glow",
            "it": [
                # Lottie's radial gradients are round: draw a round glow and squash it into the horizon's ellipse.
                {"ty": "el", "d": 1, "p": static(P(512, 666)), "s": static([round(880 * S, 2), round(880 * S, 2)])},
                gradient([(0, "#FFDCA6"), (1, "#FFDCA6")], P(512, 666), P(952, 666), kind=2, alphas=[(0, 0.5), (1, 0)]),
                group_tr(o=anim(glow_keys), p=P(512, 666), a=P(512, 666), s=static([100, round(146 / 440 * 100, 2)])),
            ],
        }
    ],
    mask=tile_mask,
)

# Stars, twinkling out of step.
stars = [(238, 182, 2.2, 0.7), (352, 132, 1.6, 0.5), (492, 206, 2.5, 0.8), (628, 146, 1.8, 0.55), (758, 218, 2.2, 0.72), (836, 160, 1.5, 0.45)]
star_shapes = []
for n, (x, y, r, a) in enumerate(stars):
    phase = n * 13
    keys = [(0, 0), (40 + phase // 2, a * 100), (LOOP_START + phase, a * 100), (LOOP_START + phase + 24, a * 25), (LOOP_START + phase + 48, a * 100)]
    star_shapes.append({"ty": "gr", "nm": f"Star {n}", "it": [{"ty": "el", "d": 1, "p": static(P(x, y)), "s": static([round(r * 5 * S, 2)] * 2)}, fill("#FFF6E8"), group_tr(o=anim(keys))]})
layer("Stars", star_shapes)

# The cables: the main span draws itself across, the hangers drop after it.
cable = cubic(
    (150, 596),
    [((246, 512), (246, 344), (328, 258)), ((460, 354), (336, 464), (512, 464)), ((688, 464), (564, 354), (696, 258)), ((778, 344), (778, 512), (874, 596))],
)
layer(
    "Cable",
    [
        {
            "ty": "gr",
            "nm": "Cable",
            "it": [cable, {"ty": "tm", "s": static(0), "e": anim([(26, 0), (84, 100)]), "o": static(0), "m": 1}, stroke(STEEL, 12), group_tr()],
        }
    ],
)
hangers = [(375, 307), (395, 354), (404, 397), (415, 432), (446, 455), (512, 464), (578, 455), (609, 432), (620, 397), (629, 354), (649, 307), (233, 458), (258, 390), (284, 325), (740, 325), (766, 390), (791, 458)]
layer(
    "Hangers",
    [
        {
            "ty": "gr",
            "nm": "Hangers",
            "it": [line(x, y, x, 596) for x, y in hangers]
            + [{"ty": "tm", "s": static(0), "e": anim([(52, 0), (92, 100)]), "o": static(0), "m": 1}, stroke(STEEL, 4.5, o=static(90)), group_tr()],
        }
    ],
)

# The roadway, opening out from the middle.
road_centre = P(512, 596)
layer(
    "Road",
    [{"ty": "gr", "nm": "Road", "it": [rect(94, 589, 836, 14, 7), fill(STEEL), group_tr(p=road_centre, a=road_centre, s=anim([(40, [0, 100]), (76, [100, 100])]))]}],
)

# The towers, rising out of the water.
tower_base = P(512, 674)
towers = []
for x0 in (282, 650):
    for dx in (0, 66):
        towers.append(rect(x0 + dx, 258, 26, 416, 13))
    for y in (499, 366):
        towers.append(rect(x0 + 13, y, 66, 14, 7))
    towers.append(rect(x0 + 13, 242, 66, 18, 9))
layer(
    "Towers",
    [
        {
            "ty": "gr",
            "nm": "Towers",
            "it": towers
            + [
                gradient([(0, "#DB5734"), (0.5, "#F0764C"), (1, "#CE4C2B")], P(282, 0), P(742, 0)),
                group_tr(p=tower_base, a=tower_base, s=anim([(8, [100, 0]), (50, [100, 100])])),
            ],
        }
    ],
)

# Piers and the light on the water, once the bridge stands.
water = [rect(290, 672, 76, 24, 8), rect(658, 672, 76, 24, 8)]
layer("Piers", [{"ty": "gr", "nm": "Piers", "it": water + [fill(SHADE, 0.8), group_tr(o=anim([(30, 0), (56, 100)]))]}])
ripples = [(408, 696, 208, 6, 0.26), (344, 730, 336, 4, 0.15), (288, 762, 448, 4, 0.11), (387, 798, 250, 4, 0.09), (316, 838, 392, 4, 0.06)]
ripple_shapes = []
for n, (x, y, w, h, a) in enumerate(ripples):
    start = 70 + n * 5
    keys = [(start, 0), (start + 22, a * 100), (LOOP_START + n * 10, a * 100), (LOOP_START + n * 10 + 30, a * 45), (LOOP_START + n * 10 + 60, a * 100)]
    centre = P(x + w / 2, y)
    ripple_shapes.append(
        {"ty": "gr", "nm": f"Ripple {n}", "it": [rect(x, y, w, h, h / 2), fill("#FFE2C0"), group_tr(o=anim(keys), p=centre, a=centre, s=anim([(start, [40, 100]), (start + 30, [100, 100])]))]}
    )
layer("Water light", ripple_shapes, mask=tile_mask)

# The parent: the tile settles in at the start, and lifts at the end.
settle = {
    "ddd": 0,
    "ind": 1,
    "ty": 3,
    "nm": "Tile",
    "sr": 1,
    "ks": {
        "o": static(100),
        "r": static(0),
        "p": static([256, 256, 0]),
        "a": static([256, 256, 0]),
        "s": anim([(0, [92, 92, 100]), (40, [100, 100, 100]), (LOOP_END, [100, 100, 100]), (OUTRO_END - 1, [108, 108, 100])]),
    },
    "ao": 0,
    "ip": 0,
    "op": OUTRO_END,
    "st": 0,
    "bm": 0,
}

animation = {
    "v": "5.7.4",
    "fr": FPS,
    "ip": 0,
    "op": OUTRO_END,
    "w": SIZE,
    "h": SIZE,
    "nm": "Bay",
    "ddd": 0,
    "assets": [],
    # Lottie draws the first layer on top: the bridge over the water over the sky.
    "layers": [settle] + list(reversed(layers)),
    "markers": [
        {"tm": LOOP_START, "cm": "loop", "dr": LOOP_END - LOOP_START},
        {"tm": LOOP_END, "cm": "outro", "dr": OUTRO_END - LOOP_END},
    ],
}

with open(sys.argv[1], "w") as out:
    json.dump(animation, out, separators=(",", ":"))
