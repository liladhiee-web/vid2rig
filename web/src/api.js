// Backend API helpers (upload + SSE progress).

export async function checkHealth() {
  const res = await fetch('/api/health')
  if (!res.ok) throw new Error('Backend unreachable')
  return res.json()
}

export function uploadVideo(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/process')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => {
      if (xhr.status === 200) {
        try {
          resolve(JSON.parse(xhr.responseText))
        } catch (err) {
          reject(new Error('Bad response from server'))
        }
      } else {
        reject(new Error(`Upload failed (HTTP ${xhr.status})`))
      }
    }
    xhr.onerror = () => reject(new Error('Upload failed — is the backend running?'))
    const form = new FormData()
    form.append('video', file)
    xhr.send(form)
  })
}

export function subscribeJobEvents(jobId, onEvent, onDone, onError) {
  const es = new EventSource(`/api/jobs/${jobId}/events`)
  let finished = false
  let errors = 0
  es.onopen = () => {
    errors = 0
  }
  es.onmessage = (e) => {
    errors = 0
    const data = JSON.parse(e.data)
    onEvent(data) // pings flow through; the caller decides whether to log them
    if (data.final) {
      finished = true
      es.close()
      onDone(data)
    }
  }
  es.onerror = () => {
    // EventSource auto-reconnects unless we close it. The tunnel may blip
    // (proxy idle timeout) while a long inference stage is silent — allow
    // several reconnect attempts before declaring the job lost.
    if (finished) return
    errors += 1
    if (errors >= 8) {
      es.close()
      onError?.(new Error('Connection to job lost'))
    }
  }
  return () => es.close()
}

export async function fetchResult(jobId) {
  const res = await fetch(`/api/jobs/${jobId}/result`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail || `Failed to fetch result (HTTP ${res.status})`)
  }
  return res.json()
}

/** Convert a legacy FBX (e.g. version 6.1) server-side via assimp -> GLB file. */
export async function convertFbxOnServer(file) {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/api/convert_fbx', { method: 'POST', body: form })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail || `Conversion failed (HTTP ${res.status})`)
  }
  const blob = await res.blob()
  const name = file.name.replace(/\.fbx$/i, '') + '.glb'
  return new File([blob], name, { type: 'model/gltf-binary' })
}

export function overlayUrl(jobId) {
  return `/api/jobs/${jobId}/overlay`
}
