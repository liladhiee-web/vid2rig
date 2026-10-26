import fs from 'fs'
import { loadCharacterFile, mixamoMapping } from './src/lib/character.js'

const buf = fs.readFileSync('../X Bot.fbx')
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
const file = new File([ab], 'X Bot.fbx')

const c = await loadCharacterFile(file)
console.log('fileName:', c.fileName)
console.log('bones:', c.bones.length)
console.log('rootBone:', c.rootBone.name)
console.log('modelHeightM:', c.modelHeightM.toFixed(3), 'unitScale:', c.unitScaleApplied)
console.log('Hips parent:', c.parentOf[c.rootBone.name])
const parentName = c.parentOf[c.rootBone.name]
if (parentName) {
  const pb = c.bind[parentName]
  console.log('parent bind scale:', pb?.scale, 'pos:', pb?.restWorldPos.toArray().map((n) => n.toFixed(4)))
}
const { mapping, missing } = mixamoMapping(c.bones)
console.log('mixamo mapping entries:', Object.keys(mapping).length, 'missing:', missing)

// sanity: retarget two frames of a fake motion and inspect hips local pos
const fake = {
  fps: 30,
  num_frames: 2,
  smpl: {
    global_orient: [[0, 0, 0], [0, 0, 0]],
    body_pose: [new Array(69).fill(0), new Array(69).fill(0)],
    betas: new Array(10).fill(0),
    transl: [[0, 0.95, 0], [0.1, 0.95, 0]],
  },
}
const { buildRetargetClip } = await import('./src/lib/retarget.js')
const clip = buildRetargetClip(fake, c, { mapping, autoCorrect: true, rootMotion: true, autoScale: true, scaleMult: 1, groundOffset: 0, flipRoot: false })
const hipsTrack = clip.tracks.find((t) => t.name.endsWith('Hips.position'))
const rotTrack = clip.tracks.find((t) => t.name.endsWith('Hips.quaternion'))
console.log('hips position track (frame0, frame1):',
  [...hipsTrack.values.slice(0, 3)].map((n) => n.toFixed(3)),
  [...hipsTrack.values.slice(3, 6)].map((n) => n.toFixed(3)))
console.log('hips quat frame0:', [...rotTrack.values.slice(0, 4)].map((n) => n.toFixed(3)))
console.log('tracks:', clip.tracks.length, 'duration:', clip.duration)
