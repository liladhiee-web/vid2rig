// BVH (Biovision Hierarchy) Exporter for Mixamo / Prompt2Rig animations.
// Exports motion tracks into standard BVH format compatible with Blender, Unreal, Maya, Cascadeur.
import * as THREE from 'three';

const RAD2DEG = 180 / Math.PI;
const _v1 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'ZYX');

const shortName = (n) => n.replace(/^mixamorig\d*[:_]?/i, '');

/**
 * Builds the BVH hierarchy tree definition and motion frame lines.
 * @param {import('./retarget.js').Rig} rig
 * @param {import('./retarget.js').Track} track
 * @param {string} clipName
 * @param {number} scale Scale multiplier (default: 100 for cm, standard Mixamo BVH)
 * @returns {string} BVH file content
 */
export function buildBVH(rig, track, clipName = 'motion', scale = 100) {
  if (!rig || !track || !track.times.length) {
    throw new Error('Invalid rig or empty track for BVH export');
  }

  rig.reset();
  const parentInv = new THREE.Matrix4().copy(rig.hips.parent.matrixWorld).invert();

  // Map bone short names to order index in track
  const orderMap = new Map();
  rig.order.forEach((name, idx) => orderMap.set(name, idx));

  // Sequence of bones in traversal order for MOTION channel values
  const activeBones = [];

  let hierarchyStr = 'HIERARCHY\n';

  function formatOffset(v) {
    return `${(v.x * scale).toFixed(6)} ${(v.y * scale).toFixed(6)} ${(v.z * scale).toFixed(6)}`;
  }

  function getValidBoneChildren(bone) {
    const list = [];
    for (const child of bone.children) {
      if (child.isBone) {
        const s = shortName(child.name);
        if (s in rig.bones && orderMap.has(s)) {
          list.push(child);
        }
      }
    }
    return list;
  }

  function traverseBone(bone, indent = '') {
    const s = shortName(bone.name);
    const isRoot = bone === rig.hips;
    const orderIdx = orderMap.get(s);
    activeBones.push({ bone, s, orderIdx, isRoot });

    const restPos = rig.rest[s] ? rig.rest[s].p : bone.position;
    const bonePrefix = bone.name.includes(':') ? bone.name : `mixamorig:${s}`;

    if (isRoot) {
      hierarchyStr += `${indent}ROOT ${bonePrefix}\n`;
    } else {
      hierarchyStr += `${indent}JOINT ${bonePrefix}\n`;
    }
    hierarchyStr += `${indent}{\n`;
    hierarchyStr += `${indent}\tOFFSET ${formatOffset(restPos)}\n`;

    if (isRoot) {
      hierarchyStr += `${indent}\tCHANNELS 6 Xposition Yposition Zposition Zrotation Yrotation Xrotation\n`;
    } else {
      hierarchyStr += `${indent}\tCHANNELS 3 Zrotation Yrotation Xrotation\n`;
    }

    const children = getValidBoneChildren(bone);
    if (children.length > 0) {
      for (const child of children) {
        traverseBone(child, indent + '\t');
      }
    } else {
      // Leaf joint: emit End Site
      hierarchyStr += `${indent}\tEnd Site\n`;
      hierarchyStr += `${indent}\t{\n`;
      // Reasonable tip offset along bone direction
      const endOffset = new THREE.Vector3(0, 0.05, 0);
      if (s.includes('Toe')) endOffset.set(0, 0, 0.1);
      else if (s.includes('Head')) endOffset.set(0, 0.15, 0);
      else if (s.includes('Hand') || s.includes('Thumb') || s.includes('Index') || s.includes('Middle') || s.includes('Ring') || s.includes('Pinky')) {
        endOffset.set(0, 0.03, 0);
      }
      hierarchyStr += `${indent}\t\tOFFSET ${formatOffset(endOffset)}\n`;
      hierarchyStr += `${indent}\t}\n`;
    }

    hierarchyStr += `${indent}}\n`;
  }

  traverseBone(rig.hips, '');

  // ---- MOTION SECTION ----
  const frameCount = track.times.length;
  let frameTime = 0.0333333; // 30 fps default
  if (frameCount > 1) {
    const totalTime = track.times[frameCount - 1] - track.times[0];
    frameTime = Math.max(0.001, totalTime / (frameCount - 1));
  }

  let motionStr = 'MOTION\n';
  motionStr += `Frames: ${frameCount}\n`;
  motionStr += `Frame Time: ${frameTime.toFixed(7)}\n`;

  for (let f = 0; f < frameCount; f++) {
    const lineParts = [];
    const qArray = track.q[f];
    const pWorld = track.p[f];

    for (const item of activeBones) {
      if (item.isRoot) {
        // Hips position in parent local coordinates
        _v1.set(pWorld[0], pWorld[1], pWorld[2]).applyMatrix4(parentInv);
        lineParts.push((_v1.x * scale).toFixed(4));
        lineParts.push((_v1.y * scale).toFixed(4));
        lineParts.push((_v1.z * scale).toFixed(4));
      }

      if (item.orderIdx != null && qArray) {
        const bi = item.orderIdx * 4;
        _q1.set(qArray[bi], qArray[bi + 1], qArray[bi + 2], qArray[bi + 3]);
        _euler.setFromQuaternion(_q1, 'ZYX');
        // Zrotation Yrotation Xrotation in degrees
        lineParts.push((_euler.z * RAD2DEG).toFixed(4));
        lineParts.push((_euler.y * RAD2DEG).toFixed(4));
        lineParts.push((_euler.x * RAD2DEG).toFixed(4));
      } else {
        lineParts.push('0.0000', '0.0000', '0.0000');
      }
    }
    motionStr += lineParts.join(' ') + '\n';
  }

  return hierarchyStr + motionStr;
}

/**
 * Triggers a browser download of a BVH animation file.
 * @param {import('./retarget.js').Rig} rig
 * @param {import('./retarget.js').Track} track
 * @param {string} filename Base filename without extension
 */
export function exportBVHFile(rig, track, filename = 'motion') {
  const bvhContent = buildBVH(rig, track, filename, 100);
  const blob = new Blob([bvhContent], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.bvh`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return bvhContent;
}
