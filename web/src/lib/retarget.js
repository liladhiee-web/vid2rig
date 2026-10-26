// Core retargeting engine: SMPL motion -> character skeleton AnimationClip.
//
// Formula per mapped joint (world space, Y-up):
//   targetWorld(j) = smplWorldRot(j) * C(j) * targetRestWorld(j)
// where C(j) aligns the character's bind bone direction to the SMPL rest
// bone direction (optional "auto correct bind pose" for A-pose rigs).
// Local rotations are derived by dividing by the animated parent world.

import * as THREE from 'three'
import { SMPL_J, SMPL_NAMES, SMPL_PARENTS, smplWorldRotations } from './smpl.js'

const IDENTITY = new THREE.Quaternion()

export const DEFAULT_OPTIONS = {
  mapping: null,          // { smplJointIndex -> boneName | null }
  autoCorrect: true,      // align bind-pose directions per bone
  rootMotion: true,       // apply global translation to hips
  autoScale: true,        // scale motion to character proportions
  scaleMult: 1.0,
  groundOffset: 0.0,      // meters, applied to hips Y
  flipRoot: false,        // rotate motion 180° about Y (if character faces -Z)
}

/** Per-bone world-direction correction quaternions (computed once from bind pose). */
function computeCorrections(character, mapping) {
  const corr = []
  const bind = character.bind
  for (let j = 0; j < 24; j++) corr.push(new THREE.Quaternion())
  if (!opts_hasMapping(mapping)) return corr

  for (let j = 0; j < 24; j++) {
    const boneName = mapping[j]
    if (!boneName) continue
    // SMPL child joint (in the kinematic tree) that is also mapped
    let childJ = null
    for (let c = 0; c < 24; c++) {
      if (SMPL_PARENTS[c] === j && mapping[c]) {
        childJ = c
        break
      }
    }
    if (childJ === null) continue
    const childBone = mapping[childJ]

    const p0 = bind[boneName].restWorldPos
    const c0 = bind[childBone].restWorldPos
    const dirT = new THREE.Vector3().subVectors(c0, p0)
    const dirS = new THREE.Vector3(
      SMPL_J[childJ][0] - SMPL_J[j][0],
      SMPL_J[childJ][1] - SMPL_J[j][1],
      SMPL_J[childJ][2] - SMPL_J[j][2],
    )
    if (dirT.lengthSq() < 1e-10 || dirS.lengthSq() < 1e-10) continue
    dirT.normalize()
    dirS.normalize()
    corr[j].setFromUnitVectors(dirT, dirS)
  }
  return corr
}

function opts_hasMapping(mapping) {
  return mapping && Object.values(mapping).some(Boolean)
}

/** Auto scale factor from character proportions vs SMPL template. */
function computeScale(character, mapping, smpl) {
  const bind = character.bind
  const hips = mapping?.[0]
  const neck = mapping?.[12]
  if (!hips || !neck || !bind[hips] || !bind[neck]) return 1
  const charDist = bind[neck].restWorldPos.distanceTo(bind[hips].restWorldPos)
  const smplDist = new THREE.Vector3(...SMPL_J[12]).distanceTo(new THREE.Vector3(...SMPL_J[0]))
  if (smplDist < 1e-6 || charDist < 1e-6) return 1
  const k = charDist / smplDist
  // Sanity clamp: characters wildly out of proportion range stay at 1
  return k > 0.2 && k < 20 ? k : 1
}

/**
 * Build the retargeted AnimationClip.
 * @returns {THREE.AnimationClip}
 */
export function buildRetargetClip(motion, character, options) {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const mapping = opts.mapping
  if (!opts_hasMapping(mapping)) throw new Error('No bones mapped.')

  const smpl = motion.smpl
  const fps = motion.fps || 30
  const L = motion.num_frames

  const bind = character.bind
  const corr = opts.autoCorrect ? computeCorrections(character, mapping) : null
  const k = (opts.autoScale ? computeScale(character, mapping, smpl) : 1) * opts.scaleMult

  const FLIP = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    Math.PI,
  )

  const times = new Float32Array(L)
  for (let i = 0; i < L; i++) times[i] = i / fps

  // Accumulate local rotation keyframes per bone
  const localQuats = new Map() // boneName -> THREE.Quaternion[]
  for (let j = 0; j < 24; j++) {
    const b = mapping[j]
    if (b) localQuats.set(b, [])
  }
  const hipLocalPositions = mapping[0] ? [] : null

  // Per-frame world translations (SMPL pelvis)
  const meanXZ = new THREE.Vector3()
  if (!opts.rootMotion) {
    const acc = new THREE.Vector3()
    for (let f = 0; f < L; f++) acc.add(new THREE.Vector3(...smpl.transl[f]))
    meanXZ.copy(acc.multiplyScalar(1 / L))
    meanXZ.y = 0
  }

  const parentWorldCache = new Map()

  for (let f = 0; f < L; f++) {
    const worldQ = smplWorldRotations(smpl, f)
    if (opts.flipRoot) {
      for (let j = 0; j < 24; j++) worldQ[j] = FLIP.clone().multiply(worldQ[j])
    }

    // target world rotations, walking SMPL tree top-down (parents < children)
    const targetWorld = new Map()
    for (let j = 0; j < 24; j++) {
      const boneName = mapping[j]
      if (!boneName) continue
      const restWorld = bind[boneName].restWorldQuat
      const w = worldQ[j].clone()
      if (opts.autoCorrect) w.multiply(corr[j])
      w.multiply(restWorld)
      targetWorld.set(j, w)
      parentWorldCache.set(boneName, w)
    }

    // convert to local quats through the CHARACTER's hierarchy
    for (let j = 0; j < 24; j++) {
      const boneName = mapping[j]
      if (!boneName) continue
      const smplParent = SMPL_PARENTS[j]
      let parentWorld = null
      if (smplParent >= 0 && mapping[smplParent]) {
        parentWorld = parentWorldCache.get(mapping[smplParent])
      }
      if (!parentWorld) {
        const pBone = character.parentOf[boneName]
        parentWorld = pBone && bind[pBone] ? bind[pBone].restWorldQuat : IDENTITY
      }
      const local = parentWorld.clone().invert().multiply(targetWorld.get(j))
      localQuats.get(boneName).push(local)
    }

    // hips translation
    if (hipLocalPositions) {
      const hipsBone = mapping[0]
      const t = new THREE.Vector3(...smpl.transl[f])
      t.multiplyScalar(k)
      if (!opts.rootMotion) t.sub(meanXZ)
      t.y += opts.groundOffset
      if (opts.flipRoot) t.applyQuaternion(FLIP)

      // world position -> hips local position (relative to parent bind transform,
      // dividing out any scale the parent node carries, e.g. Armature 0.01)
      const pBone = character.parentOf[hipsBone]
      const pBind = pBone && bind[pBone] ? bind[pBone] : null
      const pw = pBind ? pBind.restWorldQuat : IDENTITY
      const pp = pBind ? pBind.restWorldPos : new THREE.Vector3()
      const local = t.clone().sub(pp).applyQuaternion(pw.clone().invert())
      if (pBind && Math.abs(pBind.scale - 1) > 1e-9) local.divideScalar(pBind.scale)
      hipLocalPositions.push(local)
    }
  }

  // Build tracks
  const tracks = []
  for (const [boneName, quats] of localQuats) {
    const values = new Float32Array(quats.length * 4)
    quats.forEach((q, i) => {
      values[i * 4] = q.x
      values[i * 4 + 1] = q.y
      values[i * 4 + 2] = q.z
      values[i * 4 + 3] = q.w
    })
    tracks.push(new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, values))
  }
  if (hipLocalPositions && mapping[0]) {
    const values = new Float32Array(hipLocalPositions.length * 3)
    hipLocalPositions.forEach((v, i) => {
      values[i * 3] = v.x
      values[i * 3 + 1] = v.y
      values[i * 3 + 2] = v.z
    })
    tracks.push(new THREE.VectorKeyframeTrack(`${mapping[0]}.position`, times, values))
  }

  return new THREE.AnimationClip('vid2rig', L / fps, tracks)
}

/** Everything needed by the BVH exporter, in one pass over the same math. */
export function buildBVHData(motion, character, options) {
  const clip = buildRetargetClip(motion, character, options)
  const fps = motion.fps || 30
  const L = motion.num_frames
  const mapping = options.mapping

  // Read back local rotations per frame from the clip tracks
  const localPerBone = new Map()
  clip.tracks.forEach((track) => {
    if (!track.name.endsWith('.quaternion')) return
    const boneName = track.name.slice(0, -'.quaternion'.length)
    localPerBone.set(boneName, track.values)
  })

  const hipTrack = clip.tracks.find((t) => t.name.endsWith('.position'))

  // Bones included in BVH: whole character hierarchy from skeleton root,
  // rotations rest for unmapped bones.
  const order = []
  const visit = (name) => {
    if (!name) return
    order.push(name)
    character.bones
      .filter((b) => character.parentOf[b.name] === name)
      .forEach((b) => visit(b.name))
  }
  visit(character.rootBone.name)

  const frames = []
  for (let f = 0; f < L; f++) {
    const frame = { positions: null, rots: {} }
    if (hipTrack) {
      frame.positions = [
        hipTrack.values[f * 3],
        hipTrack.values[f * 3 + 1],
        hipTrack.values[f * 3 + 2],
      ]
    }
    order.forEach((boneName) => {
      const q = new THREE.Quaternion()
      if (localPerBone.has(boneName)) {
        const vals = localPerBone.get(boneName)
        q.set(vals[f * 4], vals[f * 4 + 1], vals[f * 4 + 2], vals[f * 4 + 3])
      } else {
        q.copy(character.bind[boneName].localQuat)
      }
      frame.rots[boneName] = q
    })
    frames.push(frame)
  }

  return { order, parentOf: character.parentOf, bind: character.bind, frames, fps, mapping }
}

export { SMPL_NAMES }
