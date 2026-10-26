// Client-side export: GLB (with animation clips) and BVH.
import * as THREE from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'

export function exportGLB(character, clips, fileName = 'vid2rig.glb') {
  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter()
    const root = character.exportRoot || character.object3D
    exporter.parse(
      root,
      (result) => {
        const blob = new Blob([result], { type: 'model/gltf-binary' })
        download(blob, fileName)
        resolve()
      },
      (err) => reject(err),
      { binary: true, animations: clips, includeCustomExtensions: true },
    )
  })
}

const DEG = 180 / Math.PI
const EULER = new THREE.Euler()

export function exportBVH(character, bvhData, fileName = 'vid2rig.bvh') {
  const { order, parentOf, bind, frames, fps } = bvhData
  const lines = []
  const unitScale = detectUnitScale(character) // BVH offsets in the model's raw local units

  lines.push('HIERARCHY')
  const writeJoint = (name, indent, isRoot) => {
    const pad = '  '.repeat(indent)
    lines.push(`${pad}${isRoot ? 'ROOT' : 'JOINT'} ${name}`)
    lines.push(`${pad}{`)
    const localPos = bind[name].localPos
    lines.push(
      `${pad}  OFFSET ${fmt(localPos.x * unitScale)} ${fmt(localPos.y * unitScale)} ${fmt(localPos.z * unitScale)}`,
    )
    const children = order.filter((b) => parentOf[b] === name)
    if (isRoot) {
      lines.push(`${pad}  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation`)
    } else {
      lines.push(`${pad}  CHANNELS 3 Zrotation Xrotation Yrotation`)
    }
    if (children.length === 0) {
      // end site (zero-length keeps the leaf transform)
      lines.push(`${pad}  End Site`)
      lines.push(`${pad}  {`)
      lines.push(`${pad}    OFFSET 0 0 0`)
      lines.push(`${pad}  }`)
    } else {
      children.forEach((c) => writeJoint(c, indent + 1, false))
    }
    lines.push(`${pad}}`)
  }

  const rootBone = order[0]
  writeJoint(rootBone, 0, true)
  lines.push('MOTION')
  lines.push(`Frames: ${frames.length}`)
  lines.push(`Frame Time: ${(1 / fps).toFixed(6)}`)

  for (const frame of frames) {
    const parts = []
    if (frame.positions) {
      parts.push(
        fmt(frame.positions[0] * unitScale),
        fmt(frame.positions[1] * unitScale),
        fmt(frame.positions[2] * unitScale),
      )
    }
    for (const name of order) {
      // BVH euler order ZXY == three.js Euler order 'ZXY'
      EULER.setFromQuaternion(frame.rots[name], 'ZXY')
      parts.push(
        fmt(EULER.z * DEG),
        fmt(EULER.x * DEG),
        fmt(EULER.y * DEG),
      )
    }
    lines.push(parts.join(' '))
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
  download(blob, fileName)
}

/**
 * Mixamo-style FBX files often carry a 0.01 scale on the armature node, so
 * local bone positions are in centimeters while world positions are meters.
 * We detect the mismatch between local offsets and world-space bone length
 * to pick a consistent BVH unit (meters when possible).
 */
function detectUnitScale(character) {
  const bind = character.bind
  const root = character.rootBone
  const hipsChild = character.bones.find((b) => parentOfIs(b.name, root.name, character))
  if (!hipsChild) return 1
  const localLen = bind[hipsChild.name].localPos.length()
  const worldLen = bind[hipsChild.name].restWorldPos.distanceTo(bind[root.name].restWorldPos)
  if (localLen < 1e-8 || worldLen < 1e-8) return 1
  const ratio = worldLen / localLen
  return ratio > 0.05 && ratio < 20 ? ratio : 1
}

function parentOfIs(name, parentName, character) {
  return character.parentOf[name] === parentName
}

function fmt(n) {
  return (Math.round(n * 10000) / 10000).toString()
}

function download(blob, fileName) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}
