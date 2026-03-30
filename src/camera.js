/**
 * Isometric camera that smoothly follows the player on the XZ ground plane.
 * Supports mouse-wheel zoom.
 */
import * as THREE from 'three';

/** @type {THREE.OrthographicCamera} */
let camera;

const ISO_OFFSET = new THREE.Vector3(20, 20, 20);
const LERP_SPEED = 4.0;
const DEFAULT_VIEW = 14;
const MIN_VIEW = 6;
const MAX_VIEW = 30;
const ZOOM_STEP = 1.5;

let viewSize = DEFAULT_VIEW;

/**
 * Create and return the isometric orthographic camera.
 * Also registers the scroll-wheel zoom listener.
 * @param {number} aspect
 * @returns {THREE.OrthographicCamera}
 */
export function createCamera(aspect) {
  const hw = viewSize * aspect;
  const hh = viewSize;
  camera = new THREE.OrthographicCamera(-hw, hw, hh, -hh, 0.1, 300);
  camera.position.copy(ISO_OFFSET);
  camera.lookAt(0, 0, 0);

  // Zoom via scroll wheel
  window.addEventListener('wheel', (e) => {
    e.preventDefault();
    viewSize += Math.sign(e.deltaY) * ZOOM_STEP;
    viewSize = Math.max(MIN_VIEW, Math.min(MAX_VIEW, viewSize));
    applyZoom();
  }, { passive: false });

  return camera;
}

/** Recalculate the orthographic frustum from viewSize. */
function applyZoom() {
  if (!camera) return;
  const aspect = window.innerWidth / window.innerHeight;
  camera.left   = -viewSize * aspect;
  camera.right  =  viewSize * aspect;
  camera.top    =  viewSize;
  camera.bottom = -viewSize;
  camera.updateProjectionMatrix();
}

/** Returns the active camera. */
export function getCamera() {
  return camera;
}

/** Handle window resize. */
export function resizeCamera(aspect) {
  if (!camera) return;
  camera.left   = -viewSize * aspect;
  camera.right  =  viewSize * aspect;
  camera.top    =  viewSize;
  camera.bottom = -viewSize;
  camera.updateProjectionMatrix();
}

/**
 * Smoothly follow the target position (XZ plane) each frame.
 * @param {{ x: number, z: number }} target
 * @param {number} dt
 */
export function updateCamera(target, dt) {
  const goalX = target.x + ISO_OFFSET.x;
  const goalY = ISO_OFFSET.y;
  const goalZ = target.z + ISO_OFFSET.z;

  const t = 1.0 - Math.exp(-LERP_SPEED * dt);

  camera.position.x += (goalX - camera.position.x) * t;
  camera.position.y += (goalY - camera.position.y) * t;
  camera.position.z += (goalZ - camera.position.z) * t;

  camera.lookAt(target.x, 0, target.z);
}
