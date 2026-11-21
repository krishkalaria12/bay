#!/usr/bin/env python3
"""Verify an engine artifact before staging its runtime next to Bay.exe."""
import argparse
import importlib.util
import pathlib
import shutil

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("fetch_engine", HERE / "fetch-engine.py")
fetch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--engine", required=True, type=pathlib.Path)
parser.add_argument("--destination", required=True, type=pathlib.Path)
args = parser.parse_args()
fetch.verify(args.engine, fetch.engine.artifact_id())
args.destination.mkdir(parents=True, exist_ok=True)
shutil.copytree(args.engine / "runtime", args.destination, dirs_exist_ok=True)
shutil.copy2(args.engine / "manifest.json", args.destination / "engine-manifest.json")
