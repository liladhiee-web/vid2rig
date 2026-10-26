import React, { useEffect, useState } from 'react'
import UploadPage from './components/UploadPage.jsx'
import MappingPage from './components/MappingPage.jsx'
import PreviewPage from './components/PreviewPage.jsx'
import { checkHealth, fetchResult, subscribeJobEvents, uploadVideo } from './api.js'
import { loadCharacterFile } from './lib/character.js'

const STEP_LABELS = ['Inputs', 'Mapping', 'Preview & Export']

export default function App() {
  const [health, setHealth] = useState(null)
  const [character, setCharacter] = useState(null) // { object3D, bones, parentOf, rootBone, bind, fileName }
  const [motion, setMotion] = useState(null) // server motion JSON
  const [job, setJob] = useState(null) // { id, status, message, progress, events }
  const [mappingOptions, setMappingOptions] = useState(null)
  const [page, setPage] = useState('upload')

  useEffect(() => {
    checkHealth().then(setHealth).catch(() => setHealth({ gvhmr: false, cuda: false }))
  }, [])

  const onCharacter = async (file) => {
    const loaded = await loadCharacterFile(file)
    setCharacter(loaded)
    if (motion) setPage('map')
  }

  const onProcess = async (videoFile, onProgress) => {
    setMotion(null)
    const { job_id } = await uploadVideo(videoFile, onProgress)
    setJob({ id: job_id, status: 'queued', message: '', progress: 0, events: [] })

    return new Promise((resolve, reject) => {
      subscribeJobEvents(
        job_id,
        (e) =>
          setJob((j) =>
            j && j.id === job_id
              ? { ...j, status: e.status, message: e.message, progress: e.progress, events: [...(j.events || []), e] }
              : j,
          ),
        async (e) => {
          if (e.status === 'error') {
            setJob((j) => ({ ...j, status: 'error', message: 'Job failed — see log' }))
            reject(new Error('Motion recovery failed'))
            return
          }
          try {
            const result = await fetchResult(job_id)
            setMotion(result)
            setPage('map')
            resolve()
          } catch (err) {
            reject(err)
          }
        },
        (err) => reject(err),
      )
    })
  }

  const onApply = (opts) => {
    setMappingOptions(opts)
    setPage('preview')
  }

  const stepIndex = page === 'upload' ? 0 : page === 'map' ? 1 : 2

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
          onCharacter={onCharacter}
          onProcess={onProcess}
          job={job}
          health={health}
        />
      )}

      {page === 'map' && (
        <MappingPage
          character={character}
          motion={motion}
          onApply={onApply}
          onBack={() => setPage('upload')}
        />
      )}

      {page === 'preview' && (
        <PreviewPage
          character={character}
          motion={motion}
          baseOptions={mappingOptions}
          onBack={() => setPage('map')}
          jobId={job?.id}
        />
      )}
    </div>
  )
}
