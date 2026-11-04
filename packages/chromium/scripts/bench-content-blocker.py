#!/usr/bin/env python3
"""Offline C ABI benchmark. Build packages/adblock with cargo build --release first."""
import argparse
import ctypes as c
import hashlib
import json
from pathlib import Path
import statistics
import time

ROOT = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--library", type=Path, default=ROOT / "packages/adblock/target/release/libbay_adblock.dylib")
parser.add_argument("--rounds", type=int, default=7)
parser.add_argument("--iterations", type=int, default=1000)
parser.add_argument("--documents", action="store_true", help="also measure scriptlets, cosmetics and HTML body filtering")
args = parser.parse_args()
if args.rounds < 1 or args.iterations < 1:
    parser.error("rounds and iterations must be positive")
lib = c.CDLL(str(args.library.resolve()))


def bind(name, result, *arguments):
    function = getattr(lib, "bay_" + name)
    function.restype = result
    function.argtypes = arguments
    return function


class Match(c.Structure):
    _fields_ = [("blocked", c.c_bool), ("redirect", c.c_void_p),
                ("rewrite", c.c_void_p), ("rewrite_any_origin", c.c_bool)]


new = bind("blocker_new_with_permissions", c.c_void_p, c.POINTER(c.c_char_p), c.POINTER(c.c_bool), c.POINTER(c.c_uint8), c.c_size_t)
free = bind("blocker_free", None, c.c_void_p)
string_free = bind("string_free", None, c.c_void_p)
match = bind("blocker_match", Match, c.c_void_p, *([c.c_char_p] * 4))
response = bind("blocker_response", c.c_void_p, c.c_void_p, *([c.c_char_p] * 6))
body_gate = bind("blocker_body_filter_applies", c.c_bool, c.c_void_p, *([c.c_char_p] * 4), c.c_int32, c.c_char_p, c.c_char_p)
scriptlets = bind("blocker_scriptlets", c.c_void_p, c.c_void_p, c.c_char_p)
cosmetic = bind("blocker_cosmetic", c.c_void_p, c.c_void_p, c.c_char_p)
resources = bind("blocker_use_resources", c.c_bool, c.c_void_p, c.c_char_p)
body_filter = bind("blocker_body_filter", c.c_void_p, c.c_void_p, *([c.c_char_p] * 5), c.c_char_p, c.c_size_t, c.POINTER(c.c_size_t))
bytes_free = bind("bytes_free", None, c.c_void_p, c.c_size_t)
catalogue = json.loads((ROOT / "packages/chromium/ios/filter_lists.json").read_text())["lists"]
paths = sorted((ROOT / "packages/chromium/vendor/filter-lists").glob("*.txt"))
if not paths:
    parser.error("no bundled lists; run packages/chromium/scripts/filter-lists.sh first")
texts = [path.read_bytes() for path in paths]
host_lists = {entry["id"] for entry in catalogue if entry.get("hosts")}
hosts = [path.stem in host_lists for path in paths]
permissions = [int(path.stem.startswith("ublock-")) for path in paths]
if args.documents:
    fixture = json.loads((ROOT / "packages/adblock/fixtures/html-filter-perf.json").read_text())
    texts.append("\n".join(fixture["rules"]).encode())
    hosts.append(False)
    permissions.append(0)
started = time.perf_counter()
blocker = new((c.c_char_p * len(texts))(*texts),
              (c.c_bool * len(texts))(*hosts),
              (c.c_uint8 * len(texts))(*permissions), len(texts))
build_ms = (time.perf_counter() - started) * 1000
if args.documents:
    if not resources(blocker, (ROOT / "packages/chromium/vendor/blocker-resources/blocker-resources.json").read_bytes()):
        free(blocker)
        parser.error("invalid scriptlet resources; run packages/chromium/scripts/blocker-resources.sh")

# Allowed resources, blocked ads, and matching URL/response/body modifiers.
cases = [
    (b"https://example.com/app.js", b"script", b"application/javascript"),
    (b"https://cdn.example.net/site.css", b"stylesheet", b"text/css"),
    (b"https://example.org/api/items?q=hello", b"xmlhttprequest", b"application/json"),
    (b"https://doubleclick.net/ad.js", b"script", b"application/javascript"),
    (b"https://example.com/?fbclid=tracker&keep=1", b"document", b"text/html"),
    (b"https://go.skimresources.com/?url=https%3A%2F%2Fexample.org%2F", b"document", b"text/html"),
    (b"https://www.youtube.com/watch?v=1", b"document", b"text/html"),
    (b"https://www.twitch.tv/", b"document", b"text/html"),
]
source = b"https://example.com/"
method = b"GET"


def take(pointer):
    if not pointer:
        return None
    try:
        return c.string_at(pointer).decode()
    finally:
        string_free(pointer)


def request_case(case):
    url, kind, _ = case
    result = match(blocker, url, source, kind, method)
    return result.blocked, take(result.redirect), take(result.rewrite), result.rewrite_any_origin


def response_case(case):
    url, kind, _ = case
    return take(response(blocker, url, source, kind, method, b"1.1.1.1", b'[["server","nginx"]]'))


def gate_case(case):
    url, kind, mime = case
    return body_gate(blocker, url, source, kind, method, 200, mime, b"")


def scriptlet_case(case):
    return take(scriptlets(blocker, case[0]))


def cosmetic_case(case):
    return take(cosmetic(blocker, case[0]))


def html_case(case):
    url, body = case
    length = c.c_size_t()
    pointer = body_filter(blocker, url, url, b"document", method, b"text/html", body, len(body), c.byref(length))
    if not pointer:
        return None
    try:
        return {"length": length.value, "sha256": hashlib.sha256(c.string_at(pointer, length.value)).hexdigest()}
    finally:
        bytes_free(pointer, length.value)


try:
    timings = {}
    answers = {}
    operations = [(name, operation, cases, args.iterations, 100) for name, operation in
                  [("request", request_case), ("response", response_case), ("body_gate", gate_case)]]
    if args.documents:
        operations += [("scriptlets", scriptlet_case, cases, args.iterations, 100),
                       ("cosmetic", cosmetic_case, cases, args.iterations, 100)]
        body = (fixture["prefix"] + fixture["fragment"] * fixture["repeat"] + fixture["suffix"]).encode()
        operations.append(("html_body", html_case, [(fixture["url"].encode(), body)], min(args.iterations, 5), 1))
    for name, operation, workloads, iterations, warmup in operations:
        answers[name] = [operation(case) for case in workloads]
        for _ in range(warmup):
            for case in workloads:
                operation(case)
        samples = []
        for _ in range(args.rounds):
            started = time.perf_counter_ns()
            for _ in range(iterations):
                for case in workloads:
                    operation(case)
            samples.append((time.perf_counter_ns() - started) / (iterations * len(workloads)) / 1000)
        timings[name] = {"median_us": round(statistics.median(samples), 3), "samples_us": [round(sample, 3) for sample in samples]}
    print(json.dumps({"lists": len(texts), "list_sha256": hashlib.sha256(b"\0".join(texts)).hexdigest(),
                      "cases": len(cases), "build_ms": round(build_ms, 1), "timings": timings, "answers": answers}, indent=2))
finally:
    free(blocker)
