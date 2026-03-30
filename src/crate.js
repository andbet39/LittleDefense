/**
 * Crate module — multiple defense targets that monsters try to destroy.
 * Game over only when ALL crates are destroyed.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createStaticBody, removeBody } from './physics.js';
import { getGroundHeight } from './platforms.js';
import {
  createCombatStats, tickCombat,
  createHealthBar, tickHealthBarBillboard,
  cloneMaterials, applyHitFlash,
} from './combat.js';
import { isWalkable } from './pathfinding.js';

/** @type {Array<CrateState>} */
const crates = [];
let modelTemplate = null;
const loader = new GLTFLoader();

/**
 * Generate random walkable positions that are spaced apart.
 */
function generateRandomPositions(count, minDist) {
  const positions = [];
  const margin = 6; // stay away from map edges
  const range = 25 - margin; // half world size minus margin

  for (let attempt = 0; attempt < count * 50 && positions.length < count; attempt++) {
    const x = (Math.random() * 2 - 1) * range;
    const z = (Math.random() * 2 - 1) * range;

    if (!isWalkable(x, z)) continue;

    // Check distance from all existing positions
    let tooClose = false;
    for (const p of positions) {
      const dx = p.x - x;
      const dz = p.z - z;
      if (Math.sqrt(dx * dx + dz * dz) < minDist) { tooClose = true; break; }
    }
    if (tooClose) continue;

    positions.push({ x: Math.round(x), z: Math.round(z) });
  }

  // Fallback: always have at least one at center
  if (positions.length === 0) positions.push({ x: 0, z: 0 });

  return positions;
}

/**
 * Create all crates from config.
 * @param {THREE.Scene} scene
 * @param {Object} cfg - config.crate section
 */
export async function createCrate(scene, cfg = {}) {
  const modelPath = cfg.model || '/assets/objects/Assets/gltf/chest_gold.gltf';
  const scale     = cfg.scale || 1.5;
  const hp        = cfg.hp || 500;
  const ch        = cfg.colliderHalf || { x: 0.6, y: 0.6, z: 0.6 };

  // Generate random walkable positions
  const count = cfg.count || 5;
  const minDist = cfg.minDistance || 8; // minimum distance between crates
  const positions = generateRandomPositions(count, minDist);

  // Load model template once
  try {
    const gltf = await new Promise((resolve, reject) => loader.load(modelPath, resolve, undefined, reject));
    modelTemplate = gltf.scene;
  } catch (err) {
    console.warn('[Crate] Model load failed:', err);
    modelTemplate = null;
  }

  // Spawn each crate
  for (const pos of positions) {
    const groundY = getGroundHeight(pos.x, pos.z);
    const worldPos = { x: pos.x, y: groundY, z: pos.z };

    let mesh;
    if (modelTemplate) {
      mesh = modelTemplate.clone();
      mesh.scale.setScalar(scale);
      mesh.position.set(worldPos.x, worldPos.y, worldPos.z);
      mesh.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
      cloneMaterials(mesh);
    } else {
      const geo = new THREE.BoxGeometry(1.5, 1.5, 1.5);
      const mat = new THREE.MeshStandardMaterial({ color: 0x8B6914, roughness: 0.85 });
      mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(worldPos.x, worldPos.y + 0.75, worldPos.z);
      mesh.castShadow = true;
      cloneMaterials(mesh);
      const edges = new THREE.EdgesGeometry(geo);
      mesh.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x4a3508 })));
    }
    scene.add(mesh);

    const body = createStaticBody(
      { x: worldPos.x, y: worldPos.y + ch.y, z: worldPos.z },
      { hx: ch.x, hy: ch.y, hz: ch.z }
    );

    const combat = createCombatStats(hp, 0, 0, 0, 999, 0, 'melee', 0);
    const healthBar = createHealthBar(scene);

    crates.push({
      mesh,
      body,
      combat,
      healthBar,
      position: worldPos,
      destroyed: false,
      deathTimer: 0,
      scene,
    });

    console.log(`[Crate] Placed at (${worldPos.x}, ${worldPos.y}, ${worldPos.z}) with ${hp} HP`);
  }
}

/**
 * Update all crates each frame.
 * @param {number} dt
 * @param {THREE.Camera} camera
 */
export function updateCrate(dt, camera) {
  for (const c of crates) {
    if (c.destroyed) continue;

    tickCombat(c.combat, dt);
    applyHitFlash(c.mesh, c.combat.flashTimer);

    if (c.healthBar && camera) {
      c.healthBar.group.position.set(c.position.x, c.position.y + 2.8, c.position.z);
      tickHealthBarBillboard(c.healthBar.group, camera);
      c.healthBar.update(c.combat.hp / c.combat.maxHp);
    }

    // Crate destroyed — fade out and remove
    if (c.combat.isDead && !c.destroyed) {
      c.destroyed = true;
      c.deathTimer = 0;
    }

    if (c.destroyed) {
      // Not yet handled above because we skip with continue...
      // Actually we need the fade logic after marking destroyed.
    }
  }

  // Handle destroyed crate fade-out in separate pass
  for (const c of crates) {
    if (!c.destroyed || !c.mesh.parent) continue;
    c.deathTimer += dt;
    const opacity = Math.max(0, 1 - c.deathTimer / 1.5);
    c.mesh.traverse((child) => {
      if (child.isMesh && child.material) {
        const setOp = (m) => { m.transparent = true; m.opacity = opacity; };
        Array.isArray(child.material) ? child.material.forEach(setOp) : setOp(child.material);
      }
    });
    if (c.deathTimer >= 1.5) {
      c.scene.remove(c.mesh);
      c.scene.remove(c.healthBar.group);
      removeBody(c.body);
    }
  }
}

/**
 * Get the nearest alive crate position to a given point.
 * Used by monsters for pathfinding target.
 * @param {{x,z}} from
 * @returns {{x,y,z}}
 */
export function getNearestCratePos(from) {
  let best = null;
  let bestDist = Infinity;
  for (const c of crates) {
    if (c.destroyed) continue;
    const dx = c.position.x - (from.x || 0);
    const dz = c.position.z - (from.z || 0);
    const d = dx * dx + dz * dz;
    if (d < bestDist) { bestDist = d; best = c.position; }
  }
  return best || { x: 0, y: 0, z: 0 };
}

/**
 * Get the nearest alive crate's combat stats.
 * @param {{x,z}} from
 * @returns {Object}
 */
export function getNearestCrateCombat(from) {
  let best = null;
  let bestDist = Infinity;
  for (const c of crates) {
    if (c.destroyed) continue;
    const dx = c.position.x - (from.x || 0);
    const dz = c.position.z - (from.z || 0);
    const d = dx * dx + dz * dz;
    if (d < bestDist) { bestDist = d; best = c.combat; }
  }
  return best;
}

/** Legacy single-crate API — returns first alive crate pos. */
export function getCratePos() {
  return getNearestCratePos({ x: 0, z: 0 });
}

/** Legacy single-crate API — returns first alive crate combat. */
export function getCrateCombat() {
  return getNearestCrateCombat({ x: 0, z: 0 });
}

/** Returns true only when ALL crates are destroyed. */
export function isCrateDestroyed() {
  return crates.length > 0 && crates.every(c => c.destroyed);
}

/** Returns count of alive crates. */
export function getAliveCrateCount() {
  return crates.filter(c => !c.destroyed).length;
}

/** Returns all alive crates as targets (for projectile system). */
export function getCrateTargets() {
  return crates
    .filter(c => !c.destroyed)
    .map(c => ({ pos: c.position, combat: c.combat }));
}
