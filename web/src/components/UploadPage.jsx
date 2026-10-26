import React, { useState } from 'react'
import { convertFbxOnServer } from '../api.js'

export function Dropzone({ icon, title, hint, accept, onFile, fileName, disabled }) {
  const [dragover, setDragover] = useState(false)
  const inputRef = React.useRef(null)

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

export default function UploadPage({ character, mixamoReady, onCharacter, onProcess, job, health }) {
  const [videoFile, setVideoFile] = useState(null)
  const [uploadPct, setUploadPct] = useState(0)
  const [error, setError] = useState('')
  const [legacyFbx, setLegacyFbx] = useState(null)
  const [converting, setConverting] = useState(false)

  const canProcess = videoFile && !job && mixamoReady

  const start = async () => {
    setError('')
    try {
      await onProcess(videoFile, setUploadPct)
    } catch (e) {
      setError(e.message)
    }
  }

  const loadCharacter = async (f) => {
    setError('')
    setLegacyFbx(null)
    try {
      await onCharacter(f)
    } catch (e) {
      setError(e.message)
      if (/FBX is version/.test(e.message)) setLegacyFbx(f)
    }
  }

  const convertLegacyFbx = async () => {
    setConverting(true)
    setError('')
    try {
      const converted = await convertFbxOnServer(legacyFbx)
      await onCharacter(converted)
      setLegacyFbx(null)
    } catch (e) {
      setError(e.message)
    }
    setConverting(false)
  }

  return (
    <>
      <div className="panel">
        <h2>1 · Inputs</h2>
        <div className="dropzones">
          <Dropzone
            icon="🎬"
            title="Motion video"
            hint="MP4/WebM/MOV — one person, full body in frame"
            accept="video/*"
            onFile={setVideoFile}
            fileName={videoFile?.name}
          />
          <Dropzone
            icon="🧍"
            title={character?.isDefault ? 'Character — Mixamo X Bot (default)' : 'Replace with your own Mixamo character'}
            hint={
              character?.isDefault
                ? 'Default rigged character loaded — drop another Mixamo FBX/GLB to swap it'
                : '.glb / .fbx — must be Mixamo-rigged (mixamorig:* skeleton, with skin)'
            }
            accept=".glb,.gltf,.fbx"
            onFile={loadCharacter}
            fileName={character?.fileName}
          />
        </div>

        <div className="char-status">
          {character ? (
            mixamoReady ? (
              <span className="healthy">
                ✓ {character.fileName} — Mixamo armature detected ({character.bones.length} bones)
                {character.isDefault ? ' · default X Bot' : ''}
              </span>
            ) : (
              <span className="bad">✗ {character.fileName} — Mixamo skeleton not detected</span>
            )
          ) : (
            <span className="statusline">Loading default character…</span>
          )}
        </div>

        {legacyFbx && (
          <div className="options">
            <button className="secondary" disabled={converting} onClick={convertLegacyFbx}>
              {converting ? 'Converting on server…' : `🔧 Convert "${legacyFbx.name}" on the server (assimp → GLB)`}
            </button>
          </div>
        )}

        <div className="options" style={{ marginTop: 16 }}>
          <button className="primary" disabled={!canProcess} onClick={start}>
            {job ? 'Processing…' : 'Analyze video →'}
          </button>
        </div>
        {uploadPct > 0 && uploadPct < 1 && (
          <div className="progressbar">
            <div style={{ width: `${Math.round(uploadPct * 100)}%` }} />
          </div>
        )}
        {error && <div className="statusline error">{error}</div>}
        {!canProcess && videoFile && !mixamoReady && !character && (
          <div className="statusline">Waiting for the default character to load…</div>
        )}
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
