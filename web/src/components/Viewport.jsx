import React, { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

/**
 * Green/black look for the default Mixamo X Bot:
 * dark hull with glowing green joints/segments.
 */
function applyDefaultTheme(model) {
  const jointMat = new THREE.MeshStandardMaterial({
    color: 0x00e676,
    emissive: 0x0a4d2a,
    emissiveIntensity: 1.2,
    roughness: 0.35,
    metalness: 0.25,
  })
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x11150f,
    emissive: 0x06140b,
    emissiveIntensity: 0.6,
    roughness: 0.55,
    metalness: 0.35,
  })
  model.traverse((o) => {
    if (o.isMesh) {
      o.material = /joints|segment/i.test(o.name || '') ? jointMat : bodyMat
    }
  })
}

export default function Viewport({ character, clip, playing, time, onTimeUpdate, duration }) {
  const mountRef = useRef(null)
  const stateRef = useRef({})

  // (Re)build scene when character changes
  useEffect(() => {
    const mount = mountRef.current
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(mount.clientWidth, Math.max(400, mount.clientHeight))
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = true
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x030604)
    scene.fog = new THREE.Fog(0x030604, 18, 40)

    const camera = new THREE.PerspectiveCamera(45, mount.clientWidth / renderer.domElement.height, 0.05, 200)
    camera.position.set(2.5, 1.6, 4)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(0, 1, 0)
    controls.update()

    scene.add(new THREE.HemisphereLight(0x9fe8c4, 0x0a140d, 2.2))
    const dir = new THREE.DirectionalLight(0xd4ffe6, 2.4)
    dir.position.set(3, 6, 4)
    dir.castShadow = true
    dir.shadow.camera.far = 20
    dir.shadow.camera.left = dir.shadow.camera.bottom = -6
    dir.shadow.camera.right = dir.shadow.camera.top = 6
    scene.add(dir)

    const rim = new THREE.DirectionalLight(0x00e676, 1.1)
    rim.position.set(-4, 3, -5)
    scene.add(rim)

    const grid = new THREE.GridHelper(20, 40, 0x00e676, 0x12281b)
    grid.material.transparent = true
    grid.material.opacity = 0.35
    scene.add(grid)

    // add character (keep bind pose)
    const model = character.object3D
    if (character.isDefault) applyDefaultTheme(model)
    scene.add(model)

    // mixer setup
    const mixer = new THREE.AnimationMixer(model)
    let action = null
    if (clip) {
      action = mixer.clipAction(clip)
      action.play()
    }

    stateRef.current = { renderer, scene, camera, controls, mixer, action, model }

    // Frame camera on skeleton
    const box = new THREE.Box3().setFromObject(model)
    const center = box.getCenter(new THREE.Vector3())
    const height = Math.max(0.5, box.getSize(new THREE.Vector3()).y)
    controls.target.copy(center)
    camera.position.set(center.x + height * 1.2, center.y + height * 0.5, center.z + height * 2.2)
    controls.update()

    let raf
    let last = performance.now()
    const clock = new THREE.Clock()
    const loop = () => {
      raf = requestAnimationFrame(loop)
      const dt = clock.getDelta()
      if (playing && action) {
        mixer.update(dt)
        if (action.time > duration) action.time = action.time % duration
        onTimeUpdate?.(action.time)
      }
      controls.update()
      renderer.render(scene, camera)
      last = dt
    }
    loop()

    const onResize = () => {
      if (!mount.clientWidth) return
      camera.aspect = mount.clientWidth / Math.max(400, mount.clientHeight)
      camera.updateProjectionMatrix()
      renderer.setSize(mount.clientWidth, Math.max(400, mount.clientHeight))
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(mount)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      mixer.stopAllAction()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
      scene.remove(model)
    }
  }, [character])

  // Update clip when it changes (character stays mounted)
  useEffect(() => {
    const s = stateRef.current
    if (!s.mixer || !clip) return
    s.mixer.stopAllAction()
    s.action = s.mixer.clipAction(clip)
    s.action.play()
  }, [clip])

  // Scrub
  useEffect(() => {
    const s = stateRef.current
    if (!s.action) return
    s.action.paused = !playing
    if (Math.abs(s.action.time - time) > 0.05) {
      s.action.time = time
      s.mixer.update(0)
    }
  }, [time, playing])

  return <div ref={mountRef} className="viewport-box" style={{ height: 560 }} />
}
