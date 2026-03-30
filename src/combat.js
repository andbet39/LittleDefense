/**
 * Combat module – shared logic for HP, damage rolls, projectiles, and health bars.
 * No circular dependencies: this file imports only Three.js.
 */
import * as THREE from 'three';

// ── Combat stats ─────────────────────────────────────────────────

/**
 * Create a combat stats object for any entity (player or monster).
 * @param {number} maxHp
 * @param {number} damageDice  – number of dice rolled per attack
 * @param {number} damageSides – sides per die (e.g. 12 for d12)
 * @param {number} damageBonus – flat bonus added to roll
 * @param {number} cooldown    – seconds between attacks
 * @param {number} range       – attack range in world units
 * @param {'melee'|'ranged'} [attackType]
 * @param {number} [shieldDice] – sides of defense die (0 = no shield)
 */
export function createCombatStats(
  maxHp, damageDice, damageSides, damageBonus,
  cooldown, range, attackType = 'melee', shieldDice = 0
) {
  return {
    hp: maxHp,
    maxHp,
    damageDice,
    damageSides,
    damageBonus,
    attackCooldown: cooldown,
    attackTimer: 0,        // counts down to 0 before next attack is allowed
    attackRange: range,
    attackType,
    shieldDice,            // player shield defense die (e.g. 6 → 1d6 absorbed)
    isAttacking: false,    // true during the active swing window
    attackDuration: 0.4,   // how long isAttacking stays true (snappy feel)
    attackElapsed: 0,
    swingId: 0,            // incremented each swing; used to prevent multi-hits
    isDead: false,
    flashTimer: 0,         // > 0 while hit-flash is active
  };
}

/** Roll damage for an attack using the entity's stats. */
export function rollDamage(stats) {
  let total = stats.damageBonus;
  for (let i = 0; i < stats.damageDice; i++) {
    total += Math.floor(Math.random() * stats.damageSides) + 1;
  }
  return total;
}

/**
 * Apply damage to a target, optionally rolling shield defense.
 * Minimum 1 damage always lands.
 * @param {Object} targetStats – combat stats of the entity being hit
 * @param {number} rawDamage
 * @param {number} [shieldSides] – if > 0, rolls 1dX and subtracts from damage
 * @returns {{ finalDamage: number, died: boolean }}
 */
export function applyDamage(targetStats, rawDamage, shieldSides = 0) {
  if (targetStats.isDead) return { finalDamage: 0, died: false };
  const defense = shieldSides > 0 ? Math.floor(Math.random() * shieldSides) + 1 : 0;
  const finalDamage = Math.max(1, rawDamage - defense);
  targetStats.hp = Math.max(0, targetStats.hp - finalDamage);
  targetStats.flashTimer = 0.25;
  if (targetStats.hp <= 0) targetStats.isDead = true;
  console.log(`[Combat] Hit: ${rawDamage} - ${defense} def = ${finalDamage}. HP left: ${targetStats.hp}/${targetStats.maxHp}`);
  return { finalDamage, died: targetStats.isDead };
}

/** Decrement all timers. Call once per frame per entity. */
export function tickCombat(stats, dt) {
  if (stats.attackTimer > 0) stats.attackTimer = Math.max(0, stats.attackTimer - dt);
  if (stats.flashTimer > 0)  stats.flashTimer  = Math.max(0, stats.flashTimer  - dt);
  if (stats.isAttacking) {
    stats.attackElapsed += dt;
    if (stats.attackElapsed >= stats.attackDuration) {
      stats.isAttacking = false;
      stats.attackElapsed = 0;
    }
  }
}

/** Returns true if the entity is ready to attack. */
export function canAttack(stats) {
  return stats.attackTimer <= 0 && !stats.isDead;
}

/** Begin an attack: starts cooldown, sets isAttacking, increments swingId. */
export function startAttack(stats) {
  stats.attackTimer  = stats.attackCooldown;
  stats.isAttacking  = true;
  stats.attackElapsed = 0;
  stats.swingId++;
}

// ── Melee hit detection ──────────────────────────────────────────

/**
 * Returns true if targetPos is within the attacker's forward cone.
 * @param {{x,y,z}} attackerPos
 * @param {number}  yRot         – attacker's Y rotation (model.rotation.y)
 * @param {{x,y,z}} targetPos
 * @param {number}  range        – max distance
 * @param {number}  halfAngleDeg – half-angle of the cone in degrees
 */
export function isInAttackCone(attackerPos, yRot, targetPos, range, halfAngleDeg) {
  const dx = targetPos.x - attackerPos.x;
  const dz = targetPos.z - attackerPos.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist > range || dist < 0.001) return false;
  const fx = Math.sin(yRot);
  const fz = Math.cos(yRot);
  const dot = (dx / dist) * fx + (dz / dist) * fz;
  return dot >= Math.cos((halfAngleDeg * Math.PI) / 180);
}

// ── Projectiles ──────────────────────────────────────────────────

/** @type {Array<Object>} */
const projectiles = [];

/** Create a simple arrow mesh (tan cylinder). */
export function createArrowMesh() {
  const group = new THREE.Group();
  const geo = new THREE.CylinderGeometry(0.03, 0.03, 0.55, 6);
  const mat = new THREE.MeshBasicMaterial({ color: 0xc8a060 });
  const shaft = new THREE.Mesh(geo, mat);
  shaft.rotation.x = Math.PI / 2; // point along Z
  group.add(shaft);
  return group;
}

/** Create a glowing purple spell sphere mesh. */
export function createSpellMesh() {
  const geo = new THREE.SphereGeometry(0.2, 8, 8);
  const mat = new THREE.MeshBasicMaterial({ color: 0x8844ff, transparent: true, opacity: 0.9 });
  return new THREE.Mesh(geo, mat);
}

/**
 * Spawn a projectile traveling in the direction of directionYRot.
 * @param {THREE.Scene}   scene
 * @param {{x,y,z}}       from
 * @param {number}        directionYRot – model.rotation.y facing angle
 * @param {number}        speed
 * @param {THREE.Object3D} mesh
 * @param {Function}      onHit – called with ({pos, combat}) on contact
 * @param {number}        maxRange
 * @param {'player'|'monster'} [team]
 */
export function spawnProjectile(scene, from, directionYRot, speed, mesh, onHit, maxRange, team = 'player') {
  const direction = new THREE.Vector3(Math.sin(directionYRot), 0, Math.cos(directionYRot));
  mesh.position.set(from.x, from.y + 0.8, from.z);
  scene.add(mesh);
  projectiles.push({ scene, mesh, direction, speed, distTraveled: 0, maxRange, onHit, team, alive: true, time: 0 });
}

/**
 * Spawn a projectile aimed toward a specific world position (for monster AI).
 */
export function spawnProjectileToward(scene, from, toward, speed, mesh, onHit, maxRange, team = 'monster') {
  const dx = toward.x - from.x;
  const dz = toward.z - from.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  const dirYRot = len > 0.001 ? Math.atan2(dx, dz) : 0;
  spawnProjectile(scene, from, dirYRot, speed, mesh, onHit, maxRange, team);
}

/**
 * Move all live projectiles and test for hits. Call once per frame.
 * @param {number} dt
 * @param {Array<{pos:{x,y,z}, combat:Object}>} monsterTargets – alive monsters
 * @param {{x,y,z}|null} playerPos
 * @param {Object|null}  playerCombat
 * @param {{x,y,z}|null} [cratePos] – optional crate position (monster projectiles can hit it)
 * @param {Object|null}  [crateCombat] – optional crate combat stats
 */
export function updateProjectiles(dt, monsterTargets, playerPos, playerCombat, cratePos, crateCombat) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    if (!p.alive) { projectiles.splice(i, 1); continue; }

    p.time += dt;
    const move = p.speed * dt;
    p.mesh.position.x += p.direction.x * move;
    p.mesh.position.z += p.direction.z * move;
    p.distTraveled += move;

    // Animated pulse for spell projectiles
    if (p.team === 'monster') {
      const child = p.mesh.isMesh ? p.mesh : p.mesh.children[0];
      if (child && child.material && child.material.opacity !== undefined) {
        child.material.opacity = 0.65 + 0.35 * Math.abs(Math.sin(p.time * 10));
      }
    }

    let targets;
    if (p.team === 'player') {
      targets = monsterTargets;
    } else {
      // Monster projectiles can hit both player and crate
      targets = [];
      if (playerPos && playerCombat) targets.push({ pos: playerPos, combat: playerCombat });
      if (cratePos && crateCombat)   targets.push({ pos: cratePos,  combat: crateCombat });
    }

    let hit = false;
    for (const target of targets) {
      if (!target || !target.combat || target.combat.isDead) continue;
      const dx = p.mesh.position.x - target.pos.x;
      const dz = p.mesh.position.z - target.pos.z;
      if (Math.sqrt(dx * dx + dz * dz) < 0.75) {
        p.onHit(target, p.mesh.position);
        hit = true;
        break;
      }
    }

    if (hit || p.distTraveled >= p.maxRange) {
      p.scene.remove(p.mesh);
      p.alive = false;
      projectiles.splice(i, 1);
    }
  }
}

/** Remove all in-flight projectiles from the scene (call on game reset). */
export function clearProjectiles() {
  for (const p of projectiles) {
    if (p.alive && p.scene) p.scene.remove(p.mesh);
  }
  projectiles.length = 0;
}

// ── Material helpers ─────────────────────────────────────────────

/**
 * Clone all materials on a mesh hierarchy so per-instance color changes
 * (e.g. hit flash) don't affect other meshes sharing the same material.
 * Stores the original color in mat.userData.origColor.
 */
export function cloneMaterials(mesh) {
  mesh.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    const cloneOne = (mat) => {
      const m = mat.clone();
      m.userData.origColor = mat.color.clone();
      return m;
    };
    child.material = Array.isArray(child.material)
      ? child.material.map(cloneOne)
      : cloneOne(child.material);
  });
}

/**
 * Tint a mesh red proportional to flashTimer, or restore original colors when 0.
 * @param {THREE.Object3D} mesh
 * @param {number} flashTimer  – remaining flash seconds
 * @param {number} [maxFlash]  – full-intensity duration for normalisation
 */
export function applyHitFlash(mesh, flashTimer, maxFlash = 0.25) {
  const t = maxFlash > 0 ? Math.min(1, flashTimer / maxFlash) : 0;
  mesh.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    const apply = (mat) => {
      const orig = mat.userData.origColor;
      if (!orig) return;
      mat.color.setRGB(
        Math.min(1, orig.r + t * (1 - orig.r) * 0.85),
        orig.g * (1 - t * 0.8),
        orig.b * (1 - t * 0.8)
      );
    };
    if (Array.isArray(child.material)) child.material.forEach(apply);
    else apply(child.material);
  });
}

// ── Health bars ──────────────────────────────────────────────────

/**
 * Create a billboard health bar and add it to the scene.
 * Returns an object with a .group (Three.js Group) and an .update(fraction) method.
 * Position the group each frame: group.position.set(x, y + yOffset, z).
 * @param {THREE.Scene} scene
 * @returns {{ group: THREE.Group, update: (fraction: number) => void }}
 */
export function createHealthBar(scene) {
  const group = new THREE.Group();

  // Dark background track — fog/toneMapped false: exact colors, unaffected by scene lighting
  const bgMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.6, 0.28),
    new THREE.MeshBasicMaterial({ color: 0x111111, depthTest: false, transparent: true, opacity: 0.8, fog: false, toneMapped: false })
  );
  bgMesh.renderOrder = 999;
  group.add(bgMesh);

  // Red background (shows through as HP drains)
  const redMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.52, 0.20),
    new THREE.MeshBasicMaterial({ color: 0xcc1111, depthTest: false, fog: false, toneMapped: false })
  );
  redMesh.renderOrder = 1000;
  redMesh.position.z = 0.002;
  group.add(redMesh);

  // Green fill (shrinks left as HP drops)
  const fillMat = new THREE.MeshBasicMaterial({ color: 0x22dd22, depthTest: false, fog: false, toneMapped: false });
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(1.52, 0.20), fillMat);
  fill.renderOrder = 1001;
  fill.position.z = 0.004;
  group.add(fill);

  scene.add(group);

  return {
    group,
    update(fraction) {
      const f = Math.max(0, Math.min(1, fraction));
      fill.scale.x = f;
      fill.position.x = (f - 1) * 0.76; // half of 1.52
    },
  };
}

/** Make a health bar group always face the camera (billboard). */
export function tickHealthBarBillboard(group, camera) {
  group.quaternion.copy(camera.quaternion);
}

// ── Floating damage numbers ──────────────────────────────────────

/** @type {Array<{sprite: THREE.Sprite, velY: number, life: number, scene: THREE.Scene}>} */
const damageNumbers = [];

/**
 * Spawn a WoW-style floating damage number above a world position.
 * @param {THREE.Scene} scene
 * @param {{x,y,z}} pos   – world position to spawn at (e.g. monster body centre)
 * @param {number}  damage
 * @param {'enemy'|'player'} target – 'enemy' = yellow (outgoing), 'player' = red (incoming)
 */
export function spawnDamageNumber(scene, pos, damage, target = 'enemy') {
  const color   = target === 'player' ? '#ff4444' : '#ffee44';
  const outline = target === 'player' ? '#660000' : '#885500';

  // Draw text onto a canvas
  const canvas = document.createElement('canvas');
  canvas.width  = 160;
  canvas.height = 80;
  const ctx = canvas.getContext('2d');

  const text = String(damage);
  ctx.font = 'bold 54px Arial Black, Arial, sans-serif';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  // Thick dark outline
  ctx.strokeStyle = outline;
  ctx.lineWidth   = 10;
  ctx.lineJoin    = 'round';
  ctx.strokeText(text, 80, 42);

  // Bright fill
  ctx.fillStyle = color;
  ctx.fillText(text, 80, 42);

  const texture = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({
    map: texture,
    depthTest: false,
    transparent: true,
    fog: false,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(mat);
  // Scale: wider for multi-digit numbers
  sprite.scale.set(1.4 + text.length * 0.15, 0.7, 1);
  sprite.position.set(
    pos.x + (Math.random() - 0.5) * 0.4,
    pos.y + 1.6,
    pos.z + (Math.random() - 0.5) * 0.4
  );
  sprite.renderOrder = 1100;
  scene.add(sprite);

  damageNumbers.push({ sprite, velY: 3.5, life: 1.1, scene });
}

/**
 * Animate all active damage numbers. Call once per frame.
 * @param {number} dt
 */
export function updateDamageNumbers(dt) {
  for (let i = damageNumbers.length - 1; i >= 0; i--) {
    const n = damageNumbers[i];
    n.life -= dt;
    // Float upward, decelerating
    n.sprite.position.y += n.velY * dt;
    n.velY = Math.max(0, n.velY - 6 * dt);
    // Fade out in the last 0.4 seconds
    n.sprite.material.opacity = Math.min(1, n.life / 0.4);
    if (n.life <= 0) {
      n.scene.remove(n.sprite);
      n.sprite.material.map.dispose();
      n.sprite.material.dispose();
      damageNumbers.splice(i, 1);
    }
  }
}
