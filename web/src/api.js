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
  es.onmessage = (e) => {
    const data = JSON.parse(e.data)
    onEvent(data)
    if (data.final) {
      finished = true
      es.close()
      onDone(data)
    }
  }
  es.onerror = () => {
    es.close()
    if (!finished) onError?.(new Error('Connection to job lost'))
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

export function overlayUrl(jobId) {
  return `/api/jobs/${jobId}/overlay`
}
