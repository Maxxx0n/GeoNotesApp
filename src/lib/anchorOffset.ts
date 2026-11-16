import type { Transform } from '@stewmore/expo-ar';

export type Offset = { x: number; y: number; z: number };
type Vec2 = { x: number; z: number };

// Horizontal right/forward directions from the camera pose at the moment editing starts, so
// the X/Z sliders mean "left/right" and "away/toward" from the user's point of view. Y is
// always world up. Transforms are column-major 4x4 (see @stewmore/expo-ar).
export type EditBasis = { right: Vec2; forward: Vec2 };

function normalized(x: number, z: number): Vec2 | null {
  const len = Math.hypot(x, z);
  return len > 1e-3 ? { x: x / len, z: z / len } : null;
}

export function basisFromCamera(camera: Transform): EditBasis {
  // Camera looks down its -Z axis. When the phone points straight down that has no
  // horizontal component, so fall back to the camera's up axis (top of the screen).
  const forward = normalized(-camera[8], -camera[10]) ??
    normalized(camera[4], camera[6]) ?? { x: 0, z: -1 };
  return { forward, right: { x: -forward.z, z: forward.x } };
}

export function applyOffset(base: Transform, basis: EditBasis, o: Offset): Transform {
  const t = [...base];
  t[12] += basis.right.x * o.x + basis.forward.x * o.z;
  t[13] += o.y;
  t[14] += basis.right.z * o.x + basis.forward.z * o.z;
  return t;
}
