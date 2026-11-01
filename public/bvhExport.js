// BVH (Biovision Hierarchy) Exporter for Mixamo / Prompt2Rig animations.
// Exports motion tracks into standard BVH format compatible with Blender, Unreal, Maya, Cascadeur.
import * as THREE from 'three';

const RAD2DEG = 180 / Math.PI;
const _q1 = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'ZYX');

const shortName = (n) => n.replace(/^mixamorig\d*[:_]?/i, '');

/**
 * Builds the BVH hierarchy tree definition and motion frame lines.
 * Uses metric world positions for rest offsets and Hips translation,
 * ensuring standard Blender / DCC scale (1 unit = 1 meter, character ~ 1.75m).
 * @param {import('./retarget.js').Rig} rig
 * @param {import('./retarget.js').Track} track
 * @param {string} clipName
 * @param {number} scale Scale multiplier on meters (default: 1.0 for standard metric Blender units)
 * @param {object} options Optional export parameters: { inPlace?: boolean }
 * @returns {string} BVH file content
 */
export function buildBVH(rig, track, clipName = 'motion', scale = 1.0, options = {}) {
  const inPlace = !!options.inPlace;
  if (!rig || !track || !track.times.length) {
    throw new Error('Invalid rig or empty track for BVH export');
  }

  rig.reset();
  const rootRestPos = rig.rest.Hips?.wp
    ? rig.rest.Hips.wp.clone()
    : (rig.hips ? rig.hips.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(0, 1.04, 0));

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

    const bonePrefix = bone.name.includes(':') ? bone.name : `mixamorig:${s}`;
    const boneRest = rig.rest[s];

    if (isRoot) {
      hierarchyStr += `${indent}ROOT ${bonePrefix}\n`;
    } else {
      hierarchyStr += `${indent}JOINT ${bonePrefix}\n`;
    }
    hierarchyStr += `${indent}{\n`;

    // Compute rest offset in parent's rest coordinate frame (metric)
    const restOffset = new THREE.Vector3();
    if (isRoot) {
      // Root position: Hips rest world position (in meters, ~1.04m above floor)
      if (boneRest?.wp) {
        restOffset.copy(boneRest.wp);
      } else {
        bone.getWorldPosition(restOffset);
      }
    } else if (bone.parent) {
      const parentShort = shortName(bone.parent.name);
      const parentRest = rig.rest[parentShort];
      if (boneRest?.wp && parentRest?.wp && parentRest?.wq) {
        // Delta in world space, rotated into parent rest orientation
        restOffset.copy(boneRest.wp).sub(parentRest.wp).applyQuaternion(parentRest.wq.clone().invert());
      } else {
        // Fallback: local bone position normalized to meters if needed
        restOffset.copy(bone.position);
        if (restOffset.length() > 5.0) restOffset.multiplyScalar(0.01);
      }
    }

    hierarchyStr += `${indent}\tOFFSET ${formatOffset(restOffset)}\n`;

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

      let endOffset = null;
      // 1. Check if the model has a direct child tip bone in bone.children
      // (Mixamo models have HeadTop_End, LeftToe_End, RightToe_End, HandThumb4, Index4, etc.)
      for (const child of bone.children) {
        if (child.isBone) {
          const tipWorld = child.getWorldPosition(new THREE.Vector3());
          const boneWp = boneRest?.wp || bone.getWorldPosition(new THREE.Vector3());
          const boneWq = boneRest?.wq || bone.getWorldQuaternion(new THREE.Quaternion());
          const candidate = tipWorld.sub(boneWp).applyQuaternion(boneWq.clone().invert());
          if (candidate.length() >= 0.005) {
            endOffset = candidate;
            break;
          }
        }
      }

      // 2. If no valid child tip bone, project along the bone's own heading with standard human lengths
      if (!endOffset || endOffset.length() < 0.005) {
        let len = 0.05; // 5 cm default
        if (s.includes('Head')) len = 0.16; // 16 cm head height
        else if (s.includes('Toe')) len = 0.09; // 9 cm toe length
        else if (s.includes('Hand') || s.includes('Thumb') || s.includes('Index') || s.includes('Middle') || s.includes('Ring') || s.includes('Pinky')) {
          len = 0.025; // 2.5 cm finger segment
        }

        if (bone.parent) {
          const parentShort = shortName(bone.parent.name);
          const parentRest = rig.rest[parentShort];
          if (boneRest?.wp && parentRest?.wp && boneRest?.wq) {
            const dir = boneRest.wp.clone().sub(parentRest.wp);
            if (dir.lengthSq() > 1e-6) {
              dir.normalize().multiplyScalar(len);
              endOffset = dir.applyQuaternion(boneRest.wq.clone().invert());
            }
          }
        }

        if (!endOffset || endOffset.length() < 0.005) {
          if (s.includes('Head')) endOffset = new THREE.Vector3(0, len, 0);
          else if (s.includes('Toe')) endOffset = new THREE.Vector3(0, 0, len);
          else if (s.startsWith('Right')) endOffset = new THREE.Vector3(-len, 0, 0);
          else endOffset = new THREE.Vector3(len, 0, 0);
        }
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
        // Hips position in world coordinates (meters)
        let rootX = pWorld[0];
        let rootY = pWorld[1];
        let rootZ = pWorld[2];
        if (inPlace) {
          // In-Place (Game Dev): Lock horizontal root translation (X/Z) to origin rest offset
          rootX = rootRestPos.x;
          rootZ = rootRestPos.z;
        }
        lineParts.push((rootX * scale).toFixed(4));
        lineParts.push((rootY * scale).toFixed(4));
        lineParts.push((rootZ * scale).toFixed(4));
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
 * @param {number} scale Optional scale multiplier (default: 1.0 for meters, fits standard Blender grid)
 * @param {object} options Optional export parameters: { inPlace?: boolean }
 */
export function exportBVHFile(rig, track, filename = 'motion', scale = 1.0, options = {}) {
  const bvhContent = buildBVH(rig, track, filename, scale, options);
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
