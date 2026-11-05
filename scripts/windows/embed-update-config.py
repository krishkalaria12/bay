#!/usr/bin/env python3
"""Embed updater policy as RCDATA 201 before Authenticode signing Bay.exe."""
import argparse
import ctypes
from ctypes import wintypes
import json
import pathlib
import re
import urllib.parse
import sys

RESOURCE_ID = 201


def validate_config(config):
    required = {"enabled", "version", "appVersion", "buildNumber", "channel", "feedUrl", "publisherThumbprints", "allowedOrigins", "scriptSha256"}
    if not required.issubset(config):
        raise ValueError("update policy is missing required fields")
    if not isinstance(config["enabled"], bool) or config["channel"] not in ("stable", "beta"):
        raise ValueError("update policy requires a boolean enabled flag and a known channel")
    if not isinstance(config["version"], str) or not re.fullmatch(r"\d+\.\d+\.\d+(?:\.\d+)?", config["version"]):
        raise ValueError("invalid installed application version")
    if config["appVersion"] != config["version"]:
        raise ValueError("installed application versions do not match")
    if not isinstance(config["scriptSha256"], str) or not re.fullmatch(r"[a-fA-F0-9]{64}", config["scriptSha256"]):
        raise ValueError("update script SHA-256 is invalid")
    for name in ("publisherThumbprints", "allowedOrigins"):
        if not isinstance(config[name], list) or any(not isinstance(value, str) for value in config[name]):
            raise ValueError(f"{name} must be an array of strings")
    for origin in config["allowedOrigins"]:
        parsed = urllib.parse.urlsplit(origin)
        if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
            raise ValueError("allowed update origins must be HTTPS origins without credentials or paths")
    if config["enabled"] and (not config["publisherThumbprints"] or not config["allowedOrigins"] or not config["feedUrl"]):
        raise ValueError("enabled updates require a feed, publisher pins and allowed origins")
    return json.dumps(config, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def embed(executable, data):
    if sys.platform != "win32":
        raise OSError("PE resources must be embedded on Windows")
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.BeginUpdateResourceW.argtypes = [wintypes.LPCWSTR, wintypes.BOOL]
    api.BeginUpdateResourceW.restype = wintypes.HANDLE
    api.UpdateResourceW.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, wintypes.WORD, ctypes.c_void_p, wintypes.DWORD]
    api.UpdateResourceW.restype = wintypes.BOOL
    api.EndUpdateResourceW.argtypes = [wintypes.HANDLE, wintypes.BOOL]
    api.EndUpdateResourceW.restype = wintypes.BOOL
    handle = api.BeginUpdateResourceW(str(pathlib.Path(executable).resolve()), False)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    buffer = ctypes.create_string_buffer(data)
    try:
        if not api.UpdateResourceW(handle, 10, RESOURCE_ID, 0, buffer, len(data)):
            raise ctypes.WinError(ctypes.get_last_error())
    except BaseException:
        api.EndUpdateResourceW(handle, True)
        raise
    if not api.EndUpdateResourceW(handle, False):
        raise ctypes.WinError(ctypes.get_last_error())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", required=True, type=pathlib.Path)
    parser.add_argument("--config", required=True, type=pathlib.Path)
    args = parser.parse_args()
    embed(args.executable, validate_config(json.loads(args.config.read_text(encoding="utf-8-sig"))))


if __name__ == "__main__":
    main()
