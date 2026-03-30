/**
 * Input manager — keyboard + touch (mobile virtual joystick & attack button).
 */

const keys = {};
let jumpPressed = false;
let attackPressed = false;

// Touch / virtual joystick state
let touchMoveX = 0;   // -1 to 1
let touchMoveY = 0;   // -1 to 1

let joystickActive = false;
let joystickId = null;
let joystickOriginX = 0;
let joystickOriginY = 0;
const JOYSTICK_RADIUS = 50; // px

export function initInput() {
  // ── Keyboard ──────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.code === 'Space') jumpPressed = true;
    if (e.code === 'KeyF')  attackPressed = true;
  });

  document.addEventListener('keyup', (e) => {
    keys[e.code] = false;
  });

  // ── Touch ─────────────────────────────────────────────────────
  // Prevent default browser gestures on the canvas
  document.addEventListener('touchstart',  (e) => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove',   (e) => e.preventDefault(), { passive: false });
  document.addEventListener('touchend',    (e) => e.preventDefault(), { passive: false });
  document.addEventListener('touchcancel', (e) => e.preventDefault(), { passive: false });

  const joystickEl   = document.getElementById('joystick-zone');
  const joystickKnob = document.getElementById('joystick-knob');
  const attackBtn    = document.getElementById('btn-attack');

  if (joystickEl && joystickKnob) {
    joystickEl.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      joystickActive  = true;
      joystickId      = t.identifier;
      joystickOriginX = t.clientX;
      joystickOriginY = t.clientY;
      joystickKnob.style.transform = 'translate(-50%, -50%)';
    }, { passive: false });

    const onJoystickMove = (e) => {
      if (!joystickActive) return;
      for (const t of e.changedTouches) {
        if (t.identifier !== joystickId) continue;
        const dx = t.clientX - joystickOriginX;
        const dy = t.clientY - joystickOriginY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const clamp = Math.min(dist, JOYSTICK_RADIUS);
        const angle = Math.atan2(dy, dx);
        touchMoveX =  (clamp / JOYSTICK_RADIUS) * Math.cos(angle);
        touchMoveY =  (clamp / JOYSTICK_RADIUS) * Math.sin(angle);

        // Move knob visually
        const kx = Math.cos(angle) * clamp;
        const ky = Math.sin(angle) * clamp;
        joystickKnob.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))`;
      }
    };

    const onJoystickEnd = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== joystickId) continue;
        joystickActive = false;
        joystickId     = null;
        touchMoveX     = 0;
        touchMoveY     = 0;
        joystickKnob.style.transform = 'translate(-50%, -50%)';
      }
    };

    document.addEventListener('touchmove',   onJoystickMove,   { passive: false });
    document.addEventListener('touchend',    onJoystickEnd,    { passive: false });
    document.addEventListener('touchcancel', onJoystickEnd,    { passive: false });
  }

  if (attackBtn) {
    attackBtn.addEventListener('touchstart', (e) => {
      e.stopPropagation();
      attackPressed = true;
    }, { passive: false });
  }
}

// ── Getters ────────────────────────────────────────────────────────

export function getHorizontal() {
  const left  = keys['ArrowLeft']  || keys['KeyA'] ? 1 : 0;
  const right = keys['ArrowRight'] || keys['KeyD'] ? 1 : 0;
  const kb = right - left;
  return kb !== 0 ? kb : touchMoveX;
}

export function getVertical() {
  const up   = keys['ArrowUp']   || keys['KeyW'] ? 1 : 0;
  const down = keys['ArrowDown'] || keys['KeyS'] ? 1 : 0;
  const kb = down - up;
  return kb !== 0 ? kb : touchMoveY;
}

export function consumeJump() {
  if (jumpPressed) { jumpPressed = false; return true; }
  return false;
}

export function consumeAttack() {
  if (attackPressed) { attackPressed = false; return true; }
  return false;
}
