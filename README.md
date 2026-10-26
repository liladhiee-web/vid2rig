# vid2rig — video → rig animation

Upload a rigged 3D character (**GLB / FBX**) + an input video, recover **world-grounded
human motion** with [GVHMR](https://github.com/zju3dv/GVHMR), retarget it onto your
character's skeleton, preview it in the browser, and export animation that works in
**three.js, Unity, UE5, Blender** and more.

```
 ┌─────────────┐      ┌──────────────────────┐      ┌──────────────────┐
 │ input video │ ───▶ │  GVHMR (GPU backend) │ ───▶ │ browser retarget │
 │ rigged .glb │      │  → SMPL params/frame │      │  + GLB/BVH export│
 └─────────────┘      └──────────────────────┘      └──────────────────┘
```

## How it works

| Stage | Where | What happens |
|---|---|---|
| 1 · Motion recovery | Backend (GPU) | Video → person detection/tracking → GVHMR inference → SMPL body pose per frame (`global_orient`, `body_pose`, `transl`) as JSON |
| 2 · Bone mapping | Browser | Character GLB/FBX parsed with three.js; 24 SMPL joints auto-mapped to your skeleton by name heuristics (Mixamo / UE / Rigify / Blender), with manual override |
| 3 · Retarget | Browser | Per-bone world rotations composed from the SMPL kinematic tree — **no SMPL model file needed on the client**. Optional per-bone bind-pose correction (handles A-pose characters), auto proportion scale, root motion on/off, ground offset, 180° flip |
| 4 · Export | Browser | **GLB** (animation clips, via `GLTFExporter`) and **BVH** (character's own hierarchy, ZXY euler) — both generated client-side, instant download |

The backend stays thin (inference only): your video never needs to meet your model
file on a server, previews are instant, and re-mapping is free.

## Repository layout

```
vid2rig/
├── server/            FastAPI backend (GVHMR inference + job progress via SSE)
│   ├── main.py        routes, static hosting of web/dist
│   └── gvhmr_service.py  pipeline wrapper + job manager
├── web/               Vite + React + three.js frontend
│   └── src/
│       ├── lib/       smpl.js · character.js · automap.js · retarget.js · exporters.js
│       └── components/  UploadPage · MappingPage · PreviewPage · Viewport
└── kaggle/            free-GPU launcher (bootstrap + tunnel + notebook)
```

## Quickstart — local (own NVIDIA GPU)

```bash
# 1. Backend (Python 3.10+)
python -m venv .venv && .venv\Scripts\activate      # Windows
pip install "gvhmr[preproc,cu124]"                  # or cu126 — match your driver
pip install -r server/requirements.txt
uvicorn server.main:app --host 0.0.0.0 --port 8000

# 2. Frontend
cd web
npm install
npm run dev           # → http://localhost:5173 (proxies /api to :8000)
```

SMPL body model files (registration-gated, see below) are located via the
`GVHMR_SMPL_DIR` / `SMPL_MODEL_DIR` environment variables.

## Quickstart — Kaggle (free T4 GPU, no local GPU needed)

1. **Register** (free) at [smpl-x.is.tue.mpg.de](https://smpl-x.is.tue.mpg.de/) and
   download the SMPL-X v1.1 models — the file `SMPLX_NEUTRAL.npz` is **required**
   for inference. (Optionally also register at
   [smpl.is.tue.mpg.de](https://smpl.is.tue.mpg.de/) and add `SMPL_NEUTRAL.pkl` —
   that is only needed for the overlay video.) Put the files in a **private Kaggle
   dataset** and attach it to the notebook.
2. Open `kaggle/vid2rig_launcher.ipynb` (or copy `kaggle/kaggle_bootstrap.py` into a
   notebook cell), set the accelerator to **GPU T4 x2** and enable **Internet**.
3. Provide the source either by setting `VID2RIG_REPO_URL` (your GitHub fork) or by
   attaching this repo as a Kaggle dataset (folder containing `server/` and `web/dist/`).
4. Run all cells → the bootstrap installs deps, copies the SMPL files, starts the
   backend and opens a **Cloudflare quick tunnel**, printing a `trycloudflare.com` URL.
   Open it and use the app.

Notes:
- The tunnel URL changes every session; the app is only reachable while the notebook
  runs (GPU quota is **30 h/week** — stop the session when done).
- No tunnel account or token needed — the bootstrap uses `cloudflared` quick tunnels
  only (outbound-only, so it works on Kaggle).

## Export format notes

- **GLB** — animation baked at video fps as clips; import natively in three.js,
  Unity (glTFast), UE5 (Interchange/glTF importer), Blender (glTF importer).
- **BVH** — full character hierarchy, root motion channels, ZXY euler, seconds-based
  frame time; import in Blender/MotionBuilder/any mocap tool.
- **FBX** — planned (headless `bpy` on the backend); GLB covers all four engines today.

## Limitations / roadmap

- Humanoid skeletons only (v1); arbitrary rigs need the manual mapping UI to cover
  every core joint.
- No foot-locking / IK polish yet — add post-processing (e.g., foot contact locking)
  as a follow-up.
- Auto-mapping is heuristic; unusual bone names → use the dropdowns.
- Multi-person videos are not supported (GVHMR demo is single-person).
- Overlay rendering requires a working GL/EGL context; on headless Kaggle it is
  best-effort and skipped if unavailable.

## Requirements

- Python 3.10+, NVIDIA GPU (T4-class or better; ~4 GB VRAM is plenty for inference)
- Node.js 18+ (frontend build only)
- ffmpeg available on the server machine (bundled on Kaggle)

## License & attribution

- Motion recovery: [GVHMR](https://github.com/zju3dv/GVHMR) (check its license) and
  the pip package [`gvhmr`](https://pypi.org/project/gvhmr/).
- SMPL body models are license-gated by Max Planck Institute — **never redistribute
  them**; keep your Kaggle dataset private.
- Frontend uses three.js (MIT), React (MIT).
