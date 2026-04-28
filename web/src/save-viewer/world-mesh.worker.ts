type ChunkPos = { x: number; y: number; z: number };

type InitMessage = {
  type: "init";
  chunks: unknown[];
  orientation: number;
  chunkSize: number;
  chunkRes: number;
  voxelSize: number;
  chunkYSign: number;
  chunkYOffset: number;
  localYInvert: boolean;
};

type CancelMessage = { type: "cancel" };

type InMessage = InitMessage | CancelMessage;

type ProgressMessage = {
  type: "progress";
  phase: string;
  current: number;
  total: number;
};

type ChunkMeshMessage = {
  type: "chunkMesh";
  key: string;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
};

type DoneMessage = { type: "done" };
type OutMessage = ProgressMessage | ChunkMeshMessage | DoneMessage;

let cancelled = false;

function parseChunkPosition(value: unknown): ChunkPos | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const x = Number(v.x);
  const y = Number(v.y);
  const z = Number(v.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

function voxelIndex(x: number, y: number, z: number, chunkRes: number): number {
  return x + z * chunkRes + y * chunkRes * chunkRes;
}

function orientLocalVoxel(x: number, y: number, z: number, mode: number, chunkRes: number): { x: number; y: number; z: number } {
  const m = Math.max(0, Math.min(5, Math.floor(mode)));
  const n = chunkRes - 1;
  if (m === 0) return { x, y, z };
  if (m === 1) return { x, y: n - y, z: n - z };
  if (m === 2) return { x: y, y: n - x, z };
  if (m === 3) return { x: n - y, y: x, z };
  if (m === 4) return { x, y: n - z, z: y };
  return { x, y: z, z: n - y };
}

function decodeChunkVoxelData(
  chunkRuns: unknown,
  orientationMode: number,
  chunkRes: number,
): Uint8Array {
  const chunkVolume = chunkRes * chunkRes * chunkRes;
  const out = new Uint8Array(chunkVolume);
  if (!Array.isArray(chunkRuns)) return out;
  let linear = 0;
  for (const run of chunkRuns) {
    if (!Array.isArray(run) || run.length < 2) continue;
    const countRaw = Number(run[0]);
    const blockType = Number(run[1]);
    if (!Number.isFinite(countRaw) || !Number.isFinite(blockType)) continue;
    const count = Math.max(0, Math.floor(countRaw));
    if (count === 0) continue;
    const capped = Math.min(count, Math.max(0, chunkVolume - linear));
    if (capped <= 0) break;
    for (let i = 0; i < capped; i += 1) {
      const idx = linear + i;
      const localX = idx % chunkRes;
      const localZ = Math.floor(idx / chunkRes) % chunkRes;
      const localY = Math.floor(idx / (chunkRes * chunkRes));
      const o = orientLocalVoxel(localX, localY, localZ, orientationMode, chunkRes);
      out[voxelIndex(o.x, o.y, o.z, chunkRes)] = Math.max(0, Math.min(255, Math.floor(blockType)));
    }
    linear += capped;
    if (linear >= chunkVolume) break;
  }
  return out;
}

function colorForBlockType(kind: number): [number, number, number] {
  if (kind === 0) return [0x3b / 255, 0x42 / 255, 0x54 / 255];
  if (kind === 1) return [0x6b / 255, 0x7a / 255, 0xa1 / 255];
  if (kind === 2) return [0x8f / 255, 0xbf / 255, 0x8f / 255];
  if (kind === 3) return [0xbf / 255, 0xa3 / 255, 0x6b / 255];
  if (kind === 4) return [0x9c / 255, 0x7b / 255, 0xb0 / 255];
  return [0x61 / 255, 0x70 / 255, 0x8f / 255];
}

function aoLevel(side1: boolean, side2: boolean, corner: boolean): number {
  const occ = side1 && side2 ? 3 : Number(side1) + Number(side2) + Number(corner);
  return 1 - occ * 0.16;
}

function buildChunkMesh(
  chunkPos: ChunkPos,
  voxels: Uint8Array,
  opts: {
    chunkSize: number;
    chunkRes: number;
    voxelSize: number;
    chunkYSign: number;
    chunkYOffset: number;
    localYInvert: boolean;
  },
): { positions: Float32Array; normals: Float32Array; colors: Float32Array } {
  const { chunkSize, chunkRes, voxelSize, chunkYSign, chunkYOffset, localYInvert } = opts;
  const baseX = chunkPos.x * chunkSize;
  const baseY = chunkPos.y * chunkSize * chunkYSign + chunkYOffset;
  const baseZ = chunkPos.z * chunkSize;

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];

  const voxelAt = (x: number, y: number, z: number): number => {
    if (x < 0 || y < 0 || z < 0 || x >= chunkRes || y >= chunkRes || z >= chunkRes) return 0;
    return voxels[voxelIndex(x, y, z, chunkRes)] ?? 0;
  };
  const occ = (x: number, y: number, z: number): boolean => voxelAt(x, y, z) !== 0;

  const appendQuad = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number,
    rgb: [number, number, number],
    ao: [number, number, number, number],
  ): void => {
    const vs: Array<[number, number, number]> = [
      [ax, ay, az], [bx, by, bz], [cx, cy, cz], [ax, ay, az], [cx, cy, cz], [dx, dy, dz],
    ];
    const ai = [0, 1, 2, 0, 2, 3] as const;
    for (let i = 0; i < 6; i += 1) {
      const v = vs[i]!;
      const shade = ao[ai[i]!]!;
      positions.push(v[0], v[1], v[2]);
      normals.push(nx, ny, nz);
      colors.push(rgb[0] * shade, rgb[1] * shade, rgb[2] * shade);
    }
  };

  for (let y = 0; y < chunkRes; y += 1) {
    for (let z = 0; z < chunkRes; z += 1) {
      for (let x = 0; x < chunkRes; x += 1) {
        const t = voxelAt(x, y, z);
        if (t === 0) continue;
        const rgb = colorForBlockType(t);
        const yLocal = localYInvert ? (chunkRes - 1 - y) : y;
        const x0 = baseX + x * voxelSize;
        const y0 = baseY + yLocal * voxelSize;
        const z0 = baseZ + z * voxelSize;
        const x1 = x0 + voxelSize;
        const y1 = y0 + voxelSize;
        const z1 = z0 + voxelSize;

        if (voxelAt(x + 1, y, z) === 0) {
          const ao: [number, number, number, number] = [
            aoLevel(occ(x + 1, y - 1, z), occ(x + 1, y, z - 1), occ(x + 1, y - 1, z - 1)),
            aoLevel(occ(x + 1, y + 1, z), occ(x + 1, y, z - 1), occ(x + 1, y + 1, z - 1)),
            aoLevel(occ(x + 1, y + 1, z), occ(x + 1, y, z + 1), occ(x + 1, y + 1, z + 1)),
            aoLevel(occ(x + 1, y - 1, z), occ(x + 1, y, z + 1), occ(x + 1, y - 1, z + 1)),
          ];
          appendQuad(x1,y0,z0, x1,y1,z0, x1,y1,z1, x1,y0,z1, 1,0,0, rgb, ao);
        }
        if (voxelAt(x - 1, y, z) === 0) {
          const ao: [number, number, number, number] = [
            aoLevel(occ(x - 1, y - 1, z), occ(x - 1, y, z + 1), occ(x - 1, y - 1, z + 1)),
            aoLevel(occ(x - 1, y + 1, z), occ(x - 1, y, z + 1), occ(x - 1, y + 1, z + 1)),
            aoLevel(occ(x - 1, y + 1, z), occ(x - 1, y, z - 1), occ(x - 1, y + 1, z - 1)),
            aoLevel(occ(x - 1, y - 1, z), occ(x - 1, y, z - 1), occ(x - 1, y - 1, z - 1)),
          ];
          appendQuad(x0,y0,z1, x0,y1,z1, x0,y1,z0, x0,y0,z0, -1,0,0, rgb, ao);
        }
        if (voxelAt(x, y + 1, z) === 0) {
          const ao: [number, number, number, number] = [
            aoLevel(occ(x - 1, y + 1, z), occ(x, y + 1, z + 1), occ(x - 1, y + 1, z + 1)),
            aoLevel(occ(x + 1, y + 1, z), occ(x, y + 1, z + 1), occ(x + 1, y + 1, z + 1)),
            aoLevel(occ(x + 1, y + 1, z), occ(x, y + 1, z - 1), occ(x + 1, y + 1, z - 1)),
            aoLevel(occ(x - 1, y + 1, z), occ(x, y + 1, z - 1), occ(x - 1, y + 1, z - 1)),
          ];
          appendQuad(x0,y1,z1, x1,y1,z1, x1,y1,z0, x0,y1,z0, 0,1,0, rgb, ao);
        }
        if (voxelAt(x, y - 1, z) === 0) {
          const ao: [number, number, number, number] = [
            aoLevel(occ(x - 1, y - 1, z), occ(x, y - 1, z - 1), occ(x - 1, y - 1, z - 1)),
            aoLevel(occ(x + 1, y - 1, z), occ(x, y - 1, z - 1), occ(x + 1, y - 1, z - 1)),
            aoLevel(occ(x + 1, y - 1, z), occ(x, y - 1, z + 1), occ(x + 1, y - 1, z + 1)),
            aoLevel(occ(x - 1, y - 1, z), occ(x, y - 1, z + 1), occ(x - 1, y - 1, z + 1)),
          ];
          appendQuad(x0,y0,z0, x1,y0,z0, x1,y0,z1, x0,y0,z1, 0,-1,0, rgb, ao);
        }
        if (voxelAt(x, y, z + 1) === 0) {
          const ao: [number, number, number, number] = [
            aoLevel(occ(x - 1, y, z + 1), occ(x, y - 1, z + 1), occ(x - 1, y - 1, z + 1)),
            aoLevel(occ(x + 1, y, z + 1), occ(x, y - 1, z + 1), occ(x + 1, y - 1, z + 1)),
            aoLevel(occ(x + 1, y, z + 1), occ(x, y + 1, z + 1), occ(x + 1, y + 1, z + 1)),
            aoLevel(occ(x - 1, y, z + 1), occ(x, y + 1, z + 1), occ(x - 1, y + 1, z + 1)),
          ];
          appendQuad(x0,y0,z1, x1,y0,z1, x1,y1,z1, x0,y1,z1, 0,0,1, rgb, ao);
        }
        if (voxelAt(x, y, z - 1) === 0) {
          const ao: [number, number, number, number] = [
            aoLevel(occ(x - 1, y, z - 1), occ(x, y + 1, z - 1), occ(x - 1, y + 1, z - 1)),
            aoLevel(occ(x + 1, y, z - 1), occ(x, y + 1, z - 1), occ(x + 1, y + 1, z - 1)),
            aoLevel(occ(x + 1, y, z - 1), occ(x, y - 1, z - 1), occ(x + 1, y - 1, z - 1)),
            aoLevel(occ(x - 1, y, z - 1), occ(x, y - 1, z - 1), occ(x - 1, y - 1, z - 1)),
          ];
          appendQuad(x0,y1,z0, x1,y1,z0, x1,y0,z0, x0,y0,z0, 0,0,-1, rgb, ao);
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
  };
}

function post(msg: OutMessage, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(msg, transfer);
}

self.onmessage = (event: MessageEvent<InMessage>) => {
  const msg = event.data;
  if (msg.type === "cancel") {
    cancelled = true;
    return;
  }
  if (msg.type !== "init") return;
  cancelled = false;
  const chunks = Array.isArray(msg.chunks) ? msg.chunks : [];
  const total = chunks.length;
  for (let i = 0; i < total; i += 1) {
    if (cancelled) return;
    const raw = chunks[i];
    if (!Array.isArray(raw) || raw.length < 2) continue;
    const pos = parseChunkPosition(raw[0]);
    if (!pos) continue;
    const voxels = decodeChunkVoxelData(raw[1], msg.orientation, msg.chunkRes);
    const mesh = buildChunkMesh(pos, voxels, {
      chunkSize: msg.chunkSize,
      chunkRes: msg.chunkRes,
      voxelSize: msg.voxelSize,
      chunkYSign: msg.chunkYSign,
      chunkYOffset: msg.chunkYOffset,
      localYInvert: msg.localYInvert,
    });
    post(
      {
        type: "chunkMesh",
        key: `${pos.x},${pos.y},${pos.z}`,
        positions: mesh.positions,
        normals: mesh.normals,
        colors: mesh.colors,
      },
      [mesh.positions.buffer, mesh.normals.buffer, mesh.colors.buffer],
    );
    if ((i + 1) % 10 === 0 || i + 1 === total) {
      post({ type: "progress", phase: "Building mesh", current: i + 1, total });
    }
  }
  post({ type: "done" });
};
