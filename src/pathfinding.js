/**
 * A* pathfinding on a 2D navigation grid.
 * Grid is built from obstacle data; terrain platforms are walkable.
 */

let gridSize = 50;
let grid = null; // Uint8Array, 0=walkable, 1=blocked

function toGrid(worldVal) {
  return Math.max(0, Math.min(gridSize - 1, Math.floor(worldVal + gridSize / 2)));
}

function toWorld(gridVal) {
  return gridVal - gridSize / 2 + 0.5;
}

function idx(gx, gz) {
  return gz * gridSize + gx;
}

/**
 * Build the navigation grid from obstacle and terrain data.
 * @param {Array} obstacles - OBSTACLES array from platforms.js
 * @param {Array} terrain - TERRAIN array (unused — platforms are walkable)
 * @param {Object} [cfg] - config.pathfinding section
 */
export function buildNavGrid(obstacles, terrain, cfg = {}) {
  gridSize = cfg.gridSize || 50;
  const padding = cfg.obstaclePadding || 0.3;

  grid = new Uint8Array(gridSize * gridSize); // all 0 = walkable

  for (const obs of obstacles) {
    let minX, maxX, minZ, maxZ;

    if (obs.collider === 'cylinder') {
      const r = (obs.cr || 0.3) + padding;
      minX = obs.x - r;  maxX = obs.x + r;
      minZ = obs.z - r;  maxZ = obs.z + r;
    } else {
      // box collider
      const hw = (obs.cw || 0.5) + padding;
      const hd = (obs.cd || 0.5) + padding;
      minX = obs.x - hw;  maxX = obs.x + hw;
      minZ = obs.z - hd;  maxZ = obs.z + hd;
    }

    const gMinX = toGrid(minX);
    const gMaxX = toGrid(maxX);
    const gMinZ = toGrid(minZ);
    const gMaxZ = toGrid(maxZ);

    for (let gz = gMinZ; gz <= gMaxZ; gz++) {
      for (let gx = gMinX; gx <= gMaxX; gx++) {
        grid[idx(gx, gz)] = 1;
      }
    }
  }

  console.log(`[Pathfinding] Nav grid ${gridSize}x${gridSize} built. Blocked: ${grid.reduce((a, v) => a + v, 0)} cells`);
}

/**
 * Check if a world position is on a walkable cell.
 */
export function isWalkable(x, z) {
  if (!grid) return true;
  const gx = toGrid(x);
  const gz = toGrid(z);
  return grid[idx(gx, gz)] === 0;
}

// ── A* implementation ────────────────────────────────────────────

const SQRT2 = Math.SQRT2;

// 8-directional neighbors: [dx, dz, cost]
const DIRS = [
  [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
  [-1, -1, SQRT2], [-1, 1, SQRT2], [1, -1, SQRT2], [1, 1, SQRT2],
];

function octileHeuristic(ax, az, bx, bz) {
  const dx = Math.abs(ax - bx);
  const dz = Math.abs(az - bz);
  return (dx + dz) + (SQRT2 - 2) * Math.min(dx, dz);
}

/**
 * Find a path from world (sx,sz) to world (gx,gz).
 * Returns array of {x,z} world-coordinate waypoints, or [] if unreachable.
 */
export function findPath(sx, sz, gx, gz) {
  if (!grid) return [];

  const startGx = toGrid(sx), startGz = toGrid(sz);
  const goalGx  = toGrid(gx), goalGz  = toGrid(gz);

  // Same cell
  if (startGx === goalGx && startGz === goalGz) return [{ x: gx, z: gz }];

  // Goal blocked — find nearest walkable neighbor
  if (grid[idx(goalGx, goalGz)] === 1) {
    let bestDist = Infinity, bestGx = goalGx, bestGz = goalGz;
    for (let r = 1; r <= 3; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = goalGx + dx, nz = goalGz + dz;
          if (nx < 0 || nx >= gridSize || nz < 0 || nz >= gridSize) continue;
          if (grid[idx(nx, nz)] !== 0) continue;
          const d = dx * dx + dz * dz;
          if (d < bestDist) { bestDist = d; bestGx = nx; bestGz = nz; }
        }
      }
      if (bestDist < Infinity) break;
    }
    if (bestDist === Infinity) return [];
    // Use the adjusted goal
    return findPathGrid(startGx, startGz, bestGx, bestGz, gx, gz);
  }

  return findPathGrid(startGx, startGz, goalGx, goalGz, gx, gz);
}

function findPathGrid(startGx, startGz, goalGx, goalGz, worldGoalX, worldGoalZ) {
  const size = gridSize;
  const gScore = new Float32Array(size * size).fill(Infinity);
  const parent = new Int32Array(size * size).fill(-1);
  const closed = new Uint8Array(size * size);

  const startIdx = idx(startGx, startGz);
  gScore[startIdx] = 0;

  // Simple binary-heap-like sorted open list (small grid, perf is fine)
  const open = [{ gx: startGx, gz: startGz, f: octileHeuristic(startGx, startGz, goalGx, goalGz) }];

  while (open.length > 0) {
    // Find minimum f
    let minI = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[minI].f) minI = i;
    }
    const cur = open[minI];
    open[minI] = open[open.length - 1];
    open.pop();

    const ci = idx(cur.gx, cur.gz);
    if (closed[ci]) continue;
    closed[ci] = 1;

    // Reached goal
    if (cur.gx === goalGx && cur.gz === goalGz) {
      return reconstructPath(parent, ci, worldGoalX, worldGoalZ);
    }

    const curG = gScore[ci];

    for (const [dx, dz, cost] of DIRS) {
      const nx = cur.gx + dx;
      const nz = cur.gz + dz;
      if (nx < 0 || nx >= size || nz < 0 || nz >= size) continue;
      const ni = idx(nx, nz);
      if (closed[ni] || grid[ni] === 1) continue;

      // Diagonal: require both cardinal neighbors to be walkable (no corner-cutting)
      if (dx !== 0 && dz !== 0) {
        if (grid[idx(cur.gx + dx, cur.gz)] === 1 || grid[idx(cur.gx, cur.gz + dz)] === 1) continue;
      }

      const tentG = curG + cost;
      if (tentG < gScore[ni]) {
        gScore[ni] = tentG;
        parent[ni] = ci;
        const h = octileHeuristic(nx, nz, goalGx, goalGz);
        open.push({ gx: nx, gz: nz, f: tentG + h });
      }
    }
  }

  return []; // no path
}

function reconstructPath(parent, goalIdx, worldGoalX, worldGoalZ) {
  const rawPath = [];
  let ci = goalIdx;
  while (ci !== -1) {
    const gz = Math.floor(ci / gridSize);
    const gx = ci % gridSize;
    rawPath.push({ x: toWorld(gx), z: toWorld(gz) });
    ci = parent[ci];
  }
  rawPath.reverse();

  // Replace last waypoint with exact world goal position
  if (rawPath.length > 0) {
    rawPath[rawPath.length - 1] = { x: worldGoalX, z: worldGoalZ };
  }

  // Remove collinear waypoints
  if (rawPath.length <= 2) return rawPath;
  const simplified = [rawPath[0]];
  for (let i = 1; i < rawPath.length - 1; i++) {
    const prev = simplified[simplified.length - 1];
    const curr = rawPath[i];
    const next = rawPath[i + 1];
    const dx1 = curr.x - prev.x, dz1 = curr.z - prev.z;
    const dx2 = next.x - curr.x, dz2 = next.z - curr.z;
    // Keep if direction changes
    if (Math.abs(dx1 * dz2 - dz1 * dx2) > 0.01) {
      simplified.push(curr);
    }
  }
  simplified.push(rawPath[rawPath.length - 1]);
  return simplified;
}
