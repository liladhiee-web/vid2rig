// Character model loading (GLB/FBX) + skeleton bind-pose extraction.
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'

export async function loadCharacterFile(file) {
  const name = file.name.toLowerCase()
  const buffer = await file.arrayBuffer()
  const loaderOpts = {}
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
  return { object3D, ...info, fileName: file.name }
}

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
  }
}
