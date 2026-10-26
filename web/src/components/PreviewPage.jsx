import React, { useEffect, useMemo, useState } from 'react'
import Viewport from './Viewport.jsx'
import { buildBVHData, buildRetargetClip } from '../lib/retarget.js'
import { exportBVH, exportGLB } from '../lib/exporters.js'
import { overlayUrl } from '../api.js'
import { SMPL_NAMES, SMPL_INDEX } from '../lib/smpl.js'

const JOINT_BY_INDEX = Object.fromEntries(SMPL_NAMES.map((n, i) => [i, n]))

export default function PreviewPage({ character, motion, baseOptions, videoName, onBack, jobId }) {
  const [opts, setOpts] = useState({
    rootMotion: true,
    autoCorrect: baseOptions.autoCorrect,
    groundOffset: 0,
    scaleMult: 1,
    flipRoot: false,
  })

  const options = useMemo(
    () => ({ ...baseOptions, ...opts }),
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
  const [showMapping, setShowMapping] = useState(false)

  const base = (ext) => `${videoName || 'motion'}.${ext}`

  const doExportGLB = async (withAnim) => {
    setExporting(withAnim ? 'GLB' : 'charGLB')
    setError('')
    try {
      await exportGLB(character, withAnim ? [clip] : [], base(withAnim ? 'anim.glb' : 'rig.glb'))
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
      exportBVH(character, data, base('bvh'))
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
              Bind-pose auto-correct (T-pose alignment)
            </label>
            <label>
              <input
                type="checkbox"
                checked={opts.flipRoot}
                onChange={(e) => setOpts((o) => ({ ...o, flipRoot: e.target.checked }))}
              />
              Flip 180° (walks backward?)
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
          <h2>Export — model + separate animation files</h2>
          <div className="export-buttons">
            <button className="primary" onClick={() => doExportGLB(true)} disabled={!!exporting}>
              {exporting === 'GLB' ? 'Exporting…' : `⬇ ${videoName || 'motion'}.anim.glb — clip on rig`}
            </button>
            <button className="secondary" onClick={() => doExportGLB(false)} disabled={!!exporting}>
              {exporting === 'charGLB' ? 'Exporting…' : `⬇ ${character.fileName.replace(/\.[^.]+$/, '')}.rig.glb — character only`}
            </button>
            <button className="secondary" onClick={doExportBVH} disabled={!!exporting}>
              {exporting === 'BVH' ? 'Exporting…' : `⬇ ${videoName || 'motion'}.bvh — motion only`}
            </button>
            <button className="ghost" onClick={onBack}>
              ← New video
            </button>
          </div>
          {error && <div className="statusline error" style={{ marginTop: 10 }}>{error}</div>}
          <div className="statusline" style={{ marginTop: 10 }}>
            <b>.rig.glb</b> — the rigged character (no animation) for three.js.
            <br />
            <b>.anim.glb</b> — this clip baked on the rig; import into three.js, Unity (glTFast) or UE5 (Interchange) and combine with the rig.
            <br />
            <b>.bvh</b> — motion-only file for Blender/MotionBuilder retargeting.
          </div>
        </div>

        <div className="panel">
          <h2>Source check</h2>
          <div className="statusline">
            {motion.num_frames} frames · {motion.fps?.toFixed(1)} fps · {motion.duration_s?.toFixed(1)}s
            {jobId && (
              <>
                {' · '}
                <a href={overlayUrl(jobId)} target="_blank" rel="noreferrer">
                  GVHMR overlay
                </a>
              </>
            )}
          </div>
        </div>

        <div className="panel">
          <h3 style={{ cursor: 'pointer' }} onClick={() => setShowMapping((s) => !s)}>
            Advanced — bone mapping {showMapping ? '▾' : '▸'}
          </h3>
          {showMapping && (
            <div className="job-log" style={{ maxHeight: 220 }}>
              {Object.entries(baseOptions.mapping).map(([idx, bone]) => (
                <div key={idx}>
                  {JOINT_BY_INDEX[+idx]} → {bone}
                </div>
              ))}
            </div>
          )}
          {!showMapping && (
            <div className="statusline">
              Auto-detected Mixamo armature — {Object.keys(baseOptions.mapping).length} SMPL joints mapped.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
