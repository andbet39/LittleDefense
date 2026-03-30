/**
 * Character module – loads the Barbarian model, attaches KayKit animations
 * (movement + combat), and drives a state-based update loop with full
 * melee / ranged combat support.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createCharacterBody, isGrounded } from './physics.js';
import { getHorizontal, getVertical, consumeJump, consumeAttack } from './input.js';
import { getCamera } from './camera.js';
import {
  createCombatStats, tickCombat, canAttack, startAttack, rollDamage,
  createHealthBar, tickHealthBarBillboard,
  cloneMaterials, applyHitFlash,
  createArrowMesh, spawnProjectile,
  spawnDamageNumber,
} from './combat.js';

// ── Asset paths ──────────────────────────────────────────────────
const CHARACTER_MODEL    = '/assets/Adventurer/Characters/gltf/Barbarian.glb';
const ANIM_BASIC         = '/assets/Adventurer/Animations/gltf/Rig_Medium/Rig_Medium_MovementBasic.glb';
const ANIM_ADVANCED      = '/charecter/Animations/gltf/Rig_Medium/Rig_Medium_MovementAdvanced.glb';
const ANIM_COMBAT_MELEE  = '/charecter/Animations/gltf/Rig_Medium/Rig_Medium_CombatMelee.glb';
const ANIM_COMBAT_RANGED = '/charecter/Animations/gltf/Rig_Medium/Rig_Medium_CombatRanged.glb';
const WEAPON_MODEL       = '/assets/Adventurer/Assets/gltf/axe_2handed.gltf';
const SHIELD_MODEL       = '/assets/Adventurer/Assets/gltf/shield_round_barbarian.gltf';

// ── Ranged weapon names (substring match against equipped.weapon) ─
const RANGED_WEAPON_KEYWORDS = ['Bow', 'Crossbow', 'Wand', 'Staff'];

// ── Tunables (overridden by config.player at runtime) ────────────
let MOVE_SPEED         = 12;
let JUMP_IMPULSE       = 12;
const CAPSULE_HALF_HEIGHT = 0.35;
const CAPSULE_RADIUS     = 0.3;
const GROUND_RAY_LENGTH  = CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS + 0.15;
const HEALTH_BAR_Y_OFFSET = 2.5;
let LUNGE_IMPULSE      = 3.5;
let playerCfg = null;
const AUTO_TARGET_RANGE = 6.0;  // auto-face nearest enemy within this range
const ATTACK_CONE_HALF  = 90;   // wide cone so auto-target hits reliably

/** @type {THREE.Group} */
let model;
/** @type {THREE.AnimationMixer} */
let mixer;
/** @type {import('@dimforge/rapier3d-compat').RigidBody} */
let body;
/** @type {THREE.Scene} */
let _scene;

const actions = {};
let currentAction = null;

const equipped = { weapon: null, shield: null };

/** @type {ReturnType<typeof createCombatStats>} */
let combatStats;
/** @type {ReturnType<typeof createHealthBar>} */
let healthBar;

// Swing-fired flag: true only on the frame startAttack is called.
let _swingFiredThisFrame = false;

const loader = new GLTFLoader();

function loadGLB(url) {
  return new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
}

/**
 * Attach an equipment mesh to the first matching bone on the character skeleton.
 */
function attachToBone(characterModel, equipmentMesh, boneNameCandidates) {
  let targetBone = null;
  for (const name of boneNameCandidates) {
    targetBone = characterModel.getObjectByName(name);
    if (targetBone) break;
  }
  if (!targetBone) {
    const lc = boneNameCandidates.map(n => n.toLowerCase());
    characterModel.traverse((child) => {
      if (targetBone) return;
      const childName = (child.name || '').toLowerCase();
      for (const name of lc) {
        if (childName === name || childName.includes(name)) { targetBone = child; return; }
      }
    });
  }
  if (!targetBone) {
    characterModel.traverse((child) => {
      if (targetBone) return;
      if (child.isSkinnedMesh && child.skeleton) {
        const lc = boneNameCandidates.map(n => n.toLowerCase());
        for (const bone of child.skeleton.bones) {
          if (lc.includes(bone.name.toLowerCase())) { targetBone = bone; return; }
        }
      }
    });
  }
  if (targetBone) {
    equipmentMesh.position.set(0, 0, 0);
    equipmentMesh.rotation.set(0, 0, 0);
    equipmentMesh.scale.set(1, 1, 1);
    equipmentMesh.traverse((child) => {
      if (child.isMesh) { child.castShadow = true; child.receiveShadow = false; child.frustumCulled = false; }
    });
    targetBone.add(equipmentMesh);
    console.log(`[Character] Attached to: ${targetBone.type}:${targetBone.name}`);
  } else {
    console.warn('[Character] No matching bone for:', boneNameCandidates);
  }
}

/**
 * Load the character, animations, and equipment; create physics body.
 * @param {THREE.Scene} scene
 */
export async function createCharacter(scene, cfg = {}) {
  _scene = scene;
  playerCfg = cfg;
  if (cfg.moveSpeed)     MOVE_SPEED    = cfg.moveSpeed;
  if (cfg.jumpImpulse)   JUMP_IMPULSE  = cfg.jumpImpulse;
  if (cfg.lungeImpulse)  LUNGE_IMPULSE = cfg.lungeImpulse;

  const [charGltf, basicGltf, advancedGltf, meleeGltf, rangedGltf, weaponGltf, shieldGltf] = await Promise.all([
    loadGLB(CHARACTER_MODEL),
    loadGLB(ANIM_BASIC),
    loadGLB(ANIM_ADVANCED),
    loadGLB(ANIM_COMBAT_MELEE).catch(err  => { console.warn('[Character] CombatMelee failed:', err); return null; }),
    loadGLB(ANIM_COMBAT_RANGED).catch(err => { console.warn('[Character] CombatRanged failed:', err); return null; }),
    loadGLB(WEAPON_MODEL).catch(err       => { console.warn('[Character] Weapon failed:', err); return null; }),
    loadGLB(SHIELD_MODEL).catch(err       => { console.warn('[Character] Shield failed:', err); return null; }),
  ]);

  model = charGltf.scene;
  model.scale.setScalar(1);
  model.traverse((child) => {
    if (child.isMesh) { child.castShadow = true; child.receiveShadow = false; }
  });
  scene.add(model);

  // Clone materials for per-instance hit-flash color
  cloneMaterials(model);

  if (weaponGltf) {
    attachToBone(model, weaponGltf.scene, ['handslotr', 'handr']);
    equipped.weapon = 'Axe (2H)';
  }
  if (shieldGltf) {
    attachToBone(model, shieldGltf.scene, ['handslotl', 'handl']);
    equipped.shield = 'Barbarian Shield';
  }

  mixer = new THREE.AnimationMixer(model);

  const allClips = [
    ...charGltf.animations,
    ...basicGltf.animations,
    ...advancedGltf.animations,
    ...(meleeGltf  ? meleeGltf.animations  : []),
    ...(rangedGltf ? rangedGltf.animations : []),
  ];
  console.log('[Character] All clips:', allClips.map(c => c.name));

  mapClip(allClips, 'idle',          ['Idle']);
  mapClip(allClips, 'walk',          ['Walk', 'Run_Medium']);
  mapClip(allClips, 'run',           ['Run']);
  mapClip(allClips, 'jump_up',       ['Jump_Start', 'Jump_Full_Short']);
  mapClip(allClips, 'jump_fall',     ['Jump_Idle', 'Fall_Idle', 'Falling_Idle']);
  mapClip(allClips, 'attack_melee',  ['1H_Melee_Attack_Chop', 'Attack_Chop', 'Melee_Attack', 'attack', 'slash', 'chop']);
  mapClip(allClips, 'attack_ranged', ['Shoot_Arrow', 'Ranged_Attack', 'Cast_Spell', 'throw', 'shoot', 'cast']);

  // Attack animations play once then auto-return to movement
  for (const key of ['attack_melee', 'attack_ranged']) {
    if (actions[key]) {
      actions[key].setLoop(THREE.LoopOnce, 1);
      actions[key].clampWhenFinished = false;
    }
  }

  // When any attack animation finishes, force back to idle so nothing gets stuck
  mixer.addEventListener('finished', (e) => {
    if (e.action === actions['attack_melee'] || e.action === actions['attack_ranged']) {
      combatStats.isAttacking = false;
      combatStats.attackElapsed = 0;
      currentAction = null; // allow switchAction to pick up next state
    }
  });

  if (Object.keys(actions).length === 0 && allClips.length > 0) {
    actions['idle'] = mixer.clipAction(allClips[0]);
  }

  switchAction('idle');

  body = createCharacterBody({ x: 0, y: 1, z: 0 }, CAPSULE_HALF_HEIGHT, CAPSULE_RADIUS);

  // Combat stats: Barbarian Axe (2H) 1d12+4, Barbarian Shield 1d6 defense
  const dmg = cfg.damage || {};
  combatStats = createCombatStats(
    cfg.hp || 100,
    dmg.dice || 1, dmg.sides || 12, dmg.bonus || 4,
    cfg.attackCooldown || 0.3,
    cfg.attackRange || 2.0,
    'melee',
    cfg.shieldDice || 6
  );

  // Floating health bar
  healthBar = createHealthBar(scene);
}

function mapClip(clips, stateName, keywords) {
  for (const kw of keywords) {
    const clip = clips.find(c => c.name.toLowerCase().includes(kw.toLowerCase()));
    if (clip) { actions[stateName] = mixer.clipAction(clip); return; }
  }
}

function switchAction(name, fadeDuration = 0.15) {
  const next = actions[name];
  if (!next || next === currentAction) return;
  if (currentAction) currentAction.fadeOut(fadeDuration);
  next.reset().fadeIn(fadeDuration).play();
  currentAction = next;
}

/** Detect melee vs ranged from the currently equipped weapon name. */
function detectAttackType() {
  if (!equipped.weapon) return 'melee';
  return RANGED_WEAPON_KEYWORDS.some(kw => equipped.weapon.includes(kw)) ? 'ranged' : 'melee';
}

/**
 * Find the nearest alive monster within range of the player.
 * @param {{x,y,z}} playerPos
 * @param {Array<{pos:{x,y,z}, combat:Object}>} targets
 * @param {number} maxRange
 * @returns {{pos:{x,y,z}, combat:Object, dist:number}|null}
 */
function findNearestTarget(playerPos, targets, maxRange) {
  let best = null;
  let bestDist = maxRange;
  for (const t of targets) {
    if (!t || !t.combat || t.combat.isDead) continue;
    const dx = t.pos.x - playerPos.x;
    const dz = t.pos.z - playerPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < bestDist) { bestDist = dist; best = { ...t, dist }; }
  }
  return best;
}

// Screen-shake state
let shakeTimer = 0;
let shakeIntensity = 0;

/** Trigger a camera screen-shake effect. */
function triggerShake(intensity = 0.15, duration = 0.15) {
  shakeIntensity = intensity;
  shakeTimer = duration;
}

/** Returns screen-shake offset for the camera (call from main.js via getScreenShake). */
export function getScreenShake() {
  if (shakeTimer <= 0) return { x: 0, y: 0, z: 0 };
  const t = shakeIntensity * (shakeTimer / 0.15);
  return {
    x: (Math.random() - 0.5) * t,
    y: (Math.random() - 0.5) * t * 0.5,
    z: (Math.random() - 0.5) * t,
  };
}

/**
 * Per-frame update: input → physics → auto-target → animations → combat.
 * @param {number} dt
 * @param {Array<{pos:{x,y,z}, combat:Object}>} [monsterTargets] – alive monster list for auto-targeting
 * @returns {{ pos: {x,y,z}, yRot: number, swingFired: boolean, swingId: number, attackType: string }}
 */
export function updateCharacter(dt, monsterTargets) {
  if (!body || !model) return { pos: { x: 0, y: 0, z: 0 }, yRot: 0, swingFired: false, swingId: 0, attackType: 'melee' };

  _swingFiredThisFrame = false;

  // Update combat & shake timers
  tickCombat(combatStats, dt);
  if (shakeTimer > 0) shakeTimer = Math.max(0, shakeTimer - dt);

  // Sync attack type with equipped weapon
  combatStats.attackType = detectAttackType();

  const grounded = isGrounded(body, GROUND_RAY_LENGTH);
  const hDir = getHorizontal();
  const vDir = getVertical();
  const vel  = body.linvel();

  // Normalise diagonal movement
  let mx = hDir;
  let mz = vDir;
  const len = Math.sqrt(mx * mx + mz * mz);
  if (len > 1) { mx /= len; mz /= len; }

  // Don't slide around during attack — slow down movement
  const moveMultiplier = combatStats.isAttacking ? 0.3 : 1.0;
  body.setLinvel({ x: mx * MOVE_SPEED * moveMultiplier, y: vel.y, z: mz * MOVE_SPEED * moveMultiplier }, true);

  if (consumeJump() && grounded) {
    body.setLinvel({ x: vel.x, y: JUMP_IMPULSE, z: vel.z }, true);
  }

  const pos = body.translation();

  // ── Auto-target: find nearest enemy ─────────────────────────
  const nearest = monsterTargets ? findNearestTarget(pos, monsterTargets, AUTO_TARGET_RANGE) : null;

  // ── Attack input ────────────────────────────────────────────
  if (consumeAttack() && canAttack(combatStats) && !combatStats.isDead) {
    startAttack(combatStats);
    _swingFiredThisFrame = true;

    // AUTO-TARGET: snap rotation toward nearest enemy
    if (nearest) {
      const dx = nearest.pos.x - pos.x;
      const dz = nearest.pos.z - pos.z;
      model.rotation.y = Math.atan2(dx, dz);
    }

    if (combatStats.attackType === 'ranged') {
      switchAction('attack_ranged', 0.05);
      const dmgRef = combatStats;
      spawnProjectile(
        _scene, pos, model.rotation.y, 16, createArrowMesh(),
        (target, hitPos) => {
          if (target.combat.isDead) return;
          const finalDmg = Math.max(1, rollDamage(dmgRef));
          target.combat.hp = Math.max(0, target.combat.hp - finalDmg);
          target.combat.flashTimer = 0.25;
          if (target.combat.hp <= 0) target.combat.isDead = true;
          spawnDamageNumber(_scene, hitPos || target.pos, finalDmg, 'enemy');
          triggerShake(0.08, 0.1);
        },
        12, 'player'
      );
    } else {
      switchAction('attack_melee', 0.05);
      // Lunge toward target (or forward if no target)
      const lungeAngle = model.rotation.y;
      const lunge = nearest ? LUNGE_IMPULSE * 1.5 : LUNGE_IMPULSE;
      body.applyImpulse({ x: Math.sin(lungeAngle) * lunge, y: 0, z: Math.cos(lungeAngle) * lunge }, true);
      triggerShake(0.12, 0.12);
    }
  }

  // Sync mesh to physics body
  model.position.set(pos.x, pos.y - CAPSULE_HALF_HEIGHT - CAPSULE_RADIUS, pos.z);

  // Rotation: auto-face nearest enemy when idle/close, otherwise face movement direction
  const moving = Math.abs(hDir) > 0 || Math.abs(vDir) > 0;
  if (!combatStats.isAttacking) {
    if (moving) {
      model.rotation.y = Math.atan2(hDir, vDir);
    } else if (nearest && nearest.dist < AUTO_TARGET_RANGE * 0.7) {
      // Gently face nearest enemy even while standing still
      const dx = nearest.pos.x - pos.x;
      const dz = nearest.pos.z - pos.z;
      const targetAngle = Math.atan2(dx, dz);
      let diff = targetAngle - model.rotation.y;
      // Normalize to [-PI, PI]
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      model.rotation.y += diff * Math.min(1, 8 * dt); // smooth turn
    }
  }

  // ── Animation state machine ─────────────────────────────────
  if (combatStats.isAttacking) {
    // Don't interrupt attack animation
  } else if (!grounded) {
    switchAction(vel.y > 0.5 ? (actions['jump_up'] ? 'jump_up' : 'walk') : (actions['jump_fall'] ? 'jump_fall' : 'walk'));
  } else if (moving) {
    const speed = Math.sqrt(hDir * hDir + vDir * vDir);
    switchAction(actions['run'] && speed > 0.9 ? 'run' : 'walk');
  } else {
    switchAction('idle');
  }

  mixer.update(dt);

  // ── Hit flash ───────────────────────────────────────────────
  applyHitFlash(model, combatStats.flashTimer);

  // ── Health bar ──────────────────────────────────────────────
  if (healthBar) {
    const cam = getCamera();
    healthBar.group.position.set(pos.x, pos.y + HEALTH_BAR_Y_OFFSET, pos.z);
    if (cam) tickHealthBarBillboard(healthBar.group, cam);
    healthBar.update(combatStats.hp / combatStats.maxHp);
  }

  return {
    pos: { x: pos.x, y: pos.y, z: pos.z },
    yRot: model.rotation.y,
    swingFired: _swingFiredThisFrame,
    swingId: combatStats.swingId,
    attackType: combatStats.attackType,
  };
}

/** Returns the player's live combat stats object. */
export function getPlayerCombat() {
  return combatStats;
}

/** Returns the player's current world position (for projectile target checks). */
export function getPlayerPos() {
  if (!body) return { x: 0, y: 0, z: 0 };
  return body.translation();
}

/** Returns the currently equipped weapon/shield names for HUD display. */
export function getEquipped() {
  return equipped;
}

/** Reposition the player's physics body (e.g. after crate placement). */
export function setPlayerSpawn(x, y, z) {
  if (body) body.setTranslation({ x, y, z }, true);
}
