/**
 * Environment module – loads map layout from mapdata.json,
 * creates flat ground, obstacles with physics, and decorative props.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createStaticBody, createCylinderBody } from './physics.js';

const ENV_BASE = '/environment/Assets/gltf/';
const loader = new GLTFLoader();

// Populated at runtime from mapdata.json
let WORLD_SIZE = 50;
let OBSTACLES = [];
const TERRAIN = []; // flat world — always empty

function loadModel(name) {
  return new Promise((resolve, reject) => {
    loader.load(`${ENV_BASE}${name}.gltf`, (gltf) => resolve(gltf.scene), undefined, reject);
  });
}

/**
 * Create the ground, obstacles, and decorations from mapdata.json.
 * @param {THREE.Scene} scene
 */
export async function createPlatforms(scene) {
  // ── Load map data ───────────────────────────────────────────
  let mapData = { worldSize: 50, groundColor: '0x5a8a3c', obstacles: [], decorations: [] };
  try {
    const resp = await fetch('/mapdata.json');
    mapData = await resp.json();
  } catch (e) {
    console.warn('[Platforms] mapdata.json not found, using empty map');
  }

  WORLD_SIZE = mapData.worldSize || 50;
  OBSTACLES = mapData.obstacles || [];
  const decorations = mapData.decorations || [];
  const half = WORLD_SIZE / 2;

  // ── Base ground plane ───────────────────────────────────────
  const groundGeo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE);
  const colorVal = typeof mapData.groundColor === 'string'
    ? parseInt(mapData.groundColor.replace('0x', ''), 16)
    : (mapData.groundColor || 0x5a8a3c);
  const groundMat = new THREE.MeshStandardMaterial({ color: colorVal, roughness: 0.9 });
  const groundMesh = new THREE.Mesh(groundGeo, groundMat);
  groundMesh.rotation.x = -Math.PI / 2;
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);

  createStaticBody({ x: 0, y: -0.25, z: 0 }, { hx: half, hy: 0.25, hz: half });

  // ── Obstacles with colliders ────────────────────────────────
  const obsPromises = OBSTACLES.map((o) =>
    loadModel(o.model)
      .then((model) => {
        model.scale.setScalar(o.scale);
        model.position.set(o.x, 0, o.z);
        model.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
        scene.add(model);

        if (o.collider === 'cylinder') {
          createCylinderBody({ x: o.x, y: o.chh, z: o.z }, o.chh, o.cr);
        } else {
          createStaticBody({ x: o.x, y: o.ch, z: o.z }, { hx: o.cw, hy: o.ch, hz: o.cd });
        }
      })
      .catch((err) => console.warn(`[Map] Failed: ${o.model}`, err))
  );

  // ── Decorations (visual only, no physics) ───────────────────
  const decPromises = decorations.map((d) =>
    loadModel(d.model)
      .then((model) => {
        model.scale.setScalar(d.scale);
        model.position.set(d.x, 0, d.z);
        model.traverse((c) => { if (c.isMesh) { c.receiveShadow = true; } });
        scene.add(model);
      })
      .catch((err) => console.warn(`[Map] Failed deco: ${d.model}`, err))
  );

  await Promise.all([...obsPromises, ...decPromises]);
  console.log(`[Platforms] Loaded ${OBSTACLES.length} obstacles, ${decorations.length} decorations`);
}

/** Ground height — always 0 (flat world). */
export function getGroundHeight(x, z) {
  return 0;
}

export { OBSTACLES, TERRAIN, WORLD_SIZE };
