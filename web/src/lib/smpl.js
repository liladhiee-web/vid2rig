// SMPL skeleton constants + rotation math (no SMPL model file needed).
//
// SMPL rest-pose joint ROTATIONS are identity; joint OFFSETS below come from
// the SMPL neutral template (24 joints, Y-up, meters, facing +Z).

export const SMPL_NAMES = [
  'pelvis',
  'left_hip', 'right_hip',
  'spine1',
  'left_knee', 'right_knee',
  'spine2',
  'left_ankle', 'right_ankle',
  'spine3',
  'left_foot', 'right_foot',
  'neck',
  'left_collar', 'right_collar',
  'head',
  'left_shoulder', 'right_shoulder',
  'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist',
  'left_hand', 'right_hand',
]

// SMPL kinematic tree (parent index, -1 for root).
export const SMPL_PARENTS = [
  -1, // 0 pelvis
  0, 0, // hips
  0, // spine1
  1, 2, // knees
  3, // spine2
  4, 5, // ankles
  6, // spine3
  7, 8, // feet
  9, // neck
  9, 9, // collars
  12, // head
  13, 14, // shoulders
  16, 17, // elbows
  18, 19, // wrists
  20, 21, // hands
]

// Rest-pose joint offsets (meters) from the SMPL neutral template.
export const SMPL_J = [
  [0.0, 0.0, 0.0],            // 0 pelvis
  [-0.0778, -0.0927, 0.0035], // 1 left_hip
  [0.0778, -0.0927, 0.0035],  // 2 right_hip
  [0.0, -0.0786, -0.0029],    // 3 spine1
  [-0.0778, -0.4263, 0.0037], // 4 left_knee
  [0.0778, -0.4263, 0.0037],  // 5 right_knee
  [0.0, -0.1613, -0.0057],    // 6 spine2
  [-0.0844, -0.7553, 0.0044], // 7 left_ankle
  [0.0844, -0.7553, 0.0044],  // 8 right_ankle
  [0.0, -0.2438, -0.0075],    // 9 spine3
  [-0.0865, -0.8229, 0.0272], // 10 left_foot
  [0.0865, -0.8229, 0.0272],  // 11 right_foot
  [0.0, -0.3205, -0.0102],    // 12 neck
  [-0.0113, -0.3573, -0.0054],// 13 left_collar
  [0.0113, -0.3573, -0.0054], // 14 right_collar
  [0.0, -0.3852, -0.0124],    // 15 head
  [-0.1543, -0.3551, -0.0061],// 16 left_shoulder
  [0.1543, -0.3551, -0.0061], // 17 right_shoulder
  [-0.2718, -0.3540, -0.0080],// 18 left_elbow
  [0.2718, -0.3540, -0.0080], // 19 right_elbow
  [-0.3699, -0.3533, -0.0111],// 20 left_wrist
  [0.3699, -0.3533, -0.0111], // 21 right_wrist
  [-0.4124, -0.3433, -0.0040],// 22 left_hand
  [0.4124, -0.3433, -0.0040], // 23 right_hand
]

import * as THREE from 'three'

/** Axis-angle (Rodrigues) vector -> THREE.Quaternion */
export function aaToQuat(v) {
  const [x, y, z] = v
  const angle = Math.sqrt(x * x + y * y + z * z)
  if (angle < 1e-9) return new THREE.Quaternion()
  return new THREE.Quaternion(
    (x / angle) * Math.sin(angle / 2),
    (y / angle) * Math.sin(angle / 2),
    (z / angle) * Math.sin(angle / 2),
    Math.cos(angle / 2),
  )
}

/**
 * World-frame rotations of all 24 SMPL joints for one frame.
 * SMPL composes pure rotations down the kinematic tree (rest rotations are
 * identity), so no SMPL model file is required.
 */
export function smplWorldRotations(smpl, frame) {
  const q = new Array(24)
  const go = smpl.global_orient[frame]
  q[0] = aaToQuat(go)
  const bp = smpl.body_pose[frame] // 69 = 23 joints x 3
  for (let j = 1; j < 24; j++) {
    const local = aaToQuat([bp[(j - 1) * 3], bp[(j - 1) * 3 + 1], bp[(j - 1) * 3 + 2]])
    const parent = SMPL_PARENTS[j]
    q[j] = parent >= 0 ? q[parent].clone().multiply(local) : local
  }
  return q
}

/** Index of the first mapped SMPL child of joint j (for bone-direction correction). */
export function firstMappedChild(j, mapping) {
  for (let c = 0; c < 24; c++) if (SMPL_PARENTS[c] === j && mapping[c]) return c
  return null
}
