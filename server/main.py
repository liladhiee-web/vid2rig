"""
vid2rig backend — FastAPI app.

Endpoints:
  GET  /api/health          -> service info (GPU, gvhmr status)
  POST /api/process         -> upload a video, starts an inference job
  GET  /api/jobs/{id}/events -> SSE progress stream
  GET  /api/jobs/{id}/result -> motion JSON (SMPL params per frame)
  GET  /api/jobs/{id}/overlay -> rendered overlay video (if available)
  GET  /                     -> frontend build (web/dist) when present

Run:  uvicorn server.main:app --host 0.0.0.0 --port 8000
"""

import asyncio
import json
import os
import time

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import gvhmr_service as svc

app = FastAPI(title="vid2rig", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # dev convenience; tunnel use is same-origin anyway
    allow_methods=["*"],
    allow_headers=["*"],
)

MAX_UPLOAD_MB = 400


@app.get("/api/health")
def health():
    return {**svc.service_info(), "status": "ok", "jobs": len(svc.JOBS)}


@app.post("/api/process")
async def process(video: UploadFile = File(...)):
    data = await video.read()
    if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"Video larger than {MAX_UPLOAD_MB} MB")
    job = svc.create_job(data, video.filename or "input.mp4")
    return {"job_id": job.id}


@app.get("/api/jobs/{job_id}/events")
async def job_events(job_id: str):
    job = svc.get_job(job_id)
    if not job:
        raise HTTPException(404, "Unknown job")

    async def stream():
        seen = 0
        last_sent = time.time()
        while True:
            with svc.JOBS_LOCK:
                events = list(job.events[seen:])
                seen += len(events)
                done = job.status in ("done", "error")
            for e in events:
                yield f"data: {json.dumps(e)}\n\n"
                last_sent = time.time()
            if done:
                yield f"data: {json.dumps({'status': job.status, 'final': True})}\n\n"
                return
            # Heartbeat: proxies (Cloudflare) drop connections idle > ~100s,
            # and inference stages can be silent for minutes. Re-send the
            # current status periodically so the tunnel never goes idle.
            if time.time() - last_sent > 15:
                with svc.JOBS_LOCK:
                    yield (
                        "data: "
                        + json.dumps(
                            {
                                "time": time.time(),
                                "status": job.status,
                                "message": job.message,
                                "progress": job.progress,
                                "ping": True,
                            }
                        )
                        + "\n\n"
                    )
                last_sent = time.time()
            await asyncio.sleep(0.4)

    return StreamingResponse(
        stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"}
    )


@app.get("/api/jobs/{job_id}/result")
def job_result(job_id: str):
    job = svc.get_job(job_id)
    if not job:
        raise HTTPException(404, "Unknown job")
    if job.status != "done" or not job.result_path:
        raise HTTPException(409, f"Job not finished (status={job.status})")
    with open(job.result_path) as f:
        return json.load(f)


@app.get("/api/jobs/{job_id}/overlay")
def job_overlay(job_id: str):
    job = svc.get_job(job_id)
    if not job:
        raise HTTPException(404, "Unknown job")
    if getattr(job, "overlay_path", "") and os.path.exists(job.overlay_path):
        return FileResponse(job.overlay_path, media_type="video/mp4")
    raise HTTPException(404, "No overlay available")


# ---------------------------------------------------------------- frontend

_web_dist = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "web", "dist")
)
if os.path.isdir(_web_dist):
    app.mount(
        "/", StaticFiles(directory=_web_dist, html=True), name="frontend"
    )


@app.get("/")
def index():
    if not os.path.isdir(_web_dist):
        return {
            "name": "vid2rig backend",
            "hint": "Build the frontend (cd web && npm run build) or use the Vite dev server.",
        }
    raise HTTPException(404)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
