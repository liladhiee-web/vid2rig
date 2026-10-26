"""
vid2rig bootstrap for Kaggle.

Run this from kaggle/vid2rig_launcher.ipynb. It:
  1. Locates the vid2rig repo (git clone REPO_URL, or an attached Kaggle dataset).
  2. Installs server deps + the GVHMR package with the right CUDA extra.
  3. Copies gated SMPL body-model files from an attached private dataset.
  4. Starts the FastAPI backend and exposes it via a Cloudflare quick tunnel
     (or ngrok if NGROK_AUTH_TOKEN is set as a Kaggle secret).

Usage (single notebook cell):
    %run kaggle_bootstrap.py   # after uploading this file, or paste contents
"""

import glob
import os
import re
import shutil
import subprocess
import sys

REPO_URL = os.environ.get("VID2RIG_REPO_URL", "")
REPO_DIR = os.environ.get("VID2RIG_DIR", "/kaggle/working/vid2rig")
PORT = 8000


def step(msg):
    print(f"\n=== {msg} ===", flush=True)


# ---------------------------------------------------------------- 1. repo


def get_repo():
    step("Getting vid2rig source")
    if os.path.isdir(os.path.join(REPO_DIR, "server")):
        print(f"Using existing repo at {REPO_DIR}")
        return REPO_DIR

    # attached as a Kaggle dataset/utility-script?
    for candidate in glob.glob("/kaggle/input/*"):
        if os.path.isdir(os.path.join(candidate, "server")):
            shutil.copytree(candidate, REPO_DIR)
            print(f"Copied repo from dataset {candidate}")
            return REPO_DIR

    if REPO_URL:
        subprocess.run(
            ["git", "clone", "--depth", "1", REPO_URL, REPO_DIR], check=True
        )
        return REPO_DIR

    raise RuntimeError(
        "No vid2rig source found. Either attach it as a Kaggle dataset "
        "(named folder containing server/ and web/dist), or set VID2RIG_REPO_URL."
    )


# ---------------------------------------------------------------- 2. deps


def nvidia_driver_cuda():
    try:
        out = subprocess.run(
            ["nvidia-smi"], capture_output=True, text=True, timeout=30
        ).stdout
        m = re.search(r"CUDA Version:\s*(\d+\.\d+)", out)
        return float(m.group(1)) if m else None
    except Exception:
        return None


def torch_cuda_ok():
    try:
        import torch

        return torch.cuda.is_available()
    except Exception:
        return False


def _pip(*args, check=True):
    return subprocess.run(
        [sys.executable, "-m", "pip", "install", *args], check=check
    )


def install_deps(repo_dir):
    step("Installing dependencies")
    _pip(
        "-q",
        "fastapi>=0.110", "uvicorn[standard]>=0.29", "python-multipart>=0.0.9",
        "numpy>=1.26", "opencv-python-headless>=4.9",
    )

    # chumpy is legacy (setup.py uses distutils + pip internals) and cannot
    # build under PEP-517 isolation on Python 3.12+/numpy2. Pre-install it
    # WITHOUT build isolation so gvhmr's resolver sees it as satisfied and
    # never attempts its own (failing) build.
    step("Pre-installing legacy chumpy (--no-build-isolation)")
    r = _pip("chumpy", "--no-build-isolation", check=False)
    if r.returncode != 0:
        print(
            "WARNING: chumpy pre-install failed. If GVHMR later complains about\n"
            "legacy .pkl body models, convert them to .npz (chumpy-free) instead."
        )

    if not torch_cuda_ok():
        drv = nvidia_driver_cuda() or 12.4
        extra = "cu124" if drv < 12.6 else "cu126"
        print(f"Installing torch CUDA extra: {extra} (driver CUDA {drv})")
        args = [f"gvhmr[preproc,{extra}]"]
    else:
        print("System torch already sees the GPU — installing gvhmr[preproc] only")
        args = ["gvhmr[preproc]"]

    r = _pip(*args, check=False)
    if r.returncode != 0:
        print(
            "ERROR: gvhmr install failed — the backend will start but motion\n"
            "inference will be unavailable. Check /api/health and pip output above."
        )


# ---------------------------------------------------------------- 3. SMPL


def setup_smpl():
    step("Locating gated SMPL body models")
    hits = []
    for pattern in ("SMPL_NEUTRAL.pkl", "SMPL_NEUTRAL.npz", "SMPLX_NEUTRAL*.npz"):
        hits += glob.glob(f"/kaggle/input/**/{pattern}", recursive=True)
    if not hits:
        print(
            "WARNING: no SMPL body models found!\n"
            "  Register (free) at https://smpl-x.is.tue.mpg.de/ and "
            "https://smpl.is.tue.mpg.de/, download SMPL_NEUTRAL.pkl (and "
            "SMPLX_NEUTRAL.npz if desired), then add them as a PRIVATE Kaggle "
            "dataset and attach it to this notebook."
        )
        return
    dest = os.path.join(REPO_DIR, "smpl")
    os.makedirs(dest, exist_ok=True)
    for h in hits:
        target = os.path.join(dest, os.path.basename(h))
        if not os.path.exists(target):
            shutil.copy(h, target)
        print("  +", os.path.basename(h))
    os.environ["GVHMR_SMPL_DIR"] = dest
    os.environ["SMPL_MODEL_DIR"] = dest


# ---------------------------------------------------------------- 4. run


def start_server(repo_dir):
    step("Starting backend")
    os.chdir(repo_dir)
    sys.path.insert(0, repo_dir)
    import uvicorn  # noqa: E402

    from server.main import app  # noqa: E402

    import threading

    def _serve():
        uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")

    t = threading.Thread(target=_serve, daemon=True)
    t.start()


def start_tunnel():
    step("Opening Cloudflare tunnel (free, no account needed)")
    # Cloudflare quick tunnel — outbound-only, works on Kaggle with no token.
    bin_path = "/kaggle/working/cloudflared"
    if not os.path.exists(bin_path):
        subprocess.run(
            [
                "wget", "-q",
                "https://github.com/cloudflare/cloudflared/releases/latest/download/"
                "cloudflared-linux-amd64",
                "-O", bin_path,
            ],
            check=True,
        )
    os.chmod(bin_path, 0o755)
    proc = subprocess.Popen(
        [bin_path, "tunnel", "--url", f"http://localhost:{PORT}", "--no-autoupdate"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    url = None
    import time

    for _ in range(60):
        line = proc.stdout.readline()
        if not line:
            time.sleep(0.5)
            continue
        print(line.rstrip())
        m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
        if m:
            url = m.group(0)
            break
    if not url:
        raise RuntimeError("Tunnel failed to start")
    print(f"\n>>> vid2rig UI: {url}\n")
    return url


def bootstrap():
    repo_dir = get_repo()
    install_deps(repo_dir)
    setup_smpl()
    start_server(repo_dir)
    start_tunnel()
    print(
        "\nKeep this notebook running while you use the app. "
        "Remember the GPU quota (30h/week) — stop the session when done."
    )
    return repo_dir


if __name__ == "__main__":
    bootstrap()
