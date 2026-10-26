import React, { useEffect, useMemo, useState } from 'react'
import UploadPage from './components/UploadPage.jsx'
import PreviewPage from './components/PreviewPage.jsx'
import { checkHealth, fetchResult, subscribeJobEvents, uploadVideo } from './api.js'
import { loadCharacterFile, mixamoMapping } from './lib/character.js'

const DEFAULT_CHARACTER_URL = '/X Bot.fbx'
const STEP_LABELS = ['Inputs', 'Preview & Export']

export default function App() {
  const [health, setHealth] = useState(null)
  const [character, setCharacter] = useState(null) // { object3D, bones, parentOf, rootBone, bind, fileName, isDefault }
  const [motion, setMotion] = useState(null) // server motion JSON
  const [videoName, setVideoName] = useState('') // for export file naming
  const [job, setJob] = useState(null) // { id, status, message, progress, events }
  const [page, setPage] = useState('upload')

  // Health check
  useEffect(() => {
    checkHealth().then(setHealth).catch(() => setHealth({ gvhmr: false, cuda: false }))
  }, [])

  // Load the default Mixamo X Bot automatically
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(encodeURI(DEFAULT_CHARACTER_URL))
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buf = await res.arrayBuffer()
        const file = new File([buf], 'X Bot.fbx')
        const c = await loadCharacterFile(file)
        if (!cancelled) setCharacter({ ...c, isDefault: true })
      } catch (e) {
        console.warn('Default character failed to load:', e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Fixed Mixamo SMPL mapping, recomputed when the character changes
  const mixamoOptions = useMemo(() => {
    if (!character) return null
    const { mapping, missing } = mixamoMapping(character.bones)
    if (missing.length) return null
    return { mapping, autoCorrect: true }
  }, [character])

  const onCharacter = async (file) => {
    const loaded = await loadCharacterFile(file)
    setCharacter({ ...loaded, isDefault: false })
  }

  const onProcess = async (videoFile, onProgress) => {
    setMotion(null)
    setVideoName(videoFile.name.replace(/\.[^.]+$/, ''))
    const { job_id } = await uploadVideo(videoFile, onProgress)
    setJob({ id: job_id, status: 'queued', message: '', progress: 0, events: [] })

    return new Promise((resolve, reject) => {
      subscribeJobEvents(
        job_id,
        (e) =>
          setJob((j) => {
            if (!j || j.id !== job_id) return j
            const isPing = !!e.ping
            return {
              ...j,
              status: e.status,
              message: e.message,
              progress: e.progress,
              events: isPing ? j.events : [...(j.events || []), e],
            }
          }),
        async (e) => {
          if (e.status === 'error') {
            setJob((j) => ({ ...j, status: 'error', message: 'Job failed — see log' }))
            reject(new Error('Motion recovery failed'))
            return
          }
          try {
            const result = await fetchResult(job_id)
            setMotion(result)
            setPage('preview')
            resolve()
          } catch (err) {
            reject(err)
          }
        },
        (err) => reject(err),
      )
    })
  }

  const stepIndex = page === 'upload' ? 0 : 1

  return (
    <div className="app">
      <header className="topbar">
        <div className="logo">
          vid<span>2</span>rig
        </div>
        <div className="steps">
          {STEP_LABELS.map((label, i) => (
            <div key={label} className={`step ${i === stepIndex ? 'active' : i < stepIndex ? 'done' : ''}`}>
              {i + 1}. {label}
            </div>
          ))}
        </div>
      </header>

      {page === 'upload' && (
        <UploadPage
          character={character}
          mixamoReady={!!mixamoOptions}
          onCharacter={onCharacter}
          onProcess={onProcess}
          job={job}
          health={health}
        />
      )}

      {page === 'preview' && (
        <PreviewPage
          character={character}
          motion={motion}
          baseOptions={mixamoOptions}
          videoName={videoName}
          onBack={() => setPage('upload')}
          jobId={job?.id}
        />
      )}
    </div>
  )
}
