// Character model loading (GLB/FBX) + skeleton bind-pose extraction.
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'

export async function loadCharacterFile(file) {
  const name = file.name.toLowerCase()
  const buffer = await file.arrayBuffer()
  let object3D

  if (name.endsWith('.glb') || name.endsWith('.gltf')) {
    const loader = new GLTFLoader()
    const gltf = await new Promise((res, rej) =>
      loader.parse(buffer, '', res, rej),
    )
    object3D = gltf.scene
  } else if (name.endsWith('.fbx')) {
    // NOTE: FBXLoader.parse() is synchronous (returns the scene directly),
    // unlike GLTFLoader.parse() which uses callbacks.
    const loader = new FBXLoader()
    try {
      object3D = loader.parse(buffer, '')
    } catch (e) {
      const msg = e?.message || String(e)
      const version = msg.match(/FileVersion:\s*(\d+)/)?.[1]
      if (version && parseInt(version, 10) < 7000) {
        throw new Error(
          `This FBX is version ${version} (legacy). three.js needs FBX 7.x — ` +
            `re-export as "FBX 7.4 binary" (Blender's default) or convert it with ` +
            `the free Autodesk FBX Converter (FBX 6.1 → FBX 2013+), then upload again.`,
        )
      }
      throw new Error(`FBX parse failed: ${msg}`)
    }
  } else {
    throw new Error('Unsupported character file. Use .glb, .gltf or .fbx')
  }

  const info = extractSkeleton(object3D)
  if (!info.bones.length) {
    throw new Error('No skeleton found in this model (no SkinnedMesh with bones).')
  }
  const { missing } = mixamoMapping(info.bones)
  if (missing.length) {
    throw new Error(
      `Not a Mixamo-rigged character (missing bones: ${missing.join(', ')}). ` +
        'vid2rig needs characters rigged/downloaded from Mixamo with the standard ' +
        'mixamorig:* skeleton ("Download FBX / T-pose / with skin").',
    )
  }
  return { object3D, ...info, fileName: file.name }
}

// ---------------------------------------------------------------------------
// Mixamo rig support
//
// vid2rig targets Mixamo "Download FBX (with skin)" characters — they all use
// the standard mixamorig:* skeleton, so the SMPL mapping is FIXED (no manual
// mapping needed) and can be validated on load.
// ---------------------------------------------------------------------------

/** Standard SMPL-joint → Mixamo-bone table (Mixamo names minus the prefix). */
export const SMPL_TO_MIXAMO = {
  pelvis: 'Hips',
  spine1: 'Spine',
  spine2: 'Spine1',
  spine3: 'Spine2',
  neck: 'Neck',
  head: 'Head',
  left_shoulder: 'LeftShoulder', // SMPL "shoulder" == Mixamo clavicle bone
  right_shoulder: 'RightShoulder',
  left_elbow: 'LeftArm',
  right_elbow: 'RightArm',
  left_wrist: 'LeftForeArm',
  right_wrist: 'RightForeArm',
  left_hip: 'LeftUpLeg',
  right_hip: 'RightUpLeg',
  left_knee: 'LeftLeg',
  right_knee: 'RightLeg',
  left_ankle: 'LeftFoot',
  right_ankle: 'RightFoot',
  left_foot: 'LeftToeBase',
  right_foot: 'RightToeBase',
  // SMPL left/right_collar + hand end joints have no separate Mixamo bones
}

/** Required Mixamo bones for a valid humanoid retarget. */
const REQUIRED_MIXAMO = [
  'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'LeftShoulder', 'RightShoulder', 'LeftArm', 'RightArm',
  'LeftForeArm', 'RightForeArm', 'LeftUpLeg', 'RightUpLeg',
  'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot',
]

/** True if the bone set matches the Mixamo mixamorig:* skeleton. */
export function detectMixamo(bones) {
  const names = new Set(bones.map(stripMixamoPrefix))
  return REQUIRED_MIXAMO.every((n) => names.has(n.toLowerCase()))
}

function stripMixamoPrefix(name) {
  return name.toLowerCase().replace(/^mixamorig[:_]?/, '')
}

/**
 * Build the SMPL-joint-index → bone-name mapping for a Mixamo skeleton.
 * @returns {{ mapping: Object, missing: string[] }}
 */
export function mixamoMapping(bones) {
  const byName = new Map(bones.map((b) => [stripMixamoPrefix(b.name), b.name]))
  const mapping = {}
  const missing = []
  for (const [joint, mixamoName] of Object.entries(SMPL_TO_MIXAMO)) {
    const bone = byName.get(mixamoName.toLowerCase())
    if (bone) mapping[joint] = bone
    else if (REQUIRED_MIXAMO.includes(mixamoName)) missing.push(mixamoName)
  }
  // Convert joint names to indexes used by the retargeter
  const indexMapping = {}
  for (const [joint, bone] of Object.entries(mapping)) {
    const idx = SMPL_INDEX[joint]
    if (idx !== undefined) indexMapping[idx] = bone
  }
  return { mapping: indexMapping, missing }
}

export const SMPL_INDEX = Object.fromEntries(
  [
    'pelvis', 'left_hip', 'right_hip', 'spine1', 'left_knee', 'right_knee',
    'spine2', 'left_ankle', 'right_ankle', 'spine3', 'left_foot', 'right_foot',
    'neck', 'left_collar', 'right_collar', 'head', 'left_shoulder',
    'right_shoulder', 'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist',
    'left_hand', 'right_hand',
  ].map((n, i) => [n, i]),
)

/**
 * Walks the scene, finds skinned meshes, and collects:
 *  - bones:      [{ name, object }] in scene order
 *  - parentOf:   { name -> parentName | null }
 *  - rootBone:   top-most bone of the skeleton
 *  - bind:       bind-pose data per bone:
 *      restWorldQuat, restWorldPos (world at bind pose)
 *      localQuat, localPos (bind local transforms)
 */
export function extractSkeleton(object3D) {
  object3D.updateMatrixWorld(true)

  // Collect bones actually used by skinned meshes
  const used = new Set()
  object3D.traverse((o) => {
    if (o.isSkinnedMesh && o.skeleton) {
      o.skeleton.bones.forEach((b) => used.add(b))
    }
  })

  const bones = []
  const byName = new Map()
  object3D.traverse((o) => {
    if (o.isBone || used.has(o)) {
      if (!byName.has(o.name)) {
        byName.set(o.name, o)
        bones.push(o)
      }
    }
  })

  // Fall back: some exports use plain Object3D nodes as bones
  if (!bones.length) {
    object3D.traverse((o) => {
      if (o.children.length || o.parent) byName.set(o.name, o)
    })
  }

  const parentOf = {}
  bones.forEach((b) => {
    const p = b.parent
    parentOf[b.name] = p && byName.has(p.name) && p !== b ? p.name : null
  })

  // Skeleton root: bone whose parent is not itself a bone
  let rootBone = bones[0] || null
  for (const b of bones) {
    if (!parentOf[b.name]) {
      rootBone = b
      break
    }
  }

  const bind = {}
  const m = new THREE.Matrix4()
  const pos = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const scl = new THREE.Vector3()
  bones.forEach((b) => {
    m.copy(b.matrixWorld)
    m.decompose(pos, quat, scl)
    quat.normalize()
    bind[b.name] = {
      restWorldQuat: quat.clone(),
      restWorldPos: pos.clone(),
      localQuat: b.quaternion.clone(),
      localPos: b.position.clone(),
    }
  })

  return {
    bones: bones.map((b) => ({ name: b.name, object: b })),
    parentOf,
    rootBone,
    bind,
    // Lowest common ancestor of the skeleton root and all skinned meshes —
    // the correct subtree root for exporting a self-contained character GLB.
    exportRoot: (() => {
      const skinned = []
      object3D.traverse((o) => {
        if (o.isSkinnedMesh && o.skeleton) skinned.push(o)
      })
      if (!rootBone) return object3D
      const chain = []
      let n = rootBone
      while (n) {
        chain.push(n)
        n = n.parent
      }
      const isAncestorOfAll = (candidate) =>
        skinned.every((m) => {
          let p = m
          while (p) {
            if (p === candidate) return true
            p = p.parent
          }
          return false
        })
      for (const node of chain) {
        if (isAncestorOfAll(node)) return node
      }
      return object3D
    })(),
  }
}
