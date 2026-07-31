"""Operator tools — one-shot maintenance scripts, never imported by the service.

Anything in here is run by hand (``python -m service.tools.<name>``), may take
minutes, and must degrade with a NAMED reason on a box that lacks the model
stack rather than traceback at the operator.
"""
