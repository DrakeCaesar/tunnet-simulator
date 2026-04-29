import * as THREE from "three";

type Point2 = { x: number; z: number; key: string };
type Segment = { a: Point2; b: Point2; key: string };

const EPS = 1e-6;
const KEY_SCALE = 10000;

function pointKey(x: number, z: number): string {
  return `${Math.round(x * KEY_SCALE)},${Math.round(z * KEY_SCALE)}`;
}

function makePoint(x: number, z: number): Point2 {
  return { x, z, key: pointKey(x, z) };
}

function segmentKey(a: Point2, b: Point2): string {
  return a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`;
}

function signedArea(loop: Point2[]): number {
  let area = 0;
  for (let i = 0; i < loop.length; i += 1) {
    const a = loop[i]!;
    const b = loop[(i + 1) % loop.length]!;
    area += a.x * b.z - b.x * a.z;
  }
  return area * 0.5;
}

function containsPoint(loop: Point2[], p: Point2): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i, i += 1) {
    const a = loop[i]!;
    const b = loop[j]!;
    const crosses = (a.z > p.z) !== (b.z > p.z);
    if (!crosses) continue;
    const x = ((b.x - a.x) * (p.z - a.z)) / Math.max(EPS, b.z - a.z) + a.x;
    if (p.x < x) inside = !inside;
  }
  return inside;
}

function addIntersectionPoint(out: Point2[], ax: number, ay: number, az: number, bx: number, by: number, bz: number, y: number): void {
  const da = ay - y;
  const db = by - y;
  if (Math.abs(da) <= EPS && Math.abs(db) <= EPS) return;
  if (da * db > EPS) return;
  const denom = ay - by;
  if (Math.abs(denom) <= EPS) return;
  const t = (ay - y) / denom;
  if (t < -EPS || t > 1 + EPS) return;
  const x = ax + (bx - ax) * t;
  const z = az + (bz - az) * t;
  const p = makePoint(x, z);
  if (!out.some((q) => q.key === p.key)) out.push(p);
}

function buildSegments(meshes: THREE.Mesh[], y: number): Segment[] {
  const segmentsByKey = new Map<string, Segment>();
  for (const mesh of meshes) {
    const pos = mesh.geometry.getAttribute("position");
    if (!pos) continue;
    for (let i = 0; i + 2 < pos.count; i += 3) {
      const ax = pos.getX(i);
      const ay = pos.getY(i);
      const az = pos.getZ(i);
      const bx = pos.getX(i + 1);
      const by = pos.getY(i + 1);
      const bz = pos.getZ(i + 1);
      const cx = pos.getX(i + 2);
      const cy = pos.getY(i + 2);
      const cz = pos.getZ(i + 2);

      const minY = Math.min(ay, by, cy);
      const maxY = Math.max(ay, by, cy);
      if (y < minY - EPS || y > maxY + EPS) continue;

      const pts: Point2[] = [];
      addIntersectionPoint(pts, ax, ay, az, bx, by, bz, y);
      addIntersectionPoint(pts, bx, by, bz, cx, cy, cz, y);
      addIntersectionPoint(pts, cx, cy, cz, ax, ay, az, y);
      if (pts.length !== 2 || pts[0]!.key === pts[1]!.key) continue;

      const key = segmentKey(pts[0]!, pts[1]!);
      if (!segmentsByKey.has(key)) {
        segmentsByKey.set(key, { a: pts[0]!, b: pts[1]!, key });
      }
    }
  }
  return Array.from(segmentsByKey.values());
}

function buildLoops(segments: Segment[]): Point2[][] {
  const points = new Map<string, Point2>();
  const adjacency = new Map<string, Set<string>>();
  for (const segment of segments) {
    points.set(segment.a.key, segment.a);
    points.set(segment.b.key, segment.b);
    if (!adjacency.has(segment.a.key)) adjacency.set(segment.a.key, new Set());
    if (!adjacency.has(segment.b.key)) adjacency.set(segment.b.key, new Set());
    adjacency.get(segment.a.key)!.add(segment.b.key);
    adjacency.get(segment.b.key)!.add(segment.a.key);
  }

  const used = new Set<string>();
  const loops: Point2[][] = [];
  for (const segment of segments) {
    if (used.has(segment.key)) continue;
    const loopKeys = [segment.a.key];
    let prev = segment.a.key;
    let cur = segment.b.key;
    used.add(segment.key);

    for (let guard = 0; guard < segments.length + 4; guard += 1) {
      loopKeys.push(cur);
      if (cur === loopKeys[0]) break;
      const next = Array.from(adjacency.get(cur) ?? [])
        .find((candidate) => candidate !== prev && !used.has(segmentKey(points.get(cur)!, points.get(candidate)!)));
      if (!next) break;
      used.add(segmentKey(points.get(cur)!, points.get(next)!));
      prev = cur;
      cur = next;
    }

    if (loopKeys.length < 4 || loopKeys[loopKeys.length - 1] !== loopKeys[0]) continue;
    const loop = loopKeys.slice(0, -1).map((key) => points.get(key)!).filter(Boolean);
    if (loop.length >= 3 && Math.abs(signedArea(loop)) > EPS) loops.push(loop);
  }
  return loops;
}

function appendTri(
  positions: number[],
  colors: number[],
  a: THREE.Vector2,
  b: THREE.Vector2,
  c: THREE.Vector2,
  y: number,
): void {
  const ux = b.x - a.x;
  const uz = b.y - a.y;
  const vx = c.x - a.x;
  const vz = c.y - a.y;
  const normalY = uz * vx - ux * vz;
  const p1 = normalY >= 0 ? c : b;
  const p2 = normalY >= 0 ? b : c;
  positions.push(a.x, y, a.y, p1.x, y, p1.y, p2.x, y, p2.y);
  for (let i = 0; i < 3; i += 1) {
    colors.push(0.28, 0.32, 0.4);
  }
}

export function buildWorldCullCapGeometry(meshes: THREE.Mesh[], y: number): THREE.BufferGeometry {
  const loops = buildLoops(buildSegments(meshes, y));
  const loopInfos = loops
    .map((loop, index) => ({ loop, index, areaAbs: Math.abs(signedArea(loop)), parent: -1, depth: 0 }))
    .sort((a, b) => b.areaAbs - a.areaAbs);

  for (let i = 0; i < loopInfos.length; i += 1) {
    const child = loopInfos[i]!;
    let bestParent = -1;
    let bestArea = Infinity;
    const sample = child.loop[0]!;
    for (let j = 0; j < loopInfos.length; j += 1) {
      if (i === j) continue;
      const parent = loopInfos[j]!;
      if (parent.areaAbs <= child.areaAbs || parent.areaAbs >= bestArea) continue;
      if (!containsPoint(parent.loop, sample)) continue;
      bestParent = j;
      bestArea = parent.areaAbs;
    }
    child.parent = bestParent;
  }

  const depthFor = (idx: number): number => {
    const info = loopInfos[idx]!;
    if (info.parent < 0) return 0;
    return 1 + depthFor(info.parent);
  };
  for (let i = 0; i < loopInfos.length; i += 1) {
    loopInfos[i]!.depth = depthFor(i);
  }

  const positions: number[] = [];
  const colors: number[] = [];
  for (let i = 0; i < loopInfos.length; i += 1) {
    const outer = loopInfos[i]!;
    if (outer.depth % 2 !== 0) continue;
    let contour = outer.loop.map((p) => new THREE.Vector2(p.x, p.z));
    if (signedArea(outer.loop) > 0) contour = contour.reverse();

    const holes = loopInfos
      .filter((candidate) => candidate.parent === i && candidate.depth % 2 === 1)
      .map((candidate) => {
        let hole = candidate.loop.map((p) => new THREE.Vector2(p.x, p.z));
        if (signedArea(candidate.loop) < 0) hole = hole.reverse();
        return hole;
      });

    const allPoints = contour.concat(...holes);
    const tris = THREE.ShapeUtils.triangulateShape(contour, holes);
    for (const tri of tris) {
      appendTri(positions, colors, allPoints[tri[0]!]!, allPoints[tri[1]!]!, allPoints[tri[2]!]!, y);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(new Array(positions.length).fill(0), 3));
  const normals = geometry.getAttribute("normal");
  for (let i = 0; i < normals.count; i += 1) {
    normals.setXYZ(i, 0, 1, 0);
  }
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

export function createWorldCullCapMaterial(): THREE.MeshPhongMaterial {
  return new THREE.MeshPhongMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
}
