import type { Transform } from '@stewmore/expo-ar';

export type Vec3 = { x: number; y: number; z: number };
// Degrees. Applied in this order, about the surface frame's fixed axes: rotation (roll, about
// the normal), then pitch (about the surface's right axis), then yaw (about its up axis).
export type DrawingAngles = { rotation: number; pitch: number; yaw: number };

// Surfaces whose normal is within ~60° of horizontal count as walls.
export function isVerticalNormal(n: Vec3): boolean {
  return Math.abs(n.y) < 0.5;
}

// Gap between a drawing and its surface, so it doesn't z-fight with it.
const SURFACE_GAP_M = 0.003;
// Above this |normal.y| the surface is too flat for world up to define the drawing's top.
const FLAT_NORMAL_Y = 0.9;

const WORLD_UP: Vec3 = { x: 0, y: 1, z: 0 };
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const normalize = (a: Vec3): Vec3 | null => {
  const len = Math.hypot(a.x, a.y, a.z);
  return len > 1e-4 ? scale(a, 1 / len) : null;
};
// `v` with its component along unit `n` removed, normalized.
const inPlane = (v: Vec3, n: Vec3) => normalize(add(v, scale(n, -dot(v, n))));
const toRad = (deg: number) => (deg * Math.PI) / 180;

/**
 * Direction of the drawing's top edge on a surface: up the wall for walls and slopes; for
 * near-flat surfaces (floors, tables, car hoods), away from the viewer along `cameraForward`.
 */
export function surfaceUp(normal: Vec3, cameraForward?: Vec3): Vec3 {
  const n = normalize(normal) ?? WORLD_UP;
  const candidates = Math.abs(n.y) < FLAT_NORMAL_Y ? [WORLD_UP] : [];
  if (cameraForward) candidates.push(cameraForward);
  candidates.push({ x: 0, y: 0, z: -1 }, { x: 1, y: 0, z: 0 });
  for (const c of candidates) {
    const up = inPlane(c, n);
    if (up) return up;
  }
  return WORLD_UP; // unreachable: -Z and +X can't both be parallel to n
}

/**
 * Pose (column-major 4x4, relative to the anchor's position) for an image on a surface. With
 * zero angles its +Z face points along the outward `normal` and its top edge along `up`.
 */
export function surfaceImagePose(normal: Vec3, up: Vec3, angles: DrawingAngles): Transform {
  const n = normalize(normal) ?? WORLD_UP;
  const u = inPlane(up, n) ?? surfaceUp(n);
  const r = cross(u, n);
  // Surface frame (r, u, n) → world.
  const toWorld = (v: Vec3) => add(add(scale(r, v.x), scale(u, v.y)), scale(n, v.z));

  const [cr, sr] = [Math.cos(toRad(angles.rotation)), Math.sin(toRad(angles.rotation))];
  const [cp, sp] = [Math.cos(toRad(angles.pitch)), Math.sin(toRad(angles.pitch))];
  const [cy, sy] = [Math.cos(toRad(angles.yaw)), Math.sin(toRad(angles.yaw))];
  // R = Ry(yaw) · Rx(pitch) · Rz(roll), in surface coordinates. Positive pitch tips the top
  // edge toward the viewer; positive roll is counter-clockwise when facing the drawing.
  const rotate = (v: Vec3): Vec3 => {
    const a = { x: cr * v.x - sr * v.y, y: sr * v.x + cr * v.y, z: v.z }; // roll
    const b = { x: a.x, y: cp * a.y - sp * a.z, z: sp * a.y + cp * a.z }; // pitch
    return { x: cy * b.x + sy * b.z, y: b.y, z: -sy * b.x + cy * b.z }; // yaw
  };
  const x = toWorld(rotate({ x: 1, y: 0, z: 0 }));
  const y = toWorld(rotate({ x: 0, y: 1, z: 0 }));
  const z = toWorld(rotate({ x: 0, y: 0, z: 1 }));
  const offset = scale(n, SURFACE_GAP_M);

  return [
    x.x, x.y, x.z, 0,
    y.x, y.y, y.z, 0,
    z.x, z.y, z.z, 0,
    offset.x, offset.y, offset.z, 1,
  ];
}
