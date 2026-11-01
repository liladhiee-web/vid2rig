#!/usr/bin/env python3
"""Prompt2Rig Cloudflare Tunnel Manager for Kaggle / Colab Free GPUs.

Starts a Cloudflare quick tunnel to expose the Prompt2Rig web server running on port 5177,
extracts the public https://*.trycloudflare.com URL, and displays it with a clean clickable banner.
"""

import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

PORT = int(os.environ.get("PORT", 5177))
ROOT = Path(__file__).resolve().parent.parent


def get_cloudflared_path() -> Path:
    # 1. Check system PATH
    sys_path = shutil.which("cloudflared")
    if sys_path:
        return Path(sys_path)

    # 2. Check local path
    local_bin = ROOT / "tools" / "cloudflared"
    if local_bin.exists() and os.access(local_bin, os.X_OK):
        return local_bin

    # 3. If in Linux (Kaggle / Colab / Ubuntu), download binary
    if sys.platform.startswith("linux"):
        print("[tunnel] Downloading cloudflared Linux binary...")
        url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
        try:
            local_bin.parent.mkdir(parents=True, exist_ok=True)
            urllib.request.urlretrieve(url, str(local_bin))
            local_bin.chmod(0o755)
            print("[tunnel] cloudflared downloaded successfully.")
            return local_bin
        except Exception as e:
            print(f"[tunnel] Failed to download cloudflared: {e}")

    # Fallback to just command name
    return Path("cloudflared")


def main():
    cloudflared = get_cloudflared_path()
    print(f"\n=======================================================")
    print(f"  Prompt2Rig - Cloudflare Quick Tunnel for Kaggle GPU")
    print(f"  Target Port: http://127.0.0.1:{PORT}")
    print(f"=======================================================\n")

    cmd = [
        str(cloudflared),
        "tunnel",
        "--url",
        f"http://127.0.0.1:{PORT}",
        "--no-autoupdate",
    ]

    print("[tunnel] Spawning tunnel process...")
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    url_found = False
    tunnel_url = None
    url_pattern = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")

    for line in proc.stdout:
        print(line, end="", flush=True)
        if not url_found:
            match = url_pattern.search(line)
            if match:
                tunnel_url = match.group(0)
                url_found = True
                print("\n" + "#" * 68)
                print(f"  >>> PROMPT2RIG WEB APP IS LIVE AT:")
                print(f"  >>> {tunnel_url}")
                print("#" * 68 + "\n")

                # If running inside a Jupyter / Kaggle notebook, display rich HTML
                try:
                    from IPython.display import HTML, display

                    html = f"""
                    <div style="background:#0a0f0d;border:2px solid #00ff88;padding:16px 20px;border-radius:6px;margin:15px 0;box-shadow:0 0 20px rgba(0,255,136,0.3);">
                        <h2 style="color:#00ff88;margin:0 0 8px 0;font-family:monospace;">Prompt2Rig is Live!</h2>
                        <p style="color:#e6f7ef;margin:0 0 12px 0;">Your free Kaggle GPU Cloudflare tunnel is ready:</p>
                        <a href="{tunnel_url}" target="_blank" style="background:#00ff88;color:#000;font-weight:bold;padding:10px 18px;text-decoration:none;border-radius:4px;display:inline-block;font-family:monospace;letter-spacing:0.5px;">
                            OPEN PROMPT2RIG STUDIO &rarr;
                        </a>
                        <p style="color:#769a87;font-size:12px;margin:12px 0 0 0;">URL: {tunnel_url}</p>
                    </div>
                    """
                    display(HTML(html))
                except Exception:
                    pass

    proc.wait()


if __name__ == "__main__":
    main()
