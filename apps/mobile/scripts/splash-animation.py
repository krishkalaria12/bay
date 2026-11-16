"""Bay's launch animation as Lottie: the icon (Dusk, apps/browser/assets/app-icon.svg) drawing itself.

Run `python3 scripts/splash-animation.py assets/splash/bay.json` after changing it, render its frame 0 at 640 px with a
transparent background into assets/splash/bay-first-frame.png (the launch screens show it), then rebuild both apps.

The paper tile settles in, the sun rises from behind the horizon, then the three lines of water open out from the middle.
While Bay loads, the sun breathes and the lines shimmer out of step (the "loop" marker); "outro" lifts the whole tile up a
touch before the splash fades.
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


SUN = [(0, "#F47B4C"), (1, "#E5582F")]
tile_mask = rounded_square(OFF, OFF, TILE, TILE * 0.235)


def box(x, y, w, h):
    """A plain rectangle in icon space, as a mask path."""
    corners = [P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h)]
    return {"i": [[0, 0]] * 4, "o": [[0, 0]] * 4, "v": corners, "c": True}


def sun_gradient():
    return gradient(SUN, P(512, 300), P(512, 860))


# The paper tile, with the hairline edge the icon has (the launch screen is paper too).
layer(
    "Paper",
    [
        {"ty": "gr", "nm": "Edge", "it": [{"ty": "sh", "d": 1, "ks": static(tile_mask)}, stroke("#000000", 4, o=static(8)), group_tr()]},
        {"ty": "gr", "nm": "Paper", "it": [rect(0, 0, 1024, 1024, 0), gradient([(0, "#FBF7F0"), (1, "#F1EADF")], P(512, 48), P(512, 976)), group_tr()]},
    ],
    mask=tile_mask,
)

# The sun rises from behind the horizon (the mask is the sky above it), then breathes while Bay loads.
K = 240 * 0.5523
sun = path([((272, 560), (0, 0), (0, -K)), ((512, 320), (-K, 0), (K, 0)), ((752, 560), (0, -K), (0, 0))], closed=True)
horizon = P(512, 560)
layer(
    "Sun",
    [
        {
            "ty": "gr",
            "nm": "Sun",
            "it": [
                sun,
                sun_gradient(),
                group_tr(
                    a=horizon,
                    s=anim([(0, [100, 100]), (LOOP_START, [100, 100]), (LOOP_START + 48, [103, 103]), (LOOP_END, [100, 100])]),
                )
                | {"p": anim([(6, [horizon[0], horizon[1] + round(260 * S, 2)]), (60, horizon)])},
            ],
        }
    ],
    mask=box(0, 0, 1024, 560),
)

# The water: three lines open out from the middle, top first, then shimmer out of step.
lines = [(232, 648, 560, 1), (332, 740, 360, 0.7), (432, 832, 160, 0.4)]
line_shapes = []
for n, (x, y, w, a) in enumerate(lines):
    start = 46 + n * 10
    centre = P(x + w / 2, y)
    keys = [(0, a * 100), (LOOP_START + n * 12, a * 100), (LOOP_START + n * 12 + 30, a * 55), (LOOP_START + n * 12 + 60, a * 100)]
    line_shapes.append(
        {
            "ty": "gr",
            "nm": f"Line {n}",
            "it": [rect(x - 26, y - 26, w + 52, 52, 26), sun_gradient(), group_tr(o=anim(keys), p=centre, a=centre, s=anim([(start, [0, 100]), (start + 34, [100, 100])]))],
        }
    )
layer("Water", line_shapes)

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
    # Lottie draws the first layer on top: the water and the sun over the paper.
    "layers": [settle] + list(reversed(layers)),
    "markers": [
        {"tm": LOOP_START, "cm": "loop", "dr": LOOP_END - LOOP_START},
        {"tm": LOOP_END, "cm": "outro", "dr": OUTRO_END - LOOP_END},
    ],
}

with open(sys.argv[1], "w") as out:
    json.dump(animation, out, separators=(",", ":"))
