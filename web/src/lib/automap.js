// Automatic SMPL-joint -> character-bone mapping by name heuristics.
// Handles Mixamo, UE, Rigify, Blender and common humanoid naming.

const SIDE_LEFT = /(^|[^a-z])left([^a-z]|$)|(^|[_\-.])l([_\-. ]|$)|\.l$|_l$|-l$|^l_/i
const SIDE_RIGHT = /(^|[^a-z])right([^a-z]|$)|(^|[_\-.])r([_\-. ]|$)|\.r$|_r$|-r$|^r_/i

function norm(name) {
  return name
    .toLowerCase()
    .replace(/mixamorig[1:]?/g, '')
    .replace(/bip01|bip001|bip01_?/g, '')
    .replace(/def-|def_|bone_/g, '')
    .replace(/[_\-. ]+/g, '')
    .trim()
}

function sideOf(normed) {
  if (SIDE_LEFT.test(normed) || /(^|\W)l($|\W)/.test(normed)) return 'left'
  if (SIDE_RIGHT.test(normed) || /(^|\W)r($|\W)/.test(normed)) return 'right'
  return null
}

// Exact normalized-name tables per SMPL joint (first hit wins).
const EXACT = {
  pelvis: ['hips', 'pelvis', 'root'],
  spine1: ['spine'],
  spine2: ['spine1', 'spine01'],
  spine3: ['spine2', 'chest'],
  neck: ['neck'],
  head: ['head'],
  left_collar: ['leftcollar', 'collarl', 'leftclavicle2'],
  right_collar: ['rightcollar', 'collarr', 'rightclavicle2'],
  left_shoulder: ['leftshoulder', 'lshoulder', 'shoulderl', 'leftclavicle', 'claviclel'],
  right_shoulder: ['rightshoulder', 'rshoulder', 'shoulderr', 'rightclavicle', 'clavicler'],
  left_elbow: ['leftarm', 'larm', 'arml', 'leftupperarm', 'upperarml', 'leftupperarml'],
  right_elbow: ['rightarm', 'rarm', 'armr', 'rightupperarm', 'upperarmr'],
  left_wrist: ['leftforearm', 'lforearm', 'forearml', 'leftlowerarm', 'lowerarml'],
  right_wrist: ['rightforearm', 'rforearm', 'forearmr', 'rightlowerarm', 'lowerarmr'],
  left_hip: ['leftupleg', 'lupleg', 'uplegl', 'leftthigh', 'thighl', 'lefthip', 'hipl'],
  right_hip: ['rightupleg', 'rupleg', 'uplegr', 'rightthigh', 'thighr', 'righthip', 'hipr'],
  left_knee: ['leftleg', 'lleg', 'legl', 'leftcalf', 'calfl', 'leftshin', 'shinl', 'leftknee', 'kneel'],
  right_knee: ['rightleg', 'rleg', 'legr', 'rightcalf', 'calfr', 'rightshin', 'shinr', 'rightknee', 'kneer'],
  left_ankle: ['leftankle', 'anklel', 'leftfoot', 'lfoot', 'footl'],
  right_ankle: ['rightankle', 'ankler', 'rightfoot', 'rfoot', 'footr'],
  left_hand: ['lefthand', 'lhand', 'handl'],
  right_hand: ['righthand', 'rhand', 'handr'],
  left_foot: ['lefttoe', 'toel', 'lefttoebase', 'toebl', 'leftball', 'balll'],
  right_foot: ['righttoe', 'toer', 'righttoebase', 'toebr', 'rightball', 'ballr'],
}

// Keyword pass (checked in order, unused bones only).
const KEYWORDS = {
  left_hip: ['upleg', 'thigh', 'hip'],
  right_hip: ['upleg', 'thigh', 'hip'],
  left_knee: ['calf', 'shin', 'knee', 'leg'],
  right_knee: ['calf', 'shin', 'knee', 'leg'],
  left_ankle: ['ankle', 'foot'],
  right_ankle: ['ankle', 'foot'],
  left_foot: ['toe', 'ball', 'foot'],
  right_foot: ['toe', 'ball', 'foot'],
  left_elbow: ['upperarm', 'arm'],
  right_elbow: ['upperarm', 'arm'],
  left_wrist: ['forearm', 'lowerarm'],
  right_wrist: ['forearm', 'lowerarm'],
  left_shoulder: ['clavicle', 'collar', 'shoulder'],
  right_shoulder: ['clavicle', 'collar', 'shoulder'],
  left_collar: ['clavicle', 'collar', 'shoulder'],
  right_collar: ['clavicle', 'collar', 'shoulder'],
  spine3: ['spine2', 'chest', 'upperchest'],
  spine2: ['spine1', 'chest'],
  spine1: ['spine'],
  pelvis: ['hips', 'pelvis', 'root'],
  neck: ['neck'],
  head: ['head'],
  left_hand: ['hand'],
  right_hand: ['hand'],
}

const ORDER = [
  'left_hip', 'right_hip', 'left_knee', 'right_knee',
  'left_ankle', 'right_ankle', 'left_foot', 'right_foot',
  'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist',
  'left_shoulder', 'right_shoulder', 'left_collar', 'right_collar',
  'spine3', 'spine2', 'spine1', 'neck', 'head', 'pelvis',
  'left_hand', 'right_hand',
]

/**
 * @param {string[]} boneNames
 * @returns {Object} mapping: SMPL joint name -> bone name | null
 */
export function autoMap(boneNames) {
  const entries = boneNames.map((n) => ({ name: n, norm: norm(n), used: false }))
  const byNorm = new Map(entries.map((e) => [e.norm, e]))
  const result = {}
  Object.keys(EXACT).forEach((k) => (result[k] = null))

  // Pass 1: exact normalized matches
  for (const [joint, names] of Object.entries(EXACT)) {
    for (const n of names) {
      const e = byNorm.get(n)
      if (e && !e.used) {
        result[joint] = e.name
        e.used = true
        break
      }
    }
  }

  // Pass 2: side-aware keyword matches
  for (const joint of ORDER) {
    if (result[joint]) continue
    const wantSide = joint.startsWith('left') ? 'left' : joint.startsWith('right') ? 'right' : null
    for (const kw of KEYWORDS[joint] || []) {
      const hit = entries.find(
        (e) => !e.used && e.norm.includes(kw) && (!wantSide || sideOf(e.norm) === wantSide),
      )
      if (hit) {
        result[joint] = hit.name
        hit.used = true
        break
      }
    }
  }
  return result
}
