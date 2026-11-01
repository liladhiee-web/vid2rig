# Prompt2Rig — 3D Motion Capture & Mixamo Rigging Studio

<p align="center">
  <b>Upload any video clip. Track 3D body and hand motion smoothly in real-time, retarget onto Mixamo characters, and export to GLB or BVH.</b><br>
  Runs lag-free in your browser with MediaPipe, connects optionally to a local or Kaggle GPU GVHMR worker, and exports universal motion data.
</p>

---

## ⚡ Features & Updates

- **Video Upload Workflow:** AI video generation has been removed in favor of a clean, direct video upload pipeline (MP4, WebM, MOV) with instant local playback and HTTP 206 Partial Content range streaming.
- **Cyber Green & Black Theme:** Modern obsidian-black and cyber neon green interface with glowing accents, styled dropzones, and cyber-grid 3D stage lighting.
- **Lag-Free & Smooth MediaPipe Pipeline:**
  - Fixed canvas backing store reallocation lag (no per-frame texture resizing stalls).
  - Pre-allocated scratch vectors to eliminate garbage collection pauses.
  - Clamped reflector texture resolution and optimized shadow maps for steady 60fps rendering.
- **Real-Time Generating / Processing Loading:** High-tech modal radar spinner with dynamic scan-line progress tracking every stage: Uploading &rarr; MediaPipe Pose Extraction &rarr; Skeleton Retargeting &rarr; HQ GPU Solving.
- **Dual Export Formats (GLB & BVH):**
  - **↓ GLB:** Skinned 3D character mesh + baked keyframe animation.
  - **↓ BVH:** Industry-standard Biovision Hierarchy motion capture file directly importable into Blender, Unreal Engine 5, Maya, MotionBuilder, Daz3D, and Cascadeur.
- **Kaggle Free GPU + Cloudflare Tunnel:**
  - One-click Jupyter notebook (`kaggle_prompt2rig.ipynb`) to run on Kaggle's free T4/P100 GPUs with an automated HTTPS Cloudflare quick tunnel.

---

## 🚀 Quick Start (Local)

**Requirements:** Node.js 18+

```bash
git clone https://github.com/liladhiee-web/vid2rig.git && cd vid2rig
npm install
node server.mjs               # → http://localhost:5177
```

Open `http://localhost:5177` in your browser. Drag and drop any video clip to immediately capture 3D motion and retarget onto Mixamo characters!

---

## ☁️ Running on Free Kaggle GPU (Cloudflare Tunnel)

You can run the full Prompt2Rig studio on Kaggle's free GPUs (30 hours/week free NVIDIA T4 x2 or P100):

1. Go to [kaggle.com](https://www.kaggle.com) and create a new Notebook.
2. In the right-hand **Notebook settings**:
   - Set **Accelerator** to **GPU T4 x2** or **GPU P100**.
   - Set **Internet** to **ON** (required for tunnel and models).
3. Upload and open **[`kaggle_prompt2rig.ipynb`](file:///c:/Users/lilad/OneDrive/Documents/prompt2rig/kaggle_prompt2rig.ipynb)**.
4. Run all cells:
   - Node.js, ffmpeg, and `cloudflared` are automatically configured.
   - The server launches and prints a clickable **`https://*.trycloudflare.com`** URL.
5. Click the link to open Prompt2Rig over secure HTTPS!

Alternatively, launch the tunnel from terminal using:
```bash
python tools/kaggle_tunnel.py
```

---

## 🧠 HQ GPU Worker (GVHMR + WiLoR)

For research-grade SMPL body rotations and finger tracking:

1. **Setup dependencies:**
   ```powershell
   hq\setup.ps1
   ```
2. **Body model:** Put `SMPLX_NEUTRAL.npz` in `hq/body_models/smplx/` (from [smpl-x.is.tue.mpg.de](https://smpl-x.is.tue.mpg.de/)).
3. **Finger tracking (optional):**
   ```powershell
   hq\.venv\Scripts\python hq\setup_hands.py path/to/mano_v1_2.zip
   ```
4. **Start the worker:**
   ```powershell
   hq\.venv\Scripts\python hq\worker.py    # → http://127.0.0.1:5178
   ```

The web app automatically detects the worker and provides seamless live MediaPipe preview blending into the HQ GVHMR solver.

---

## 📦 Project Layout

| Path | Description |
|---|---|
| `server.mjs` | Zero-dependency Node server; video uploads, range streaming, take saving, HQ proxy |
| `public/index.html` | Cyber green & black UI, video dropzone, loading modal, take list |
| `public/app.js` | MediaPipe vision loop, retargeting solver, drag-and-drop, export handlers |
| `public/bvhExport.js` | Standard Mixamo BVH motion capture exporter |
| `public/stage.js` | 3D Three.js stage: neon green rim lighting, reflective floor, orbit camera |
| `public/retarget.js` | Mixamo skeleton solver: MediaPipe & SMPL rotations &rarr; bones, finger limits |
| `kaggle_prompt2rig.ipynb` | One-click ready notebook for Kaggle Free GPU with Cloudflare tunnel |
| `tools/kaggle_tunnel.py` | Automated Cloudflare quick tunnel runner |
| `hq/worker.py` | FastAPI worker for GVHMR body and WiLoR finger tracking |
| `takes/` | Saved exported `.glb`, `.bvh`, and metadata files |

---

## 📄 Exporting Mocap

- **↓ GLB:** Click on any take card or sidebar to download a self-contained `.glb` character with embedded skeletal animations.
- **↓ BVH:** Click `↓ BVH` to download clean Biovision Hierarchy data. In Blender:
  1. Open Blender &rarr; `File` &rarr; `Import` &rarr; `Biovision Hierarchy (.bvh)`
  2. Select your exported `.bvh` file.
  3. The full skeletal animation plays on standard Mixamo bone naming conventions!

---

## 📜 License

Prompt2Rig is open source under the **[Apache-2.0](LICENSE)** license. See third-party terms for optional research models (SMPL-X, MANO, GVHMR).
