/**
 * Monster module — wave-spawned skeleton enemies with A* pathfinding
 * toward the crate and per-type behavior variations.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { createMonsterBody, removeBody } from './physics.js';
import { getGroundHeight } from './platforms.js';
import { getCamera } from './camera.js';
import { findPath } from './pathfinding.js';
import {
  createCombatStats, tickCombat, canAttack, startAttack, rollDamage, applyDamage,
  isInAttackCone,
  createHealthBar, tickHealthBarBillboard,
  cloneMaterials, applyHitFlash,
  createSpellMesh, spawnProjectileToward,
  spawnDamageNumber,
} from './combat.js';
import { rollLootDrop } from './loot.js';
import { getNearestCratePos, getNearestCrateCombat } from './crate.js';

// ── Asset paths ──────────────────────────────────────────────────
const MODEL_BASE        = 'assets/Monster/characters/gltf/';
const ANIM_BASIC        = 'assets/Monster/Animations/gltf/Rig_Medium/Rig_Medium_MovementBasic.glb';
const ANIM_COMBAT_MELEE = 'charecter/Animations/gltf/Rig_Medium/Rig_Medium_CombatMelee.glb';

// ── Constants ────────────────────────────────────────────────────
const CAPSULE_HALF_HEIGHT  = 0.3;
const CAPSULE_RADIUS       = 0.25;
const HEALTH_BAR_Y_OFFSET  = 2.2;
const DEATH_FADE_TIME      = 1.0;
const WAYPOINT_THRESHOLD   = 1.0;

// ── AI states ────────────────────────────────────────────────────
const AI_PATH_TO_CRATE = 0;
const AI_ATTACK_CRATE  = 1;
const AI_DIVERT_PLAYER = 2;
const AI_MAGE_RANGED   = 3;

// ── Config (set by initMonsterConfig) ────────────────────────────
let monstersCfg = {};       // config.monsters section
let crateAttackRange = 2.0;
let repathMin = 2, repathMax = 3;

// ── Preloaded asset caches ───────────────────────────────────────
const modelCache  = new Map();
const weaponCache = new Map();
let sharedClips   = [];
let assetsLoaded  = false;

/** @type {Array<Object>} */
const monsters = [];

const loader = new GLTFLoader();
function loadGLB(url) {
  return new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
}

// ── Bone attachment (same as character.js) ────────────────────────
function attachToBone(root, equipMesh, candidates) {
  let bone = null;
  for (const name of candidates) { bone = root.getObjectByName(name); if (bone) break; }
  if (!bone) {
    const lc = candidates.map(n => n.toLowerCase());
    root.traverse((c) => {
      if (bone) return;
      const n = (c.name || '').toLowerCase();
      if (lc.some(k => n === k || n.includes(k))) bone = c;
    });
  }
  if (!bone) {
    root.traverse((c) => {
      if (bone || !c.isSkinnedMesh || !c.skeleton) return;
      const lc = candidates.map(n => n.toLowerCase());
      for (const b of c.skeleton.bones) {
        if (lc.includes(b.name.toLowerCase())) { bone = b; return; }
      }
    });
  }
  if (bone) {
    equipMesh.position.set(0, 0, 0);
    equipMesh.rotation.set(0, 0, 0);
    equipMesh.scale.set(1, 1, 1);
    equipMesh.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.frustumCulled = false; } });
    bone.add(equipMesh);
  }
}

function mapClip(clips, mixer, actionMap, stateName, keywords) {
  for (const kw of keywords) {
    const clip = clips.find(c => c.name.toLowerCase().includes(kw.toLowerCase()));
    if (clip) { actionMap[stateName] = mixer.clipAction(clip); return; }
  }
}

function switchAction(mon, name, fadeDuration = 0.15) {
  const next = mon.actions[name];
  if (!next || next === mon.currentAction) return;
  if (mon.currentAction) mon.currentAction.fadeOut(fadeDuration);
  next.reset().fadeIn(fadeDuration).play();
  mon.currentAction = next;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Set monster config from the loaded config.json.
 * @param {Object} cfg - config.monsters section
 * @param {Object} fullCfg - full config (for crateAttackRange, pathfinding)
 */
export function initMonsterConfig(cfg, fullCfg = {}) {
  monstersCfg = cfg || {};
  crateAttackRange = fullCfg.crateAttackRange || 2.0;
  const pf = fullCfg.pathfinding || {};
  repathMin = (pf.repathInterval && pf.repathInterval.min) || 2;
  repathMax = (pf.repathInterval && pf.repathInterval.max) || 3;
}

/**
 * Preload all monster models, weapons, and animation packs.
 * Call once at startup before any spawnMonster calls.
 */
export async function preloadMonsterAssets() {
  const [animGltf, meleeGltf] = await Promise.all([
    loadGLB(ANIM_BASIC),
    loadGLB(ANIM_COMBAT_MELEE).catch(() => null),
  ]);

  sharedClips = [
    ...animGltf.animations,
    ...(meleeGltf ? meleeGltf.animations : []),
  ];

  const types = Object.keys(monstersCfg);
  if (types.length === 0) types.push('Skeleton_Warrior', 'Skeleton_Rogue', 'Skeleton_Mage');

  await Promise.all(types.map(async (type) => {
    try { modelCache.set(type, await loadGLB(`${MODEL_BASE}${type}.glb`)); }
    catch (e) { console.warn(`[Monsters] Model ${type} failed:`, e); }

    const weaponPath = monstersCfg[type]?.weapon;
    if (weaponPath) {
      try { weaponCache.set(type, await loadGLB(weaponPath)); }
      catch (e) { console.warn(`[Monsters] Weapon for ${type} failed:`, e); }
    }
  }));

  assetsLoaded = true;
  console.log(`[Monsters] Assets preloaded. Types: ${types.join(', ')}`);
}

/**
 * Spawn a single monster at a world position.
 * @param {THREE.Scene} scene
 * @param {string} type
 * @param {number} x
 * @param {number} z
 * @param {number} [hpMultiplier=1]
 */
export function spawnMonster(scene, type, x, z, hpMultiplier = 1) {
  if (!assetsLoaded) { console.warn('[Monsters] Assets not loaded yet'); return; }

  const gltf = modelCache.get(type);
  if (!gltf) { console.warn(`[Monsters] No model for ${type}`); return; }

  const mesh = SkeletonUtils.clone(gltf.scene);
  mesh.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = false; } });
  scene.add(mesh);

  // Weapon
  const wGltf = weaponCache.get(type);
  if (wGltf) {
    const wMesh = SkeletonUtils.clone(wGltf.scene);
    attachToBone(mesh, wMesh, ['handslotr', 'handr', 'hand_r', 'weapon_r']);
  }

  cloneMaterials(mesh);

  // Animations
  const monMixer = new THREE.AnimationMixer(mesh);
  const allClips = [...(gltf.animations || []), ...sharedClips];
  const actionMap = {};
  mapClip(allClips, monMixer, actionMap, 'idle',         ['Idle']);
  mapClip(allClips, monMixer, actionMap, 'walk',         ['Walk', 'Run_Medium']);
  mapClip(allClips, monMixer, actionMap, 'run',          ['Run']);
  mapClip(allClips, monMixer, actionMap, 'attack_melee', ['1H_Melee_Attack_Chop', 'Attack_Chop', 'Melee_Attack', 'attack', 'slash', 'chop']);

  if (actionMap['attack_melee']) {
    actionMap['attack_melee'].setLoop(THREE.LoopOnce, 1);
    actionMap['attack_melee'].clampWhenFinished = false;
  }

  if (!actionMap['idle'] && allClips.length > 0) {
    actionMap['idle'] = monMixer.clipAction(allClips[0]);
  }

  // Physics
  const groundY = getGroundHeight(x, z);
  const spawnY  = groundY + CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS + 0.1;
  const body    = createMonsterBody({ x, y: spawnY, z }, CAPSULE_HALF_HEIGHT, CAPSULE_RADIUS);

  // Combat stats from config with HP scaling
  const s = monstersCfg[type] || { hp: 30, dice: 1, sides: 6, bonus: 1, cooldown: 1, range: 1.4 };
  const scaledHp = Math.round(s.hp * hpMultiplier);
  const combat = createCombatStats(scaledHp, s.dice, s.sides, s.bonus, s.cooldown, s.range);

  const healthBar = createHealthBar(scene);

  const mon = {
    mesh,
    mixer: monMixer,
    body,
    actions: actionMap,
    currentAction: null,
    type,
    combat,
    healthBar,
    scene,
    // AI state
    aiState: AI_PATH_TO_CRATE,
    path: [],
    pathIndex: 0,
    repathTimer: Math.random() * 0.5,  // stagger initial repath
    // Per-type extras
    divertTimer: 0,
    sprintTimer: s.sprintInterval ? (s.sprintInterval * 0.5 + Math.random() * s.sprintInterval * 0.5) : 0,
    sprinting: false,
    sprintRemaining: 0,
    // Hit tracking
    hitBySwing: -1,
    deathTimer: 0,
    removed: false,
  };

  // When attack anim finishes, clear isAttacking so AI resumes
  monMixer.addEventListener('finished', (e) => {
    if (e.action === actionMap['attack_melee']) {
      mon.combat.isAttacking = false;
      mon.combat.attackElapsed = 0;
      mon.currentAction = null;
    }
  });

  switchAction(mon, 'idle');
  monsters.push(mon);
}

/**
 * Update all monsters.
 * @param {number} dt
 * @param {{x,y,z}} playerPos
 * @param {Object} attackInfo
 * @param {Object} playerCombat
 * @param {{x,y,z}} cratePos
 * @param {Object} crateCombat
 */
export function updateMonsters(dt, playerPos, attackInfo, playerCombat) {
  const cam = getCamera();

  for (let mi = monsters.length - 1; mi >= 0; mi--) {
    const mon = monsters[mi];
    if (mon.removed) { monsters.splice(mi, 1); continue; }

    // ── Death fade ──────────────────────────────────────────────
    if (mon.combat.isDead) {
      if (!mon.lootDropped) {
        mon.lootDropped = true;
        const t = mon.body.translation();
        rollLootDrop(mon.scene, { x: t.x, y: t.y, z: t.z });
      }
      mon.deathTimer += dt;
      const opacity = Math.max(0, 1.0 - mon.deathTimer / DEATH_FADE_TIME);
      mon.mesh.traverse((c) => {
        if (c.isMesh && c.material) {
          const setOp = (m) => { m.transparent = true; m.opacity = opacity; };
          Array.isArray(c.material) ? c.material.forEach(setOp) : setOp(c.material);
        }
      });
      if (mon.deathTimer >= DEATH_FADE_TIME) {
        mon.scene.remove(mon.mesh);
        mon.scene.remove(mon.healthBar.group);
        removeBody(mon.body);
        mon.removed = true;
      }
      continue;
    }

    tickCombat(mon.combat, dt);

    const pos = mon.body.translation();
    const dx  = playerPos.x - pos.x;
    const dz  = playerPos.z - pos.z;
    const distToPlayer = Math.sqrt(dx * dx + dz * dz);

    // Each monster targets its nearest alive crate
    const myCratePos    = getNearestCratePos(pos);
    const myCrateCombat = getNearestCrateCombat(pos);
    const cdx = myCratePos.x - pos.x;
    const cdz = myCratePos.z - pos.z;
    const distToCrate = Math.sqrt(cdx * cdx + cdz * cdz);

    // ── Receive player melee attack ─────────────────────────────
    if (attackInfo && attackInfo.swingFired && attackInfo.attackType === 'melee' && mon.hitBySwing !== attackInfo.swingId) {
      if (isInAttackCone(attackInfo.pos, attackInfo.yRot, pos, 2.2, 60)) {
        const { finalDamage } = applyDamage(mon.combat, rollDamage(playerCombat), 0);
        spawnDamageNumber(mon.scene, pos, finalDamage, 'enemy');
        mon.hitBySwing = attackInfo.swingId;
      }
    }

    // ── A* repath toward nearest alive crate ────────────────────
    mon.repathTimer -= dt;
    if (mon.repathTimer <= 0 && (mon.aiState === AI_PATH_TO_CRATE || mon.aiState === AI_MAGE_RANGED)) {
      mon.path = findPath(pos.x, pos.z, myCratePos.x, myCratePos.z);
      mon.pathIndex = 0;
      mon.repathTimer = repathMin + Math.random() * (repathMax - repathMin);
    }

    // ── Per-type config ─────────────────────────────────────────
    const s = monstersCfg[mon.type] || {};
    const baseSpeed = s.speed || 7;

    // ── AI state machine ────────────────────────────────────────
    if (mon.type === 'Skeleton_Warrior') {
      updateWarrior(mon, dt, pos, playerPos, distToPlayer, distToCrate, myCratePos, playerCombat, myCrateCombat, s, baseSpeed);
    } else if (mon.type === 'Skeleton_Rogue') {
      updateRogue(mon, dt, pos, distToCrate, myCratePos, myCrateCombat, s, baseSpeed);
    } else if (mon.type === 'Skeleton_Mage') {
      updateMage(mon, dt, pos, playerPos, distToPlayer, distToCrate, myCratePos, playerCombat, myCrateCombat, s, baseSpeed);
    } else {
      followPath(mon, pos, baseSpeed);
    }

    // Apply velocity from mon._move (set by update functions)
    const vel = mon.body.linvel();
    mon.body.setLinvel({ x: (mon._moveX || 0) * (mon._speed || 0), y: vel.y, z: (mon._moveZ || 0) * (mon._speed || 0) }, true);

    // Sync mesh to physics
    const t = mon.body.translation();
    mon.mesh.position.set(t.x, t.y - CAPSULE_HALF_HEIGHT - CAPSULE_RADIUS, t.z);

    const mv = mon._speed || 0;
    const mx = mon._moveX || 0;
    const mz = mon._moveZ || 0;
    if (mv > 0 && (Math.abs(mx) > 0.01 || Math.abs(mz) > 0.01)) {
      mon.mesh.rotation.y = Math.atan2(mx, mz);
    }

    mon.mixer.update(dt);
    applyHitFlash(mon.mesh, mon.combat.flashTimer);

    if (mon.healthBar) {
      mon.healthBar.group.position.set(t.x, t.y + HEALTH_BAR_Y_OFFSET, t.z);
      if (cam) tickHealthBarBillboard(mon.healthBar.group, cam);
      mon.healthBar.update(mon.combat.hp / mon.combat.maxHp);
    }
  }
}

// ── Per-type AI logic ────────────────────────────────────────────

function followPath(mon, pos, speed) {
  if (mon.pathIndex < mon.path.length) {
    const wp = mon.path[mon.pathIndex];
    const dx = wp.x - pos.x;
    const dz = wp.z - pos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < WAYPOINT_THRESHOLD) {
      mon.pathIndex++;
      return followPath(mon, pos, speed); // try next waypoint same frame
    }
    mon._moveX = dx / dist;
    mon._moveZ = dz / dist;
    mon._speed = speed;
    if (!mon.combat.isAttacking) switchAction(mon, mon.actions['run'] ? 'run' : 'walk');
  } else {
    mon._moveX = 0; mon._moveZ = 0; mon._speed = 0;
    if (!mon.combat.isAttacking) switchAction(mon, 'idle');
  }
}

function updateWarrior(mon, dt, pos, playerPos, distToPlayer, distToCrate, cratePos, playerCombat, crateCombat, s, baseSpeed) {
  const divertRange     = s.divertRange     || 5;
  const divertLoseRange = s.divertLoseRange || 8;
  const divertDuration  = s.divertDuration  || 4;

  // State transitions
  if (mon.aiState === AI_DIVERT_PLAYER) {
    mon.divertTimer -= dt;
    if (mon.divertTimer <= 0 || distToPlayer > divertLoseRange) {
      mon.aiState = AI_PATH_TO_CRATE;
      mon.repathTimer = 0; // repath immediately
    }
  } else if (mon.aiState === AI_PATH_TO_CRATE && distToPlayer < divertRange && playerCombat && !playerCombat.isDead) {
    mon.aiState = AI_DIVERT_PLAYER;
    mon.divertTimer = divertDuration;
  }

  if (distToCrate < crateAttackRange && mon.aiState !== AI_DIVERT_PLAYER) {
    mon.aiState = AI_ATTACK_CRATE;
  }

  // Behavior
  if (mon.aiState === AI_ATTACK_CRATE) {
    mon._moveX = 0; mon._moveZ = 0; mon._speed = 0;
    if (!mon.combat.isAttacking) switchAction(mon, 'idle');
    if (canAttack(mon.combat) && crateCombat && !crateCombat.isDead) {
      startAttack(mon.combat);
      switchAction(mon, mon.actions['attack_melee'] ? 'attack_melee' : 'idle', 0.1);
      const { finalDamage } = applyDamage(crateCombat, rollDamage(mon.combat), 0);
      spawnDamageNumber(mon.scene, cratePos, finalDamage, 'enemy');
    }
  } else if (mon.aiState === AI_DIVERT_PLAYER) {
    // Direct chase toward player (no A*)
    if (distToPlayer < mon.combat.attackRange) {
      mon._moveX = 0; mon._moveZ = 0; mon._speed = 0;
      if (!mon.combat.isAttacking) switchAction(mon, 'idle');
      if (canAttack(mon.combat) && playerCombat && !playerCombat.isDead) {
        startAttack(mon.combat);
        switchAction(mon, mon.actions['attack_melee'] ? 'attack_melee' : 'idle', 0.1);
        const { finalDamage } = applyDamage(playerCombat, rollDamage(mon.combat), playerCombat.shieldDice || 0);
        spawnDamageNumber(mon.scene, playerPos, finalDamage, 'player');
      }
    } else {
      const inv = distToPlayer > 0.01 ? 1 / distToPlayer : 0;
      mon._moveX = (playerPos.x - pos.x) * inv;
      mon._moveZ = (playerPos.z - pos.z) * inv;
      mon._speed = baseSpeed;
      if (!mon.combat.isAttacking) switchAction(mon, mon.actions['run'] ? 'run' : 'walk');
    }
  } else {
    // AI_PATH_TO_CRATE
    followPath(mon, pos, baseSpeed);
  }
}

function updateRogue(mon, dt, pos, distToCrate, cratePos, crateCombat, s, baseSpeed) {
  const sprintMultiplier = s.sprintSpeedMultiplier || 2.0;
  const sprintDuration   = s.sprintDuration        || 1.5;
  const sprintInterval   = s.sprintInterval         || 5;
  const waypointOffset   = s.waypointOffset         || 1.5;

  // Sprint mechanic
  if (mon.sprinting) {
    mon.sprintRemaining -= dt;
    if (mon.sprintRemaining <= 0) {
      mon.sprinting = false;
      mon.sprintTimer = sprintInterval * (0.7 + Math.random() * 0.6);
    }
  } else {
    mon.sprintTimer -= dt;
    if (mon.sprintTimer <= 0) {
      mon.sprinting = true;
      mon.sprintRemaining = sprintDuration;
    }
  }

  if (distToCrate < crateAttackRange) {
    mon.aiState = AI_ATTACK_CRATE;
    mon._moveX = 0; mon._moveZ = 0; mon._speed = 0;
    if (!mon.combat.isAttacking) switchAction(mon, 'idle');
    if (canAttack(mon.combat) && crateCombat && !crateCombat.isDead) {
      startAttack(mon.combat);
      switchAction(mon, mon.actions['attack_melee'] ? 'attack_melee' : 'idle', 0.1);
      const { finalDamage } = applyDamage(crateCombat, rollDamage(mon.combat), 0);
      spawnDamageNumber(mon.scene, cratePos, finalDamage, 'enemy');
    }
    return;
  }

  // Follow path with random lateral offset
  mon.aiState = AI_PATH_TO_CRATE;
  if (mon.pathIndex < mon.path.length) {
    const wp = mon.path[mon.pathIndex];
    // Add perpendicular offset for weaving
    let dx = wp.x - pos.x;
    let dz = wp.z - pos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < WAYPOINT_THRESHOLD) {
      mon.pathIndex++;
      return updateRogue(mon, dt, pos, distToCrate, cratePos, crateCombat, s, baseSpeed);
    }
    // Perpendicular vector
    const perpX = -dz / dist;
    const perpZ =  dx / dist;
    const offset = (Math.sin(Date.now() * 0.003 + mon.sprintTimer * 10) * waypointOffset);
    const targetX = wp.x + perpX * offset;
    const targetZ = wp.z + perpZ * offset;
    const tdx = targetX - pos.x;
    const tdz = targetZ - pos.z;
    const tDist = Math.sqrt(tdx * tdx + tdz * tdz);
    mon._moveX = tDist > 0.01 ? tdx / tDist : 0;
    mon._moveZ = tDist > 0.01 ? tdz / tDist : 0;
    mon._speed = baseSpeed * (mon.sprinting ? sprintMultiplier : 1);
    if (!mon.combat.isAttacking) switchAction(mon, mon.actions['run'] ? 'run' : 'walk');
  } else {
    mon._moveX = 0; mon._moveZ = 0; mon._speed = 0;
    if (!mon.combat.isAttacking) switchAction(mon, 'idle');
  }
}

function updateMage(mon, dt, pos, playerPos, distToPlayer, distToCrate, cratePos, playerCombat, crateCombat, s, baseSpeed) {
  const attackRange = s.attackRange    || 8;
  const kiteMin     = s.kiteMinRange   || 4;

  // Kite away from player
  if (distToPlayer < kiteMin && playerCombat && !playerCombat.isDead) {
    const inv = distToPlayer > 0.01 ? 1 / distToPlayer : 0;
    mon._moveX = -(playerPos.x - pos.x) * inv;
    mon._moveZ = -(playerPos.z - pos.z) * inv;
    mon._speed = baseSpeed * 0.6;
    switchAction(mon, mon.actions['walk'] ? 'walk' : 'idle');
    return;
  }

  // In range to attack crate or player
  if (distToCrate <= attackRange || distToPlayer <= attackRange) {
    mon.aiState = AI_MAGE_RANGED;
    mon._moveX = 0; mon._moveZ = 0; mon._speed = 0;
    if (!mon.combat.isAttacking) switchAction(mon, 'idle');

    if (canAttack(mon.combat)) {
      // Target whichever is closer: crate or player
      const targetCrate = crateCombat && !crateCombat.isDead && distToCrate <= attackRange;
      const targetPlayer = playerCombat && !playerCombat.isDead && distToPlayer <= attackRange;
      let target = null, targetPos = null;

      if (targetCrate && targetPlayer) {
        // Attack whichever is closer
        target    = distToCrate < distToPlayer ? crateCombat : playerCombat;
        targetPos = distToCrate < distToPlayer ? cratePos    : playerPos;
      } else if (targetCrate) {
        target = crateCombat; targetPos = cratePos;
      } else if (targetPlayer) {
        target = playerCombat; targetPos = playerPos;
      }

      if (target && targetPos) {
        startAttack(mon.combat);
        switchAction(mon, mon.actions['attack_melee'] ? 'attack_melee' : 'idle', 0.1);
        const mPos = mon.body.translation();
        const monCombatRef = mon.combat;
        const isPlayerTarget = target === playerCombat;
        spawnProjectileToward(
          mon.scene, mPos, targetPos, 8, createSpellMesh(),
          (hitTarget, hitPos) => {
            const dmg = rollDamage(monCombatRef);
            const { finalDamage } = applyDamage(hitTarget.combat, dmg, hitTarget.combat.shieldDice || 0);
            spawnDamageNumber(mon.scene, hitPos || hitTarget.pos, finalDamage, isPlayerTarget ? 'player' : 'enemy');
          },
          attackRange + 2, 'monster'
        );
      }
    }
    return;
  }

  // Out of range — follow path
  mon.aiState = AI_PATH_TO_CRATE;
  followPath(mon, pos, baseSpeed);
}

// ── Exports ──────────────────────────────────────────────────────

/** Returns the number of alive (non-dead, non-removed) monsters. */
export function getAliveMonsterCount() {
  return monsters.filter(m => !m.removed && !m.combat.isDead).length;
}

/** Returns alive monster targets for projectile hit detection. */
export function getMonsterTargets() {
  return monsters
    .filter(m => !m.removed && !m.combat.isDead)
    .map(m => {
      const t = m.body.translation();
      return { pos: { x: t.x, y: t.y, z: t.z }, combat: m.combat };
    });
}
