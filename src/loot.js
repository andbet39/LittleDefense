/**
 * Loot module — dropped items from killed monsters.
 * Handles spawning, floating animation, pickup detection, and effects.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { spawnDamageNumber } from './combat.js';

const OBJ_BASE = '/assets/objects/Assets/gltf/';
const loader = new GLTFLoader();

// ── Loot definitions ─────────────────────────────────────────────
const LOOT_TYPES = {
  health_potion: {
    model: 'bottle_A_green',
    scale: 1.8,
    tint: 0xff3333,        // red tint for health
    label: '+25 HP',
    labelColor: 'enemy',   // green number
    dropWeight: 30,
    effect(playerCombat) {
      const heal = 25;
      playerCombat.hp = Math.min(playerCombat.maxHp, playerCombat.hp + heal);
    },
  },
  speed_potion: {
    model: 'bottle_A_labeled_green',
    scale: 1.8,
    tint: 0x44bbff,        // blue tint for speed
    label: 'FAST!',
    labelColor: 'enemy',
    dropWeight: 15,
    duration: 6,           // seconds
    effect(playerCombat) {
      // Halve attack cooldown for duration
      playerCombat._origCooldown = playerCombat._origCooldown || playerCombat.attackCooldown;
      playerCombat.attackCooldown = playerCombat._origCooldown * 0.4;
    },
    expire(playerCombat) {
      if (playerCombat._origCooldown) {
        playerCombat.attackCooldown = playerCombat._origCooldown;
        playerCombat._origCooldown = null;
      }
    },
  },
  coins_small: {
    model: 'coin_stack_small',
    scale: 2.0,
    tint: null,
    label: '+10',
    labelColor: 'enemy',
    dropWeight: 40,
    effect() { /* score only — no gameplay effect yet */ },
  },
  coins_medium: {
    model: 'coin_stack_medium',
    scale: 1.8,
    tint: null,
    label: '+25',
    labelColor: 'enemy',
    dropWeight: 15,
    effect() { },
  },
};

// ── State ────────────────────────────────────────────────────────
const modelCache = new Map();
const drops = [];         // active loot on the ground
const activeBuffs = [];   // timed buff effects
let score = 0;
let _scene = null;

const PICKUP_RANGE = 1.8;
const FLOAT_HEIGHT = 0.6;
const FLOAT_SPEED  = 2.5;
const SPIN_SPEED   = 2.0;
const DESPAWN_TIME = 15;  // seconds before loot disappears
const DROP_CHANCE  = 0.90; // 90% chance to drop something

// ── Preload ──────────────────────────────────────────────────────

function loadModel(name) {
  return new Promise((resolve, reject) => {
    loader.load(`${OBJ_BASE}${name}.gltf`, (gltf) => resolve(gltf.scene), undefined, reject);
  });
}

/** Preload all loot models. Call once at startup. */
export async function preloadLootAssets() {
  const types = Object.values(LOOT_TYPES);
  const unique = [...new Set(types.map(t => t.model))];
  await Promise.all(unique.map(async (name) => {
    try {
      modelCache.set(name, await loadModel(name));
    } catch (e) {
      console.warn(`[Loot] Failed to load ${name}:`, e);
    }
  }));
  console.log(`[Loot] Preloaded ${modelCache.size} loot models`);
}

// ── Spawn ────────────────────────────────────────────────────────

/**
 * Roll for loot drop at a world position (call when a monster dies).
 * @param {THREE.Scene} scene
 * @param {{x,y,z}} pos - monster death position
 */
export function rollLootDrop(scene, pos) {
  _scene = scene;
  if (Math.random() > DROP_CHANCE) return;

  // Weighted random selection
  const entries = Object.entries(LOOT_TYPES);
  let totalWeight = 0;
  for (const [, def] of entries) totalWeight += def.dropWeight;

  let r = Math.random() * totalWeight;
  let selected = entries[0];
  for (const entry of entries) {
    r -= entry[1].dropWeight;
    if (r <= 0) { selected = entry; break; }
  }

  const [typeKey, def] = selected;
  spawnLoot(scene, pos, typeKey, def);
}

function spawnLoot(scene, pos, typeKey, def) {
  const template = modelCache.get(def.model);
  if (!template) return;

  const mesh = template.clone();
  mesh.scale.setScalar(def.scale);

  // Apply tint if specified
  if (def.tint) {
    mesh.traverse((c) => {
      if (c.isMesh && c.material) {
        c.material = c.material.clone();
        c.material.color.set(def.tint);
        c.material.emissive = new THREE.Color(def.tint);
        c.material.emissiveIntensity = 0.3;
      }
    });
  }

  // Add a subtle glow ring under the item
  const ringGeo = new THREE.RingGeometry(0.3, 0.5, 16);
  const ringMat = new THREE.MeshBasicMaterial({
    color: def.tint || 0xffdd44,
    transparent: true,
    opacity: 0.4,
    side: THREE.DoubleSide,
    depthTest: false,
    fog: false,
    toneMapped: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  ring.renderOrder = 998;

  const group = new THREE.Group();
  group.add(mesh);
  group.add(ring);

  // Start at monster death position
  group.position.set(pos.x, 0, pos.z);
  scene.add(group);

  // Random launch direction, distance 3–5 units
  const angle = Math.random() * Math.PI * 2;
  const dist  = 3 + Math.random() * 2;
  const targetX = pos.x + Math.cos(angle) * dist;
  const targetZ = pos.z + Math.sin(angle) * dist;

  drops.push({
    group,
    mesh,
    ring,
    typeKey,
    def,
    age: 0,
    baseY: FLOAT_HEIGHT,
    removed: false,
    // Launch arc state
    launching: true,
    launchTime: 0,
    launchDuration: 0.45,
    startX: pos.x,
    startZ: pos.z,
    targetX,
    targetZ,
  });
}

// ── Update ───────────────────────────────────────────────────────

/**
 * Update all loot: float, spin, pickup detection, despawn.
 * @param {number} dt
 * @param {{x,y,z}} playerPos
 * @param {Object} playerCombat
 */
export function updateLoot(dt, playerPos, playerCombat) {
  // Tick active buffs
  for (let i = activeBuffs.length - 1; i >= 0; i--) {
    const b = activeBuffs[i];
    b.remaining -= dt;
    if (b.remaining <= 0) {
      b.expire(playerCombat);
      activeBuffs.splice(i, 1);
    }
  }

  for (let i = drops.length - 1; i >= 0; i--) {
    const drop = drops[i];
    if (drop.removed) { drops.splice(i, 1); continue; }

    drop.age += dt;

    // ── Launch arc phase ─────────────────────────────────────
    if (drop.launching) {
      drop.launchTime += dt;
      const t = Math.min(1, drop.launchTime / drop.launchDuration);
      // Ease-out interpolation
      const ease = 1 - (1 - t) * (1 - t);
      const cx = drop.startX + (drop.targetX - drop.startX) * ease;
      const cz = drop.startZ + (drop.targetZ - drop.startZ) * ease;
      // Parabolic arc: peak at 2.5 units high
      const arcY = 4 * 2.5 * t * (1 - t);
      drop.group.position.set(cx, arcY, cz);
      drop.mesh.rotation.y += 12 * dt; // fast spin during launch
      // Hide ring during launch
      drop.ring.visible = false;
      if (t >= 1) {
        drop.launching = false;
        drop.group.position.set(drop.targetX, 0, drop.targetZ);
        drop.ring.visible = true;
      }
      continue; // skip pickup/float while launching
    }

    // Float and spin
    const floatY = drop.baseY + Math.sin(drop.age * FLOAT_SPEED) * 0.15;
    drop.mesh.position.y = floatY;
    drop.mesh.rotation.y += SPIN_SPEED * dt;

    // Ring pulse
    drop.ring.material.opacity = 0.25 + 0.2 * Math.sin(drop.age * 3);

    // Despawn
    if (drop.age > DESPAWN_TIME) {
      // Fade out in last 2 seconds
      if (drop.age > DESPAWN_TIME + 2) {
        _scene.remove(drop.group);
        drop.removed = true;
        drops.splice(i, 1);
        continue;
      }
      const fade = 1 - (drop.age - DESPAWN_TIME) / 2;
      drop.mesh.traverse((c) => {
        if (c.isMesh && c.material) { c.material.transparent = true; c.material.opacity = fade; }
      });
    }

    // Pickup detection
    const dx = playerPos.x - drop.group.position.x;
    const dz = playerPos.z - drop.group.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < PICKUP_RANGE) {
      // Apply effect
      drop.def.effect(playerCombat);

      // Timed buff?
      if (drop.def.duration && drop.def.expire) {
        activeBuffs.push({
          remaining: drop.def.duration,
          expire: drop.def.expire,
        });
      }

      // Score for coins
      if (drop.typeKey.startsWith('coins')) {
        score += drop.typeKey === 'coins_medium' ? 25 : 10;
      }

      // Floating label
      spawnDamageNumber(_scene, drop.group.position, drop.def.label, drop.def.labelColor);

      // Remove
      _scene.remove(drop.group);
      drop.removed = true;
      drops.splice(i, 1);
    }
  }
}

/** Get current score (coins collected). */
export function getScore() {
  return score;
}

/** Returns true if player has an active speed buff. */
export function hasSpeedBuff() {
  return activeBuffs.some(b => b.remaining > 0);
}
