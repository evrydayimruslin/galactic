"""
Ultralight GPU Harness — injected into every GPU container at build time.

Wraps the developer's function with structured error handling, timing,
and VRAM measurement. Conforms to RunPod's serverless worker protocol.

At startup, downloads developer code from R2 via the platform proxy,
writes files to /app, and installs requirements if present.

Output contract (matches RunPodHarnessOutput in runpod.ts):
{
    "success": bool,
    "exit_code": "success" | "oom" | "timeout" | "exception" | "infra_error",
    "result": <any>,
    "duration_ms": float,
    "peak_vram_gb": float,
    "logs": [str],
    "error": {"type": str, "message": str, "traceback": str} | None
}
"""

import importlib
import io
import json
import os
import signal
import subprocess
import sys
import time
import traceback
import urllib.request


# ---------------------------------------------------------------------------
# Startup: Download developer code from R2
# ---------------------------------------------------------------------------

def download_code():
    """
    Download developer code bundle from the platform proxy at container startup.

    Reads ULTRALIGHT_CODE_URL env var (set per-template by the platform).
    If not set, falls back to baked-in code (backward compat with test template).
    """
    code_url = os.environ.get("ULTRALIGHT_CODE_URL", "")
    if not code_url:
        print("[harness] No ULTRALIGHT_CODE_URL set — using baked-in code")
        return

    app_id = os.environ.get("ULTRALIGHT_APP_ID", "unknown")
    version = os.environ.get("ULTRALIGHT_VERSION", "unknown")
    secret = os.environ.get("ULTRALIGHT_PLATFORM_SECRET", "")

    print(f"[harness] Downloading code for {app_id}@{version}")
    print(f"[harness] URL: {code_url[:80]}...")

    try:
        # Fetch code bundle JSON from platform proxy
        req = urllib.request.Request(code_url)
        if secret:
            req.add_header("X-GPU-Secret", secret)
        req.add_header("User-Agent", "ultralight-harness/1.0")

        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            bundle = json.loads(raw)

        files = bundle.get("files", {})
        if not files:
            print("[harness] WARNING: Code bundle contains no files")
            return

        # Write each file to /app
        for filename, content in files.items():
            filepath = os.path.join("/app", filename)
            # Create subdirectories if needed (e.g., utils/helpers.py)
            dirpath = os.path.dirname(filepath)
            if dirpath and dirpath != "/app":
                os.makedirs(dirpath, exist_ok=True)
            with open(filepath, "w") as f:
                f.write(content)
            print(f"[harness]   wrote {filename} ({len(content)} bytes)")

        print(f"[harness] Downloaded {len(files)} files")

        # Install Python dependencies if requirements.txt is present
        if "requirements.txt" in files:
            print("[harness] Installing requirements.txt ...")
            result = subprocess.run(
                [sys.executable, "-m", "pip", "install",
                 "--no-cache-dir", "--quiet", "-r", "/app/requirements.txt"],
                capture_output=True,
                text=True,
                timeout=300,  # 5 minute timeout for pip install
            )
            if result.returncode != 0:
                stderr = result.stderr[:500] if result.stderr else "(no stderr)"
                print(f"[harness] pip install FAILED (exit {result.returncode}):")
                print(f"[harness]   {stderr}")
                raise RuntimeError(f"pip install failed: {stderr[:200]}")
            print("[harness] Requirements installed successfully")

        # Force reimport of main module (in case it was cached from baked-in version)
        if "main" in sys.modules:
            del sys.modules["main"]

    except urllib.error.HTTPError as e:
        print(f"[harness] FATAL: Code download HTTP error {e.code}: {e.reason}")
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"[harness] FATAL: Code download network error: {e.reason}")
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"[harness] FATAL: Code bundle is not valid JSON: {e}")
        sys.exit(1)
    except subprocess.TimeoutExpired:
        print("[harness] FATAL: pip install timed out after 300s")
        sys.exit(1)
    except RuntimeError as e:
        print(f"[harness] FATAL: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"[harness] FATAL: Unexpected error during code download: {e}")
        traceback.print_exc()
        sys.exit(1)


# ---------------------------------------------------------------------------
# VRAM tracking
# ---------------------------------------------------------------------------

def get_peak_vram_gb():
    """Read peak GPU VRAM usage via torch.cuda if available."""
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
    """Reset VRAM tracking before execution."""
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
    except ImportError:
        pass


# ---------------------------------------------------------------------------
# RunPod handler
# ---------------------------------------------------------------------------

def handler(event):
    """
    RunPod handler — receives input dict, returns structured result.

    Input format (from Ultralight platform):
    {
        "function": "function_name",   # Python function to call
        "args": { ... },               # Keyword arguments
        "max_duration_ms": 30000       # Execution timeout
    }
    """
    input_data = event.get("input", {})
    function_name = input_data.get("function", "main")
    args = input_data.get("args", {})
    max_duration_ms = input_data.get("max_duration_ms", 60000)

    # Capture stdout/stderr for logs
    captured = io.StringIO()
    old_stdout = sys.stdout
    old_stderr = sys.stderr
    sys.stdout = captured
    sys.stderr = captured

    max_duration_s = max_duration_ms / 1000.0

    try:
        # Reset VRAM stats before execution
        reset_vram_stats()

        # Import developer module (main.py in the container)
        dev_module = importlib.import_module("main")
        # Reload in case module was updated by download_code()
        importlib.reload(dev_module)
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

        # Set SIGALRM for hard timeout (Unix only, backup to RunPod's timeout)
        def timeout_handler(signum, frame):
            raise TimeoutError(
                f"Execution exceeded {max_duration_ms}ms limit"
            )

        signal.signal(signal.SIGALRM, timeout_handler)
        # Add 1s buffer to integer alarm (signal.alarm only takes int seconds)
        signal.alarm(int(max_duration_s) + 1)

        # Execute with timing
        start = time.perf_counter()
        if isinstance(args, dict):
            result = func(**args)
        elif isinstance(args, (list, tuple)):
            result = func(*args)
        else:
            result = func(args)
        duration_ms = (time.perf_counter() - start) * 1000

        # Cancel alarm
        signal.alarm(0)

        # Restore stdout/stderr
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
            "error": {
                "type": "TimeoutError",
                "message": str(e),
            },
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
            "error": {
                "type": "MemoryError",
                "message": str(e),
            },
        }

    except Exception as e:
        signal.alarm(0)
        sys.stdout = old_stdout
        sys.stderr = old_stderr

        # Detect CUDA OOM from exception message
        msg = str(e).lower()
        if "out of memory" in msg or ("cuda" in msg and "memory" in msg):
            exit_code = "oom"
        else:
            exit_code = "exception"

        tb = ""
        try:
            tb = traceback.format_exc()
        except Exception:
            tb = "(traceback unavailable)"

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
                "traceback": tb[:2000],
            },
        }


# ---------------------------------------------------------------------------
# Startup sequence
# ---------------------------------------------------------------------------

# 1. Download developer code for legacy templates. Baked GHCR images already
# include app code and dependencies at image build time.
if os.environ.get("ULTRALIGHT_BAKED_IMAGE") == "1":
    print("[harness] Baked image mode — skipping runtime code download")
else:
    download_code()

# 2. Import runpod AFTER code download (in case developer code patches it)
import runpod

# 3. Start RunPod serverless worker
runpod.serverless.start({"handler": handler})
