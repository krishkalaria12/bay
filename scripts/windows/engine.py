#!/usr/bin/env python3
"""Compatibility entry point for the Windows engine CLI and imported helpers."""
from pathlib import Path

# Execute in this namespace so existing importers can still replace helpers
# such as run/verify_checkout and REPO without a second module holding state.
__file__ = str(Path(__file__).resolve().parents[1] / "engine.py")
exec(compile(Path(__file__).read_bytes(), __file__, "exec"), globals())
