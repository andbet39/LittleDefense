/**
 * Wave spawning system — manages monster wave progression, timing, and difficulty.
 */
import { isWalkable } from './pathfinding.js';

// ── State ────────────────────────────────────────────────────────
const WAVE_REST     = 0;
const WAVE_SPAWNING = 1;
const WAVE_ACTIVE   = 2;

let cfg = {};
let state = WAVE_REST;
let waveNumber = 0;
let restTimer = 0;
let spawnTimer = 0;
let monstersToSpawn = [];  // queue of { type } remaining this wave
let totalSpawnedThisWave = 0;

/**
 * Initialise or reset the wave system.
 * @param {Object} [waveCfg] - config.waves section
 */
export function initWaves(waveCfg = {}) {
  cfg = {
    baseMonstersPerWave:    waveCfg.baseMonstersPerWave    || 3,
    monstersPerWaveIncrease: waveCfg.monstersPerWaveIncrease || 2,
    hpMultiplierPerWave:    waveCfg.hpMultiplierPerWave    || 0.15,
    timeBetweenMonsters:    waveCfg.timeBetweenMonsters    || 1.5,
    timeBetweenWaves:       waveCfg.timeBetweenWaves       || 8,
    maxAliveMonsters:       waveCfg.maxAliveMonsters       || 20,
    typeUnlock:             waveCfg.typeUnlock || { Skeleton_Rogue: 3, Skeleton_Mage: 5 },
    typeMix:                waveCfg.typeMix    || { Skeleton_Warrior: 0.5, Skeleton_Rogue: 0.3, Skeleton_Mage: 0.2 },
  };
  state = WAVE_REST;
  waveNumber = 0;
  restTimer = cfg.timeBetweenWaves;
  spawnTimer = 0;
  monstersToSpawn = [];
  totalSpawnedThisWave = 0;
}

/** Current wave number (1-based). Returns 0 before first wave starts. */
export function getCurrentWave() {
  return waveNumber;
}

/** HP multiplier for the current wave. */
export function getHpMultiplier() {
  return 1 + (Math.max(0, waveNumber - 1)) * cfg.hpMultiplierPerWave;
}

/**
 * Pick a random walkable position on the map border.
 * @returns {{x: number, z: number}}
 */
function randomBorderPosition() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const edge = Math.floor(Math.random() * 4);
    const along = (Math.random() - 0.5) * 44; // -22 to 22
    let x, z;
    switch (edge) {
      case 0: x = along; z = -24; break;
      case 1: x = along; z =  24; break;
      case 2: x =  24;   z = along; break;
      case 3: x = -24;   z = along; break;
    }
    if (isWalkable(x, z)) return { x, z };
  }
  // Fallback: corner
  return { x: -24, z: -24 };
}

/**
 * Build the monster queue for a wave.
 */
function buildWaveQueue(wave) {
  const count = cfg.baseMonstersPerWave + (wave - 1) * cfg.monstersPerWaveIncrease;

  // Determine available types for this wave
  const available = ['Skeleton_Warrior'];
  for (const [type, unlockWave] of Object.entries(cfg.typeUnlock)) {
    if (wave >= unlockWave) available.push(type);
  }

  // Build weighted pool from available types
  let totalWeight = 0;
  const pool = [];
  for (const type of available) {
    const weight = cfg.typeMix[type] || 0;
    if (weight > 0) { pool.push({ type, weight }); totalWeight += weight; }
  }

  // Normalise and select
  const queue = [];
  for (let i = 0; i < count; i++) {
    let r = Math.random() * totalWeight;
    let selected = pool[0].type;
    for (const entry of pool) {
      r -= entry.weight;
      if (r <= 0) { selected = entry.type; break; }
    }
    queue.push({ type: selected });
  }

  return queue;
}

/**
 * Tick the wave system. Returns spawn requests.
 * @param {number} dt
 * @param {number} aliveCount - current alive monster count
 * @returns {{ spawns: Array<{type: string, x: number, z: number}>, waveJustStarted: boolean, waveAnnounce: number|null }}
 */
export function updateWaves(dt, aliveCount) {
  const result = { spawns: [], waveJustStarted: false, waveAnnounce: null };

  if (state === WAVE_REST) {
    restTimer -= dt;

    // Announce upcoming wave in the last 3 seconds
    if (restTimer <= 3 && restTimer + dt > 3) {
      result.waveAnnounce = waveNumber + 1;
    }

    if (restTimer <= 0) {
      waveNumber++;
      monstersToSpawn = buildWaveQueue(waveNumber);
      totalSpawnedThisWave = monstersToSpawn.length;
      spawnTimer = 0;
      state = WAVE_SPAWNING;
      result.waveJustStarted = true;
      console.log(`[Waves] Wave ${waveNumber} starting! ${totalSpawnedThisWave} monsters (HP x${getHpMultiplier().toFixed(2)})`);
    }

  } else if (state === WAVE_SPAWNING) {
    spawnTimer -= dt;

    if (spawnTimer <= 0 && monstersToSpawn.length > 0 && aliveCount < cfg.maxAliveMonsters) {
      const entry = monstersToSpawn.shift();
      const pos = randomBorderPosition();
      result.spawns.push({ type: entry.type, x: pos.x, z: pos.z });
      spawnTimer = cfg.timeBetweenMonsters;
    }

    // All spawned → move to active
    if (monstersToSpawn.length === 0) {
      state = WAVE_ACTIVE;
    }

  } else if (state === WAVE_ACTIVE) {
    // Wait for all monsters to die
    if (aliveCount === 0) {
      state = WAVE_REST;
      restTimer = cfg.timeBetweenWaves;
      console.log(`[Waves] Wave ${waveNumber} cleared! Next wave in ${cfg.timeBetweenWaves}s`);
    }
  }

  return result;
}
