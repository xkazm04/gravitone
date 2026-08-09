"""``python -m service.tools`` -- the roster and the dispatcher.

Kept to three lines so the surface under test is `service.tools.cli`, which is
importable without executing anything.
"""
from __future__ import annotations

import sys

from service.tools.cli import main

if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
