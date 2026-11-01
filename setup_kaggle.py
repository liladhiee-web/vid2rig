"""Vid2Rig automated Kaggle GPU environment setup script.
Handles chumpy PEP 517 build isolation fix, GVHMR pipeline installation, and SMPL-X weights.
"""

import os
import subprocess
import sys
import urllib.request
from pathlib import Path


def run(cmd: str, env=None, check: bool = False) -> int:
    print(f"\n>> {cmd}", flush=True)
    res = subprocess.run(cmd, shell=True, env=env)
    return res.returncode


def main() -> None:
    root = Path(__file__).resolve().parent
    os.chdir(root)
    print("===================================================", flush=True)
    print("⚡ Vid2Rig: Setting up GVHMR Main Engine on Kaggle", flush=True)
    print("===================================================", flush=True)

    # 1. Create directories
    for d in ["uploads", "takes", "hq/weights", "hq/body_models/smplx"]:
        (root / d).mkdir(parents=True, exist_ok=True)

    env = os.environ.copy()
    env["PATH"] = f"/opt/conda/bin:{os.path.expanduser('~/.local/bin')}:{env.get('PATH', '')}"
    env["GVHMR_CHECKPOINTS"] = str(root / "hq" / "weights")
    env["GVHMR_BODY_MODELS"] = str(root / "hq" / "body_models")

    # 2. Node.js dependencies
    print("\n[1/5] Installing web server dependencies...", flush=True)
    run("npm install --omit=dev", env=env)

    # 3. Upgrade build tooling
    print("\n[2/5] Upgrading build tools (setuptools, wheel, numpy)...", flush=True)
    run(f'"{sys.executable}" -m pip install -q --upgrade pip setuptools wheel "numpy>=1.26"', env=env)

    # 4. Pre-install chumpy without build isolation (vital fix for PEP 517 build error on Python 3.10/3.11)
    print("\n[3/5] Pre-installing chumpy with build isolation bypassed...", flush=True)
    code = run(f'"{sys.executable}" -m pip install -q --no-build-isolation chumpy', env=env)
    if code != 0:
        code = run(f'"{sys.executable}" -m pip install -q --no-build-isolation "git+https://github.com/mattloper/chumpy.git"', env=env)
        if code != 0:
            run(f'"{sys.executable}" -m pip install -q chumpy-fix', env=env)

    # 5. Install GVHMR & Motion Pipeline
    print("\n[4/5] Installing GVHMR Main Engine dependencies...", flush=True)
    run(f'"{sys.executable}" -m pip install -q --no-build-isolation gvhmr==1.6.1 ultralytics fastapi uvicorn roma mediapipe', env=env)
    run(f'"{sys.executable}" -m pip install -q --no-deps "git+https://github.com/warmshao/WiLoR-mini"', env=env)
    run(f'"{sys.executable}" -m pip install -q --no-build-isolation "git+https://github.com/MaxLiu22/Motion2MixamoRig@2835dcdfba30e78a2610360b9b2a1e1121d85159"', env=env)

    # 6. Download SMPL-X Neutral Body Model
    print("\n[5/5] Downloading SMPL-X neutral body model...", flush=True)
    smplx_path = root / "hq" / "body_models" / "smplx" / "SMPLX_NEUTRAL.npz"
    if not smplx_path.exists():
        try:
            url = "https://huggingface.co/camenduru/SMPLer-X/resolve/main/SMPLX_NEUTRAL.npz"
            urllib.request.urlretrieve(url, str(smplx_path))
            print("✅ SMPLX_NEUTRAL.npz downloaded successfully.", flush=True)
        except Exception as e:
            print(f"⚠️ Direct download failed ({e}), attempting wget...", flush=True)
            run(f"wget -q -nc https://huggingface.co/camenduru/SMPLer-X/resolve/main/SMPLX_NEUTRAL.npz -O {smplx_path}", env=env)

    # 7. Checkpoints and verification
    run("gvhmr download demo", env=env)
    run(f'"{sys.executable}" -m gvhmr.cli.demo download', env=env)
    run(f'"{sys.executable}" -c "import gvhmr; print(\'✅ GVHMR loaded successfully!\')"', env=env)

    print("\n===================================================", flush=True)
    print("✅ Vid2Rig GVHMR Setup Complete! Ready for Step 4.", flush=True)
    print("===================================================", flush=True)


if __name__ == "__main__":
    main()
