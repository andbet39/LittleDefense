/**
 * Entry point – tower defense game: defend the crate against monster waves.
 */
import * as THREE from 'three';
import { initPhysics, stepPhysics } from './physics.js';
import { createCamera, getCamera, resizeCamera, updateCamera } from './camera.js';
import { createPlatforms, OBSTACLES, TERRAIN } from './platforms.js';
import { createCharacter, updateCharacter, getEquipped, getPlayerCombat, getPlayerPos, setPlayerSpawn, getScreenShake } from './character.js';
import { preloadMonsterAssets, initMonsterConfig, spawnMonster, updateMonsters, getMonsterTargets, getAliveMonsterCount } from './monsters.js';
import { updateProjectiles, clearProjectiles, updateDamageNumbers } from './combat.js';
import { buildNavGrid } from './pathfinding.js';
import { createCrate, updateCrate, getCratePos, isCrateDestroyed, getCrateTargets } from './crate.js';
import { initWaves, updateWaves, getCurrentWave, getHpMultiplier } from './waves.js';
import { initInput } from './input.js';
import { preloadLootAssets, updateLoot, getScore } from './loot.js';

async function main() {
  // ── Load config ──────────────────────────────────────────────────
  let config = {};
  try {
    const resp = await fetch('/config.json');
    config = await resp.json();
  } catch (e) {
    console.warn('[Main] config.json not found, using defaults');
  }

  // ── Renderer ──────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  document.body.appendChild(renderer.domElement);

  // ── Scene ─────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);
  scene.fog = new THREE.Fog(0x87ceeb, 50, 120);

  // ── Lighting ──────────────────────────────────────────────────
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);

  const dirLight = new THREE.DirectionalLight(0xfff4e6, 1.2);
  dirLight.position.set(20, 30, 20);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(2048, 2048);
  dirLight.shadow.camera.near = 0.5;
  dirLight.shadow.camera.far = 100;
  dirLight.shadow.camera.left = -35;
  dirLight.shadow.camera.right = 35;
  dirLight.shadow.camera.top = 35;
  dirLight.shadow.camera.bottom = -35;
  scene.add(dirLight);
  scene.add(dirLight.target);

  // ── Camera ────────────────────────────────────────────────────
  createCamera(window.innerWidth / window.innerHeight);

  // ── Physics ───────────────────────────────────────────────────
  await initPhysics();

  // ── Environment ───────────────────────────────────────────────
  await createPlatforms(scene);

  // ── Nav grid ──────────────────────────────────────────────────
  buildNavGrid(OBSTACLES, TERRAIN, config.pathfinding);

  // ── Crate (defense target) ────────────────────────────────────
  await createCrate(scene, config.crate);

  // ── Character ─────────────────────────────────────────────────
  await createCharacter(scene, config.player);
  const spawnOff = config.player?.spawnOffset || { x: 3, z: 3 };
  const crateP = getCratePos();
  setPlayerSpawn(crateP.x + spawnOff.x, 1, crateP.z + spawnOff.z);

  // ── Monsters (preload assets, configure) ──────────────────────
  initMonsterConfig(config.monsters, config);
  await preloadMonsterAssets();

  // ── Loot assets ───────────────────────────────────────────────
  await preloadLootAssets();

  // ── Wave system ───────────────────────────────────────────────
  initWaves(config.waves);

  // ── Input ─────────────────────────────────────────────────────
  initInput();

  // ── Resize handler ────────────────────────────────────────────
  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    resizeCamera(window.innerWidth / window.innerHeight);
  });

  // ── Hide loading screen ───────────────────────────────────────
  const loadingEl = document.getElementById('loading');
  if (loadingEl) loadingEl.classList.add('hidden');

  // ── Populate HUDs ─────────────────────────────────────────────
  updateEquipmentHUD();
  updateWaveHUD(0);

  // ── Game loop ─────────────────────────────────────────────────
  const clock = new THREE.Clock();
  const FIXED_DT = 1 / 60;
  let accumulator = 0;

  function loop() {
    requestAnimationFrame(loop);

    const frameDt = Math.min(clock.getDelta(), 0.1);
    accumulator += frameDt;

    while (accumulator >= FIXED_DT) {
      stepPhysics();
      accumulator -= FIXED_DT;
    }

    // ── Character (pass monster targets for auto-targeting) ────
    const charResult = updateCharacter(frameDt, getMonsterTargets());
    const charPos = charResult.pos;

    // ── Waves ─────────────────────────────────────────────────
    const waveResult = updateWaves(frameDt, getAliveMonsterCount());
    for (const s of waveResult.spawns) {
      spawnMonster(scene, s.type, s.x, s.z, getHpMultiplier());
    }
    if (waveResult.waveJustStarted || waveResult.waveAnnounce) {
      updateWaveHUD(waveResult.waveAnnounce || getCurrentWave());
    }

    // ── Monsters (each finds its nearest alive crate) ──────────
    updateMonsters(frameDt, charPos, charResult, getPlayerCombat());

    // ── Crate ─────────────────────────────────────────────────
    updateCrate(frameDt, getCamera());

    // ── Projectiles (monster spells can hit player OR crate) ──
    // Monster spells can hit player or any alive crate
    const crateTgts = getCrateTargets();
    const firstCrate = crateTgts[0];
    updateProjectiles(frameDt, getMonsterTargets(), getPlayerPos(), getPlayerCombat(), firstCrate ? firstCrate.pos : null, firstCrate ? firstCrate.combat : null);
    updateDamageNumbers(frameDt);

    // ── Loot pickups ──────────────────────────────────────────
    updateLoot(frameDt, charPos, getPlayerCombat());
    updateScoreHUD();

    // ── Game over: player dead OR crate destroyed ─────────────
    if (charPos.y < -10 || (getPlayerCombat() && getPlayerCombat().isDead) || isCrateDestroyed()) {
      clearProjectiles();
      showGameOver(getCurrentWave());
      return;
    }

    // ── Lighting follows player ───────────────────────────────
    dirLight.position.set(charPos.x + 20, 30, charPos.z + 20);
    dirLight.target.position.set(charPos.x, 0, charPos.z);
    dirLight.target.updateMatrixWorld();

    updateCamera(charPos, frameDt);

    // Screen shake offset
    const shake = getScreenShake();
    const cam = getCamera();
    cam.position.x += shake.x;
    cam.position.y += shake.y;
    cam.position.z += shake.z;

    renderer.render(scene, cam);
  }

  loop();
}

// ── HUD helpers ──────────────────────────────────────────────────

function updateEquipmentHUD() {
  const eq = getEquipped();
  const weaponSlot = document.getElementById('slot-weapon');
  const shieldSlot = document.getElementById('slot-shield');

  if (weaponSlot) {
    const label = weaponSlot.querySelector('.label');
    if (eq.weapon) {
      label.textContent = eq.weapon;
      weaponSlot.classList.remove('empty');
      weaponSlot.setAttribute('aria-label', `Weapon slot: ${eq.weapon}`);
    } else {
      label.textContent = '—';
      weaponSlot.classList.add('empty');
      weaponSlot.setAttribute('aria-label', 'Weapon slot: empty');
    }
  }

  if (shieldSlot) {
    const label = shieldSlot.querySelector('.label');
    if (eq.shield) {
      label.textContent = eq.shield;
      shieldSlot.classList.remove('empty');
      shieldSlot.setAttribute('aria-label', `Shield slot: ${eq.shield}`);
    } else {
      label.textContent = '—';
      shieldSlot.classList.add('empty');
      shieldSlot.setAttribute('aria-label', 'Shield slot: empty');
    }
  }
}

function updateWaveHUD(wave) {
  const el = document.getElementById('wave-number');
  if (el) el.textContent = wave || '—';
}

function updateScoreHUD() {
  const el = document.getElementById('score-number');
  if (el) el.textContent = getScore();
}

function showGameOver(wave) {
  const overlay = document.createElement('div');
  overlay.setAttribute('role', 'alert');
  overlay.setAttribute('aria-live', 'assertive');
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'column',
    background: 'rgba(0, 0, 0, 0.75)',
    color: '#ff4444',
    fontFamily: 'system-ui, sans-serif',
    fontSize: '2.5rem',
    fontWeight: 'bold',
    zIndex: '100',
  });
  overlay.textContent = 'GAME OVER';

  if (wave) {
    const waveLine = document.createElement('p');
    waveLine.style.cssText = 'color:#ffcc00;font-size:1.3rem;margin-top:0.5rem;';
    waveLine.textContent = `Wave ${wave} reached`;
    overlay.appendChild(waveLine);
  }

  const sub = document.createElement('p');
  sub.style.cssText = 'color:#ccc;font-size:1rem;margin-top:1rem;';
  sub.textContent = 'Restarting…';
  overlay.appendChild(sub);

  document.body.appendChild(overlay);
  setTimeout(() => window.location.reload(), 2500);
}

main().catch((err) => {
  console.error('Failed to start VibeDungeon:', err);
  const loadingEl = document.getElementById('loading');
  if (loadingEl) loadingEl.textContent = 'Failed to load – check the console for details.';
});
