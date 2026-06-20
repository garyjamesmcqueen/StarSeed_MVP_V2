'use client'

import { useGLTF } from '@react-three/drei'
import { useMemo, useRef, useEffect } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

type Contribution = {
  id: string
  createdAt: number
  alias: string
  emoji: string
  message: string
  quantity: number
}

// Simple seeded PRNG for reproducible randomness
class SeededRandom {
  private seed: number

  constructor(seed: number) {
    this.seed = seed
  }

  next(): number {
    this.seed = (this.seed * 9301 + 49297) % 233280
    return this.seed / 233280
  }

  nextInt(max: number): number {
    return Math.floor(this.next() * max)
  }

  shuffle<T>(arr: T[]): T[] {
    const result = [...arr]
    for (let i = result.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1)
      const tmp = result[i]
      result[i] = result[j]
      result[j] = tmp
    }
    return result
  }
}

export default function Model({
  modelPath,
  contributions,
  skullPulseTrigger,
  seed = 42, // deterministic seed (can be based on modelPath or user ID)
}: {
  modelPath: string
  contributions: Contribution[]
  skullPulseTrigger: number
  seed?: number
}) {
  const { scene } = useGLTF(modelPath)

  const spinRef = useRef<THREE.Group | null>(null)
  const baseRef = useRef<THREE.InstancedMesh | null>(null)
  const glowRef = useRef<THREE.InstancedMesh | null>(null)

  const displayCountRef = useRef(0)
  const lastPulseTriggerRef = useRef(skullPulseTrigger)
  const structurePulseRef = useRef(0)

  const baseColor = useMemo(() => new THREE.Color('#1e3a8a'), [])
  const shimmerColor = useMemo(() => new THREE.Color('#7dd3fc'), [])
  const contributionColor = useMemo(() => new THREE.Color('#ffffff'), [])
  const farColor = useMemo(() => new THREE.Color('#0f1f4d'), [])

  const tempObject = useMemo(() => new THREE.Object3D(), [])
  const tempColor = useMemo(() => new THREE.Color(), [])
  const tempVec = useMemo(() => new THREE.Vector3(), [])

  // --------------------------------------------------
  // AREA-WEIGHTED POINT SAMPLING (deterministic, world-space)
  // --------------------------------------------------
  const rawPoints = useMemo(() => {
    const prng = new SeededRandom(seed)
    const pts: THREE.Vector3[] = []
    const minDistance = 0.008
    const bucketSize = minDistance
    const buckets = new Map<string, THREE.Vector3[]>()

    const addToBucket = (v: THREE.Vector3) => {
      const bx = Math.floor(v.x / bucketSize)
      const by = Math.floor(v.y / bucketSize)
      const bz = Math.floor(v.z / bucketSize)
      const key = `${bx},${by},${bz}`
      const arr = buckets.get(key)
      if (arr) arr.push(v.clone())
      else buckets.set(key, [v.clone()])
    }

    const isTooClose = (v: THREE.Vector3) => {
      const bx = Math.floor(v.x / bucketSize)
      const by = Math.floor(v.y / bucketSize)
      const bz = Math.floor(v.z / bucketSize)

      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const key = `${bx + dx},${by + dy},${bz + dz}`
            const arr = buckets.get(key)
            if (!arr) continue
            for (let j = 0; j < arr.length; j++) {
              if (v.distanceTo(arr[j]) < minDistance) return true
            }
          }
        }
      }
      return false
    }

    // collect triangle areas for area-weighted sampling
    const triangles: { a: THREE.Vector3; b: THREE.Vector3; c: THREE.Vector3; mesh: any }[] = []
    let totalArea = 0

    scene.traverse((child: any) => {
      if (child.isMesh && child.geometry?.attributes?.position) {
        child.updateWorldMatrix(true, false)
        const pos = child.geometry.attributes.position
        const indices = child.geometry.index

        // if indexed geometry
        if (indices) {
          for (let i = 0; i < indices.count; i += 3) {
            const i0 = indices.getX(i)
            const i1 = indices.getX(i + 1)
            const i2 = indices.getX(i + 2)

            const a = tempVec
              .set(pos.getX(i0), pos.getY(i0), pos.getZ(i0))
              .applyMatrix4(child.matrixWorld)
            const b = new THREE.Vector3(
              pos.getX(i1),
              pos.getY(i1),
              pos.getZ(i1)
            ).applyMatrix4(child.matrixWorld)
            const c = new THREE.Vector3(
              pos.getX(i2),
              pos.getY(i2),
              pos.getZ(i2)
            ).applyMatrix4(child.matrixWorld)

            // compute triangle area
            const ab = new THREE.Vector3().subVectors(b, a)
            const ac = new THREE.Vector3().subVectors(c, a)
            const area = ab.cross(ac).length() * 0.5

            if (area > 1e-8) {
              triangles.push({
                a: a.clone(),
                b,
                c,
                mesh: child,
              })
              totalArea += area
            }
          }
        } else {
          // non-indexed: sample vertices directly
          for (let i = 0; i < pos.count; i++) {
            const v = tempVec
              .set(pos.getX(i), pos.getY(i), pos.getZ(i))
              .applyMatrix4(child.matrixWorld)

            if (!isTooClose(v)) {
              pts.push(v.clone())
              addToBucket(v)
            }
          }
        }
      }
    })

    // area-weighted sample from triangles
    if (triangles.length > 0) {
      // target: sample roughly one point per 0.001 units² of area (tune this)
      const targetSampleCount = Math.max(100, Math.floor(totalArea / 0.001))

      for (let s = 0; s < targetSampleCount; s++) {
        // pick triangle weighted by area
        let r = prng.next() * totalArea
        let tri: { a: THREE.Vector3; b: THREE.Vector3; c: THREE.Vector3 } | null = null
        let cumArea = 0
        for (let t = 0; t < triangles.length; t++) {
          const a = triangles[t]
          const ab = new THREE.Vector3().subVectors(a.b, a.a)
          const ac = new THREE.Vector3().subVectors(a.c, a.a)
          const area = ab.cross(ac).length() * 0.5
          cumArea += area
          if (r <= cumArea) {
            tri = a
            break
          }
        }
        if (!tri) tri = triangles[triangles.length - 1]

        // random point on triangle (barycentric)
        const r1 = Math.sqrt(prng.next())
        const r2 = prng.next()
        const u = 1 - r1
        const v = r1 * (1 - r2)
        const w = r1 * r2

        const pt = new THREE.Vector3()
          .copy(tri.a)
          .multiplyScalar(u)
          .addScaledVector(tri.b, v)
          .addScaledVector(tri.c, w)

        if (!isTooClose(pt)) {
          pts.push(pt)
          addToBucket(pt)
        }
      }
    }

    // shuffle with seeded PRNG
    const prng2 = new SeededRandom(seed + 1)
    pts.sort(() => prng2.next() - 0.5)

    return pts
  }, [scene, seed])

  // --------------------------------------------------
  // CONTRIBUTION-BASED ORDER (seeded, shuffled index pool)
  // --------------------------------------------------
  const points = useMemo(() => {
    if (rawPoints.length === 0) return []

    const prng = new SeededRandom(seed + 2)
    const ordered: THREE.Vector3[] = []
    const used = new Set<number>()

    // create a shuffled index pool and a pointer to pop from
    const indices = rawPoints.map((_, i) => i)
    indices.sort(() => prng.next() - 0.5)

    let poolPos = 0
    const getNextUnusedIndexFromPool = () => {
      while (poolPos < indices.length && used.has(indices[poolPos])) poolPos++
      if (poolPos >= indices.length) {
        // fallback: find any unused
        for (let k = 0; k < rawPoints.length; k++) {
          if (!used.has(k)) {
            used.add(k)
            return k
          }
        }
        return rawPoints.length - 1
      }
      const idx = indices[poolPos++]
      used.add(idx)
      return idx
    }

    for (const c of contributions) {
      if (c.quantity === 1) {
        const idx = getNextUnusedIndexFromPool()
        ordered.push(rawPoints[idx])
        continue
      }

      // MULTI → cluster around an anchor
      let anchorIndex = prng.nextInt(rawPoints.length)
      if (poolPos < indices.length) {
        const candidate = indices[Math.min(poolPos, indices.length - 1)]
        if (!used.has(candidate)) anchorIndex = candidate
      }
      const anchor = rawPoints[anchorIndex]

      const nearby = rawPoints
        .map((p, i) => ({ p, i, d: p.distanceToSquared(anchor) }))
        .sort((a, b) => a.d - b.d)

      let added = 0
      for (let i = 0; i < nearby.length && added < c.quantity; i++) {
        const idx = nearby[i].i
        if (!used.has(idx)) {
          used.add(idx)
          ordered.push(nearby[i].p)
          added++
        }
      }

      // if cluster couldn't find enough, fill from pool
      while (added < c.quantity) {
        const idx = getNextUnusedIndexFromPool()
        ordered.push(rawPoints[idx])
        added++
      }
    }

    return ordered
  }, [rawPoints, contributions, seed])

  // --------------------------------------------------
  // Set dynamic usage for instance buffers once mounted
  // --------------------------------------------------
  useEffect(() => {
    const base = baseRef.current
    const glow = glowRef.current
    if (base?.instanceMatrix) {
      try {
        base.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      } catch (e) {
        // ignore if not supported
      }
      if (base.instanceColor) {
        try {
          base.instanceColor.setUsage(THREE.DynamicDrawUsage)
        } catch (e) {}
      }
    }
    if (glow?.instanceMatrix) {
      try {
        glow.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      } catch (e) {}
      if (glow.instanceColor) {
        try {
          glow.instanceColor.setUsage(THREE.DynamicDrawUsage)
        } catch (e) {}
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --------------------------------------------------
  // Frame loop
  // --------------------------------------------------
  useFrame((state, delta) => {
    const spin = spinRef.current
    const base = baseRef.current
    const glow = glowRef.current
    if (!spin || !base || !glow) return

    spin.rotation.z = state.clock.elapsedTime * 0.02

    if (lastPulseTriggerRef.current !== skullPulseTrigger) {
      lastPulseTriggerRef.current = skullPulseTrigger
      structurePulseRef.current = 1
    }

    structurePulseRef.current = Math.max(0, structurePulseRef.current - delta * 0.9)

    const targetCount = Math.min(points.length, 50000)

    // grow/shrink display count smoothly (clamped)
    if (displayCountRef.current < targetCount) {
      displayCountRef.current = Math.min(displayCountRef.current + 6, targetCount)
    } else if (displayCountRef.current > targetCount) {
      displayCountRef.current = targetCount
    }

    let glowCount = 0

    for (let i = 0; i < displayCountRef.current && i < targetCount; i++) {
      const p = points[i]

      const pulse = Math.sin(state.clock.elapsedTime * 0.8 + i) * 0.5 + 0.5
      const scale = 1 + pulse * 0.15

      tempObject.position.copy(p)
      tempObject.scale.setScalar(scale * 0.9)
      tempObject.updateMatrix()
      base.setMatrixAt(i, tempObject.matrix)

      tempColor.copy(baseColor).lerp(shimmerColor, pulse)
      base.setColorAt(i, tempColor)

      // glow
      const glowStrength = pulse * 0.5 + structurePulseRef.current * 1.5

      if (glowStrength > 0.1) {
        tempObject.scale.setScalar(scale * 1.4)
        tempObject.updateMatrix()
        glow.setMatrixAt(glowCount, tempObject.matrix)

        tempColor.copy(shimmerColor)
        glow.setColorAt(glowCount, tempColor)

        glowCount++
      }
    }

    base.count = displayCountRef.current
    glow.count = glowCount

    base.instanceMatrix.needsUpdate = true
    glow.instanceMatrix.needsUpdate = true

    if (base.instanceColor) base.instanceColor.needsUpdate = true
    if (glow.instanceColor) glow.instanceColor.needsUpdate = true
  })

  return (
    <group rotation={[Math.PI / 2, 0, 0]}>
      <group ref={spinRef}>
        <instancedMesh ref={baseRef} args={[undefined, undefined, 50000]}>
          <sphereGeometry args={[0.003, 20, 20]} />
          <meshPhysicalMaterial
            emissive="#3567f1"
            emissiveIntensity={0.7}
            roughness={0.4}
            metalness={0.7}
            vertexColors
          />
        </instancedMesh>

        <instancedMesh ref={glowRef} args={[undefined, undefined, 50000]}>
          <sphereGeometry args={[0.003, 20, 20]} />
          <meshBasicMaterial
            transparent
            opacity={0.5}
            blending={THREE.AdditiveBlending}
            vertexColors
          />
        </instancedMesh>
      </group>
    </group>
  )
}