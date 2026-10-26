import React, { useEffect, useMemo, useState } from 'react'
import Viewport from './Viewport.jsx'
import { buildBVHData, buildRetargetClip, DEFAULT_OPTIONS } from '../lib/retarget.js'
import { exportBVH, exportGLB } from '../lib/exporters.js'
import { overlayUrl } from '../api.js'
import { SMPL_NAMES } from '../lib/smpl.js'

export default function PreviewPage({ character, motion, baseOptions, onBack, jobId }) {
  const [opts, setOpts] = useState({
    rootMotion: true,
    autoCorrect: baseOptions.autoCorrect,
    groundOffset: 0,
    scaleMult: 1,
    flipRoot: false,
  })

  const options = useMemo(
    () => ({
      ...baseOptions,
      ...opts,
    }),
    [baseOptions, opts],
  )

  const clip = useMemo(
    () => buildRetargetClip(motion, character, options),
    [motion, character, options],
  )

  const [playing, setPlaying] = useState(true)
  const [time, setTime] = useState(0)
  const duration = motion.num_frames / (motion.fps || 30)
  const [exporting, setExporting] = useState('')
  const [error, setError] = useState('')

  const doExportGLB = async () => {
    setExporting('GLB')
    setError('')
    try {
      await exportGLB(character, [clip], 'vid2rig.glb')
    } catch (e) {
      setError(`GLB export failed: ${e.message || e}`)
    }
    setExporting('')
  }

  const doExportBVH = () => {
    setExporting('BVH')
    setError('')
    try {
      const data = buildBVHData(motion, character, options)
      exportBVH(character, data, 'vid2rig.bvh')
    } catch (e) {
      setError(`BVH export failed: ${e.message || e}`)
    }
    setExporting('')
  }

  return (
    <div className="preview-layout">
      <div>
        <div className="viewport-box">
          <Viewport
            character={character}
            clip={clip}
            playing={playing}
            time={time}
            onTimeUpdate={setTime}
            duration={duration}
          />
          <div className="viewport-toolbar">
            <button className="secondary" onClick={() => setPlaying((p) => !p)}>
              {playing ? '⏸' : '▶'}
            </button>
            <input
              type="range"
              min={0}
              max={duration}
              step={1 / (motion.fps || 30)}
              value={Math.min(time, duration)}
              onChange={(e) => {
                setPlaying(false)
                setTime(parseFloat(e.target.value))
              }}
            />
            <span style={{ minWidth: 90, color: 'var(--muted)' }}>
              {time.toFixed(1)}s / {duration.toFixed(1)}s
            </span>
          </div>
        </div>
      </div>

      <div className="sidebar">
        <div className="panel">
          <h2>Animation options</h2>
          <div className="options" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <label>
              <input
                type="checkbox"
                checked={opts.rootMotion}
                onChange={(e) => setOpts((o) => ({ ...o, rootMotion: e.target.checked }))}
              />
              Global root motion (walk trajectory)
            </label>
            <label>
              <input
                type="checkbox"
                checked={opts.autoCorrect}
                onChange={(e) => setOpts((o) => ({ ...o, autoCorrect: e.target.checked }))}
              />
              Bind-pose auto-correct
            </label>
            <label>
              <input
                type="checkbox"
                checked={opts.flipRoot}
                onChange={(e) => setOpts((o) => ({ ...o, flipRoot: e.target.checked }))}
              />
              Flip 180° (character walks backward?)
            </label>
            <label>
              Ground offset
              <input
                type="range"
                min={-0.5}
                max={0.5}
                step={0.01}
                value={opts.groundOffset}
                onChange={(e) => setOpts((o) => ({ ...o, groundOffset: parseFloat(e.target.value) }))}
              />
              <span className="val">{opts.groundOffset.toFixed(2)}m</span>
            </label>
            <label>
              Scale
              <input
                type="range"
                min={0.25}
                max={3}
                step={0.05}
                value={opts.scaleMult}
                onChange={(e) => setOpts((o) => ({ ...o, scaleMult: parseFloat(e.target.value) }))}
              />
              <span className="val">{opts.scaleMult.toFixed(2)}×</span>
            </label>
          </div>
        </div>

        <div className="panel">
          <h2>Export</h2>
          <div className="export-buttons">
            <button className="primary" onClick={doExportGLB} disabled={!!exporting}>
              {exporting === 'GLB' ? 'Exporting…' : '⬇ GLB (three.js / Unity / UE5 / Blender)'}
            </button>
            <button className="secondary" onClick={doExportBVH} disabled={!!exporting}>
              {exporting === 'BVH' ? 'Exporting…' : '⬇ BVH (Blender / MotionBuilder)'}
            </button>
            <button className="ghost" onClick={onBack}>
              ← Re-map bones
            </button>
          </div>
          {error && <div className="statusline error" style={{ marginTop: 10 }}>{error}</div>}
          <div className="statusline" style={{ marginTop: 10 }}>
            GLB imports natively into three.js, Unity (glTFast), UE5 (Interchange) and Blender.
            BVH uses the character's own hierarchy.
          </div>
        </div>

        {jobId && (
          <div className="panel">
            <h2>Source check</h2>
            <a href={overlayUrl(jobId)} target="_blank" rel="noreferrer">
              ▶ GVHMR overlay video
            </a>
            <div className="statusline">
              {motion.num_frames} frames · {motion.fps?.toFixed(1)} fps · {motion.duration_s?.toFixed(1)}s
            </div>
          </div>
        )}

        <div className="panel">
          <h2>Mapped joints</h2>
          <div className="statusline">
            {SMPL_NAMES.map((n, j) => (baseOptions.mapping[j] ? `${n}→${baseOptions.mapping[j]}` : null))
              .filter(Boolean)
              .join(', ')}
          </div>
        </div>
      </div>
    </div>
  )
}
