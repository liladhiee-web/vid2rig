import React, { useEffect, useRef, useState } from 'react'

export function Dropzone({ icon, title, hint, accept, onFile, fileName, disabled }) {
  const [dragover, setDragover] = useState(false)
  const inputRef = useRef(null)

  return (
    <div
      className={`dropzone ${dragover ? 'dragover' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        if (!disabled) setDragover(true)
      }}
      onDragLeave={() => setDragover(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragover(false)
        if (disabled) return
        const f = e.dataTransfer.files?.[0]
        if (f) onFile(f)
      }}
      onClick={() => !disabled && inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onFile(f)
          e.target.value = ''
        }}
      />
      <div className="icon">{icon}</div>
      <h4>{title}</h4>
      <p>{hint}</p>
      {fileName && <div className="file-name">✓ {fileName}</div>}
    </div>
  )
}

export default function UploadPage({ character, onCharacter, onProcess, job, health }) {
  const [videoFile, setVideoFile] = useState(null)
  const [uploadPct, setUploadPct] = useState(0)
  const [error, setError] = useState('')

  const canProcess = videoFile && !job

  const start = async () => {
    setError('')
    try {
      await onProcess(videoFile, setUploadPct)
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <>
      <div className="panel">
        <h2>1 · Inputs</h2>
        <div className="dropzones">
          <Dropzone
            icon="🎬"
            title="Motion video"
            hint="MP4/WebM/MOV — a single person, full body in frame"
            accept="video/*"
            onFile={setVideoFile}
            fileName={videoFile?.name}
          />
          <Dropzone
            icon="🧍"
            title="Rigged character"
            hint=".glb / .gltf / .fbx — rigged humanoid (skinned mesh)"
            accept=".glb,.gltf,.fbx"
            onFile={async (f) => {
              setError('')
              try {
                await onCharacter(f)
              } catch (e) {
                setError(e.message)
              }
            }}
            fileName={character?.fileName}
          />
        </div>
        <div className="options" style={{ marginTop: 16 }}>
          <button
            className="primary"
            disabled={!canProcess}
            onClick={start}
          >
            {job ? 'Processing…' : 'Analyze video →'}
          </button>
          {character && (
            <span className="statusline">
              Character loaded: <b>{character.bones.length}</b> bones, root “
              {character.rootBone?.name}”
            </span>
          )}
        </div>
        {uploadPct > 0 && uploadPct < 1 && (
          <div className="progressbar">
            <div style={{ width: `${Math.round(uploadPct * 100)}%` }} />
          </div>
        )}
        {error && <div className="statusline error">{error}</div>}
      </div>

      <div className="panel">
        <h2>Backend status</h2>
        {health ? (
          <div className="statusline">
            <span className={health.gvhmr ? 'healthy' : 'bad'}>
              gvhmr: {health.gvhmr ? '✓ installed' : '✗ not installed'}
            </span>
            {' · '}
            <span className={health.cuda ? 'healthy' : 'bad'}>
              GPU: {health.cuda ? `✓ ${health.device}` : '✗ none'}
            </span>
            {' · '}
            <span className={health.body_models ? 'healthy' : 'bad'}>
              SMPL-X: {health.body_models ? '✓ found' : '✗ missing'}
            </span>
          </div>
        ) : (
          <div className="statusline">Checking…</div>
        )}
      </div>

      {job && (
        <div className="panel">
          <h2>2 · Motion recovery</h2>
          <div className="progressbar">
            <div
              style={{
                width: `${Math.max(4, Math.round(job.progress))}%`,
                opacity: job.status === 'error' ? 0.4 : 1,
              }}
            />
          </div>
          <div className={`statusline ${job.status === 'error' ? 'error' : ''}`}>
            {job.status === 'error' ? job.message : `${job.status}: ${job.message}`}
          </div>
          {job.events?.length > 1 && (
            <div className="job-log">
              {job.events.slice(-8).map((e, i) => (
                <div key={i}>
                  [{e.status}] {e.message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )
}
