export const GPU_BAKED_HARNESS_PY = String.raw`"""
Ultralight GPU Harness for baked GHCR images.

This harness runs inside a per-app image built by Ultralight. Dependencies are
installed at image-build time, so worker startup only imports app code and runs
the requested function.
"""

import importlib
import io
import signal
import sys
import time
import traceback


def get_peak_vram_gb():
    try:
        import torch
        if torch.cuda.is_available():
            peak_bytes = torch.cuda.max_memory_allocated()
            torch.cuda.reset_peak_memory_stats()
            return round(peak_bytes / (1024 ** 3), 3)
    except ImportError:
        pass
    return 0.0


def reset_vram_stats():
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
    except ImportError:
        pass


def handler(event):
    input_data = event.get("input", {})
    function_name = input_data.get("function", "main")
    args = input_data.get("args", {})
    max_duration_ms = input_data.get("max_duration_ms", 60000)

    captured = io.StringIO()
    old_stdout = sys.stdout
    old_stderr = sys.stderr
    sys.stdout = captured
    sys.stderr = captured

    try:
        reset_vram_stats()
        dev_module = importlib.import_module("main")
        func = getattr(dev_module, function_name, None)

        if func is None:
            sys.stdout = old_stdout
            sys.stderr = old_stderr
            return {
                "success": False,
                "exit_code": "exception",
                "result": None,
                "duration_ms": 0,
                "peak_vram_gb": 0.0,
                "logs": captured.getvalue().splitlines(),
                "error": {
                    "type": "AttributeError",
                    "message": f"Function '{function_name}' not found in main.py",
                },
            }

        def timeout_handler(signum, frame):
            raise TimeoutError(f"Execution exceeded {max_duration_ms}ms limit")

        signal.signal(signal.SIGALRM, timeout_handler)
        signal.alarm(int(max_duration_ms / 1000.0) + 1)

        start = time.perf_counter()
        if isinstance(args, dict):
            result = func(**args)
        elif isinstance(args, (list, tuple)):
            result = func(*args)
        else:
            result = func(args)
        duration_ms = (time.perf_counter() - start) * 1000
        signal.alarm(0)

        sys.stdout = old_stdout
        sys.stderr = old_stderr
        return {
            "success": True,
            "exit_code": "success",
            "result": result,
            "duration_ms": round(duration_ms, 2),
            "peak_vram_gb": get_peak_vram_gb(),
            "logs": captured.getvalue().splitlines(),
        }

    except TimeoutError as e:
        signal.alarm(0)
        sys.stdout = old_stdout
        sys.stderr = old_stderr
        return {
            "success": False,
            "exit_code": "timeout",
            "result": None,
            "duration_ms": max_duration_ms,
            "peak_vram_gb": get_peak_vram_gb(),
            "logs": captured.getvalue().splitlines(),
            "error": {"type": "TimeoutError", "message": str(e)},
        }

    except MemoryError as e:
        signal.alarm(0)
        sys.stdout = old_stdout
        sys.stderr = old_stderr
        return {
            "success": False,
            "exit_code": "oom",
            "result": None,
            "duration_ms": 0,
            "peak_vram_gb": get_peak_vram_gb(),
            "logs": captured.getvalue().splitlines(),
            "error": {"type": "MemoryError", "message": str(e)},
        }

    except Exception as e:
        signal.alarm(0)
        sys.stdout = old_stdout
        sys.stderr = old_stderr
        msg = str(e).lower()
        exit_code = "oom" if "out of memory" in msg or ("cuda" in msg and "memory" in msg) else "exception"
        return {
            "success": False,
            "exit_code": exit_code,
            "result": None,
            "duration_ms": 0,
            "peak_vram_gb": get_peak_vram_gb(),
            "logs": captured.getvalue().splitlines(),
            "error": {
                "type": str(type(e).__name__),
                "message": str(e)[:1000],
                "traceback": traceback.format_exc()[:2000],
            },
        }


import runpod

runpod.serverless.start({"handler": handler})
`;
