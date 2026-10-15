"""Compatibility entry point; rebuild the reviewed version, never the obsolete draft."""
from pathlib import Path
import runpy
runpy.run_path(str(Path(__file__).with_name('review_originals.py')), run_name='__main__')
