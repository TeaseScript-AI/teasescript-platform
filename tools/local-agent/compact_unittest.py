#!/usr/bin/env python3
"""Run unittest suites with compact success output and full failure diagnostics."""

from __future__ import annotations

import io
import sys
import unittest


class CompactTextTestRunner(unittest.TextTestRunner):
    """Capture normal unittest chatter and emit it only when the suite fails."""

    def __init__(self, *args: object, label: str, **kwargs: object) -> None:
        self._label = label
        self._captured = io.StringIO()
        kwargs.pop("stream", None)
        kwargs["verbosity"] = 2
        super().__init__(*args, stream=self._captured, **kwargs)

    def run(self, test: unittest.suite.TestSuite) -> unittest.result.TestResult:
        result = super().run(test)
        captured = self._captured.getvalue()
        if result.wasSuccessful():
            skipped = len(getattr(result, "skipped", ()))
            suffix = f", {skipped} skipped" if skipped else ""
            print(f"{self._label}: PASS ({result.testsRun} tests{suffix})")
        else:
            sys.stderr.write(captured)
            if captured and not captured.endswith("\n"):
                sys.stderr.write("\n")
        return result


def run_compact_unittest(label: str) -> None:
    """Discover tests in __main__ and exit with unittest's normal status."""

    class Runner(CompactTextTestRunner):
        def __init__(self, *args: object, **kwargs: object) -> None:
            super().__init__(*args, label=label, **kwargs)

    unittest.main(testRunner=Runner)
