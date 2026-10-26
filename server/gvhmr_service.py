"""
GVHMR inference service.

Wraps the pip-installable `gvhmr` package (https://pypi.org/project/gvhmr/),
runs the world-grounded motion recovery pipeline on an uploaded video and
returns SMPL body parameters per frame as JSON.

The JSON motion format consumed by the frontend:
{
  "fps": 30.0,
  "num_frames": 250,
  "smpl": {
    "global_orient": [[ax, ay, az], ...],   # axis-angle (rad), length L
    "body_pose":     [[69 floats], ...],    # axis-angle for joints 1..23
    "betas":         [10 floats],
    "transl":        [[x, y, z], ...],      # global translation, meters
  }
}
"""

import json
import os
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Callable, Optional

import numpy as np

JOBS_ROOT = os.environ.get("VID2RIG_JOBS_DIR", os.path.join(os.getcwd(), "jobs"))

PIPELINE = None
PIPELINE_LOCK = threading.Lock()
DEVICE = os.environ.get("GVHMR_DEVICE", "")  # empty = auto


# ---------------------------------------------------------------- utilities


def _to_numpy(x) -> np.ndarray:
    if hasattr(x, "detach"):
        return x.detach().cpu().numpy()
    if hasattr(x, "numpy"):
        return x.cpu().numpy()
    return np.asarray(x)


def video_fps(path: str) -> float:
    try:
        import cv2

        cap = cv2.VideoCapture(path)
        fps = cap.get(cv2.CAP_PROP_FPS)
        cap.release()
        if fps and fps > 0:
            return float(fps)
    except Exception:
        pass
    return 30.0


# ---------------------------------------------------------------- job store


@dataclass
class Job:
    id: str
    status: str = "queued"  # queued | preprocessing | inferring | done | error
    message: str = ""
    progress: float = 0.0
    video_path: str = ""
    out_dir: str = ""
    result_path: str = ""
    overlay_path: str = ""
    error: str = ""
    created_at: float = field(default_factory=time.time)
    events: list = field(default_factory=list)


JOBS: dict = {}
JOBS_LOCK = threading.Lock()


def _set_status(job: Job, status: str, message: str = "", progress: float = None):
    job.status = status
    job.message = message
    if progress is not None:
        job.progress = float(progress)
    with JOBS_LOCK:
        job.events.append(
            {
                "time": time.time(),
                "status": job.status,
                "message": job.message,
                "progress": job.progress,
            }
        )
    print(f"[job {job.id}] {status}: {message}", flush=True)


# ---------------------------------------------------------------- pipeline


def _install_numpy_shims():
    """numpy>=1.24 removed aliases (np.bool, np.int, ...) that legacy packages
    (chumpy) still import at module level. Re-add them before importing gvhmr."""
    import numpy as np

    aliases = {
        "bool": bool, "int": int, "float": float, "complex": complex,
        "object": object, "unicode": str, "str": str,
    }
    for name, val in aliases.items():
        try:
            getattr(np, name)
        except AttributeError:
            setattr(np, name, val)


def get_pipeline():
    """Load (once) the GVHMR pipeline used for all jobs."""
    global PIPELINE
    with PIPELINE_LOCK:
        if PIPELINE is not None:
            return PIPELINE
        import torch

        _install_numpy_shims()
        try:
            import gvhmr  # noqa: F401
        except ImportError as e:
            raise RuntimeError(
                "The 'gvhmr' package is not installed. "
                "Install it with: pip install 'gvhmr[preproc]' "
                "(add a CUDA extra like cu124/cu126 on NVIDIA machines)."
            ) from e

        device = DEVICE or ("cuda" if torch.cuda.is_available() else "cpu")
        print(f"[gvhmr] loading pipeline on device={device} ...", flush=True)
        PIPELINE = gvhmr.pipeline("human-motion-recovery", device=device)
        print("[gvhmr] pipeline ready", flush=True)
        return PIPELINE


def _extract_motion(result, fps: float) -> dict:
    """Convert a GVHMR result object into our motion JSON dict."""
    spw = result.smpl_params_world
    keys = spw.keys() if hasattr(spw, "keys") else []

    def get(name):
        for k in (name, name.replace("_", ""), f"smpl_{name}"):
            if k in keys:
                return _to_numpy(spw[k])
        raise KeyError(
            f"Could not find '{name}' in gvhmr result. "
            f"Available keys: {list(keys)}"
        )

    global_orient = get("global_orient").reshape(-1, 3)
    num_frames = len(global_orient)

    # body_pose: SMPL joints 1..23 = 69 params/frame. GVHMR does not estimate
    # the two hand-end joints, so its output can be 63 (21 joints) per frame —
    # accept any multiple of 3 and zero-pad the missing trailing joints.
    bp = get("body_pose")
    per_frame = (bp.size // num_frames) if num_frames else 0
    if per_frame % 3 != 0:
        raise ValueError(
            f"Unexpected body_pose size {bp.size} for {num_frames} frames "
            f"({per_frame} per frame — not a multiple of 3)"
        )
    bp = bp.reshape(num_frames, per_frame)
    if per_frame < 69:
        padded = np.zeros((num_frames, 69), dtype=bp.dtype)
        padded[:, :per_frame] = bp
        bp = padded
    elif per_frame > 69:
        bp = bp[:, :69]
    body_pose = bp

    betas = get("betas").reshape(-1)[:10] if get("betas").size >= 10 else get("betas")
    transl = get("transl").reshape(-1, 3)

    num_frames = min(num_frames, len(body_pose), len(transl))
    return {
        "fps": fps,
        "num_frames": int(num_frames),
        "duration_s": num_frames / fps if fps else 0.0,
        "smpl": {
            "global_orient": global_orient[:num_frames].tolist(),
            "body_pose": body_pose[:num_frames].tolist(),
            "betas": np.asarray(betas).reshape(-1).tolist(),
            "transl": transl[:num_frames].tolist(),
        },
    }


def _run_job(job: Job):
    try:
        os.makedirs(job.out_dir, exist_ok=True)
        _set_status(job, "preprocessing", "Detecting/tracking people in video", 5)

        pipe = get_pipeline()
        _set_status(job, "inferring", "Running GVHMR world-grounded recovery", 20)

        result = pipe(job.video_path)

        _set_status(job, "inferring", "Extracting SMPL parameters", 85)
        motion = _extract_motion(result, video_fps(job.video_path))

        out_path = os.path.join(job.out_dir, "motion.json")
        with open(out_path, "w") as f:
            json.dump(motion, f)

        # Optional overlay video (best-effort; needs a working GL/EGL context)
        overlay = os.path.join(job.out_dir, "overlay.mp4")
        try:
            result.render(overlay)
            job.overlay_path = overlay if os.path.exists(overlay) else ""
        except Exception as e:  # noqa: BLE001
            print(f"[job {job.id}] overlay render skipped: {e}", flush=True)
            job.overlay_path = ""

        job.result_path = out_path
        _set_status(job, "done", f"{motion['num_frames']} frames @ {motion['fps']:.1f} fps", 100)
    except Exception as e:  # noqa: BLE001
        job.error = f"{type(e).__name__}: {e}\n{traceback.format_exc()}"
        _set_status(job, "error", job.error.splitlines()[-1] if job.error else str(e))
    finally:
        # Keep GPU memory tidy between jobs
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass


# ---------------------------------------------------------------- public API


def create_job(video_bytes: bytes, filename: str) -> Job:
    job_id = uuid.uuid4().hex[:12]
    out_dir = os.path.join(JOBS_ROOT, job_id)
    os.makedirs(out_dir, exist_ok=True)
    ext = os.path.splitext(filename)[1] or ".mp4"
    video_path = os.path.join(out_dir, f"input{ext}")
    with open(video_path, "wb") as f:
        f.write(video_bytes)

    job = Job(id=job_id, video_path=video_path, out_dir=out_dir)
    with JOBS_LOCK:
        JOBS[job_id] = job

    t = threading.Thread(target=_run_job, args=(job,), daemon=True)
    t.start()
    return job


def get_job(job_id: str) -> Optional[Job]:
    with JOBS_LOCK:
        return JOBS.get(job_id)


def service_info() -> dict:
    info = {
        "gvhmr": False,
        "cuda": False,
        "device": None,
        "body_models": False,
        "body_models_dir": None,
    }
    try:
        import torch

        info["cuda"] = torch.cuda.is_available()
        if info["cuda"]:
            info["device"] = torch.cuda.get_device_name(0)
    except Exception:
        pass
    try:
        import gvhmr  # noqa: F401

        info["gvhmr"] = True
    except Exception:
        pass
    bm = os.environ.get("GVHMR_BODY_MODELS", "")
    info["body_models_dir"] = bm or None
    info["body_models"] = os.path.isfile(
        os.path.join(bm, "smplx", "SMPLX_NEUTRAL.npz")
    )
    return info
