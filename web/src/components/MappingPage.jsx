import React, { useMemo, useState } from 'react'
import { autoMap } from '../lib/automap.js'
import { SMPL_NAMES } from '../lib/smpl.js'

export default function MappingPage({ character, motion, onApply, onBack }) {
  const initial = useMemo(
    () => autoMap(character.bones.map((b) => b.name)),
    [character],
  )
  const [mapping, setMapping] = useState(initial)
  const [autoCorrect, setAutoCorrect] = useState(true)

  const mappedCount = Object.values(mapping).filter(Boolean).length
  const boneNames = character.bones.map((b) => b.name)

  const coreJoints = [0, 1, 2, 4, 5, 7, 8, 12, 15, 16, 17, 18, 19, 20, 21]
  const hasCore = coreJoints.every((j) => mapping[j])

  return (
    <div className="panel">
      <h2>3 · Bone mapping</h2>
      <div className="statusline" style={{ marginBottom: 12 }}>
        Auto-mapped <b>{mappedCount}</b>/24 SMPL joints to “{character.fileName}”.
        {!hasCore && (
          <span className="bad"> Core joints missing — fix the red rows below.</span>
        )}
      </div>

      <div className="map-grid">
        {SMPL_NAMES.map((jointName, j) => (
          <div className="map-row" key={jointName}>
            <span className="joint">{jointName}</span>
            <select
              value={mapping[j] || ''}
              onChange={(e) =>
                setMapping((m) => ({ ...m, [j]: e.target.value || null }))
              }
            >
              <option value="">— unmapped —</option>
              {boneNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span className={mapping[j] ? 'ok' : 'missing'}>
              {mapping[j] ? '●' : '○'}
            </span>
          </div>
        ))}
      </div>

      <div className="options">
        <label>
          <input
            type="checkbox"
            checked={autoCorrect}
            onChange={(e) => setAutoCorrect(e.target.checked)}
          />
          Auto-correct bind pose (recommended for A-pose characters)
        </label>
      </div>

      <div className="options">
        <button className="ghost" onClick={onBack}>
          ← Back
        </button>
        <button
          className="primary"
          disabled={!hasCore}
          onClick={() => onApply({ mapping, autoCorrect })}
        >
          Apply & Preview →
        </button>
      </div>
    </div>
  )
}
