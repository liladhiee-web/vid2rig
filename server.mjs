// Prompt2Rig Server — zero-dependency Node.js server.
// Serves ./public, handles video uploads, serves with HTTP 206 range streaming,
// saves GLB/BVH takes, and proxies the local GVHMR HQ worker.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const TAKES = path.join(ROOT, 'takes');
const UPLOADS = path.join(ROOT, 'uploads');

fs.mkdirSync(TAKES, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });

// Background job store for GVHMR to prevent Cloudflare 125s Error 524 timeouts
const HQ_JOBS = new Map();

// --- .env -------------------------------------------------------------------
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const PORT = Number(process.env.PORT || 5177);
const HQ_URL = process.env.HQ_URL || 'http://127.0.0.1:5178';

// --- request handling helpers ------------------------------------------------
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 25e6) reject(new Error('body too large')); else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.bvh': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.woff2': 'font/woff2',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    // Video upload endpoint (supports binary body with x-filename header)
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const origName = decodeURIComponent(req.headers['x-filename'] || 'upload.mp4');
      const ext = (path.extname(origName) || '.mp4').toLowerCase();
      const safeBase = path.basename(origName, ext).replace(/[^a-z0-9_-]+/gi, '_').slice(0, 50) || 'video';
      const fname = `${Date.now()}_${safeBase}${ext}`;
      const outPath = path.join(UPLOADS, fname);
      const out = fs.createWriteStream(outPath);

      req.pipe(out);
      await new Promise((resolve, reject) => {
        out.on('finish', resolve);
        out.on('error', reject);
        req.on('error', reject);
      });

      const stat = fs.statSync(outPath);
      console.log(`[upload] saved uploads/${fname} (${(stat.size / (1024 * 1024)).toFixed(2)} MB)`);
      return send(res, 200, {
        url: `/uploads/${fname}`,
        filename: origName,
        size: stat.size,
      });
    }

    // Serve uploaded videos with HTTP 206 Partial Content (Range requests) for smooth seeking
    if (req.method === 'GET' && url.pathname.startsWith('/uploads/')) {
      const rel = decodeURIComponent(url.pathname.replace(/^\/uploads\//, ''));
      const filePath = path.normalize(path.join(UPLOADS, rel));
      if (!filePath.startsWith(UPLOADS) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      const stat = fs.statSync(filePath);
      const total = stat.size;
      const range = req.headers.range;
      const mimeType = MIME[path.extname(filePath)] || 'video/mp4';

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
        const chunksize = (end - start) + 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': mimeType,
          'Cache-Control': 'public, max-age=3600',
        });
        return fs.createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': total,
          'Accept-Ranges': 'bytes',
          'Content-Type': mimeType,
          'Cache-Control': 'public, max-age=3600',
        });
        return fs.createReadStream(filePath).pipe(res);
      }
    }

    // Save an exported take (.glb or .bvh) into ./takes
    if (req.method === 'POST' && url.pathname === '/api/takes') {
      const name = (url.searchParams.get('name') || 'take').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 80);
      const ext = url.searchParams.get('ext') === 'bvh' ? '.bvh' : '.glb';
      const chunks = []; let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 150e6) throw Object.assign(new Error('take too large'), { status: 413 });
        chunks.push(c);
      }
      const filename = name + ext;
      fs.writeFileSync(path.join(TAKES, filename), Buffer.concat(chunks));
      const meta = {
        name, ext,
        source: url.searchParams.get('source') || null,
        saved: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(TAKES, name + '.json'), JSON.stringify(meta, null, 2));
      console.log(`[take] saved takes/${filename}`);
      return send(res, 200, { path: `takes/${filename}` });
    }

    // HQ pass: forward to the local GVHMR worker (hq/worker.py)
    if (url.pathname === '/api/hq/health') {
      try {
        const r = await fetch(`${HQ_URL}/health`, { signal: AbortSignal.timeout(2500) });
        return send(res, 200, await r.json());
      } catch {
        return send(res, 200, { ok: false, error: 'worker offline' });
      }
    }

    // HQ job status polling endpoint (prevents Cloudflare 125s Error 524 timeouts)
    if (req.method === 'GET' && url.pathname === '/api/hq/job') {
      const jobId = url.searchParams.get('jobId');
      if (!jobId || !HQ_JOBS.has(jobId)) {
        return send(res, 404, { error: 'job not found' });
      }
      const job = HQ_JOBS.get(jobId);
      if (job.status === 'done') {
        return send(res, 200, { jobId, status: 'done', ...job.result });
      }
      if (job.status === 'error') {
        return send(res, 500, { jobId, status: 'error', error: job.error });
      }
      return send(res, 200, {
        jobId,
        status: 'running',
        elapsed: Math.round((Date.now() - job.createdAt) / 1000),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/hq') {
      const b = await readJson(req);
      let videoUrl = b.video_url;
      // Resolve relative upload URL to full local server URL
      if (videoUrl && videoUrl.startsWith('/uploads/')) {
        videoUrl = `http://127.0.0.1:${PORT}${videoUrl}`;
      }

      // Generate deterministic jobId based on video URL and hands option
      const jobId = crypto.createHash('md5').update(`${videoUrl}:${b.hands || ''}`).digest('hex').slice(0, 16);

      let job = HQ_JOBS.get(jobId);
      if (job && job.status === 'done') {
        return send(res, 200, { jobId, status: 'done', ...job.result });
      }
      if (job && job.status === 'error') {
        if (Date.now() - job.createdAt > 15000) {
          HQ_JOBS.delete(jobId);
          job = null;
        } else {
          return send(res, 500, { jobId, status: 'error', error: job.error });
        }
      }

      if (!job) {
        job = { status: 'running', createdAt: Date.now() };
        HQ_JOBS.set(jobId, job);

        console.log(`[hq] starting async GVHMR job ${jobId} for ${videoUrl}`);
        fetch(`${HQ_URL}/process`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ video_url: videoUrl, ...(b.hands ? { hands: b.hands } : {}) }),
        })
          .then(async (r) => {
            if (!r.ok) {
              const errText = await r.text();
              console.error(`[hq] job ${jobId} failed (${r.status}): ${errText}`);
              HQ_JOBS.set(jobId, { status: 'error', error: `GVHMR worker returned ${r.status}: ${errText}`, createdAt: Date.now() });
            } else {
              const data = await r.json();
              console.log(`[hq] job ${jobId} finished (${data.n} frames in ${data.elapsed?.toFixed(1) || '?'}s)`);
              HQ_JOBS.set(jobId, { status: 'done', result: data, createdAt: Date.now() });
            }
          })
          .catch((err) => {
            console.error(`[hq] job ${jobId} exception: ${err.message}`);
            HQ_JOBS.set(jobId, { status: 'error', error: err.message, createdAt: Date.now() });
          });
      }

      // Return 202 Accepted with jobId immediately so the client can poll without timing out
      return send(res, 202, { jobId, status: 'running' });
    }

    // Static files from ./public
    if (req.method === 'GET' || req.method === 'HEAD') {
      let p = decodeURIComponent(url.pathname);
      if (p === '/') p = '/index.html';
      const file = path.normalize(path.join(PUBLIC, p));
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file).pipe(res);
    }

    res.writeHead(405); res.end();
  } catch (err) {
    console.error('[error]', err.message);
    send(res, err.status && err.status < 600 ? err.status : 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`  Prompt2Rig Motion Capture Studio`);
  console.log(`  Web Server listening on http://localhost:${PORT}`);
  console.log(`==================================================\n`);
});
