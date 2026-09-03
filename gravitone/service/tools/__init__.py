"""Operator tools — one-shot maintenance scripts, never imported by the service.

Anything in here is run by hand, may take minutes, and must degrade with a
NAMED reason on a box that lacks the model stack rather than traceback at the
operator.

There is ONE door::

    python -m service.tools            # the roster: what each needs and writes
    python -m service.tools <command>  # run one

``service/tools/cli.py`` holds that roster (including ``basis``, which lives in
``service/emotion_basis.py``); the per-module ``python -m service.tools.<name>``
form still works and is printed beside every entry.
"""
