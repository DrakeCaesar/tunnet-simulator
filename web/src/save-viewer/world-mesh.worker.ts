type ChunkPos = { x: number; y: number; z: number };

type InitMessage = {
  type: "init";
  allChunks: unknown[];
  meshChunks: unknown[];
  chunkSize: number;
  chunkRes: number;
  voxelSize: number;
  chunkYSign: number;
  chunkYOffset: number;
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
  edges: Float32Array;
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

function decodeChunkVoxelData(
  chunkRuns: unknown,
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
      // Fixed transform pipeline: +Z orientation + canonical Y inversion.
      // This maps raw (x,y,z) -> canonical (x,z,y).
      out[voxelIndex(localX, localZ, localY, chunkRes)] = Math.max(0, Math.min(255, Math.floor(blockType)));
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
  chunkKey: string,
  chunksByKey: Map<string, Uint8Array>,
  loadedChunkKeys: Set<string>,
  opts: {
    chunkSize: number;
    chunkRes: number;
    voxelSize: number;
    chunkYSign: number;
    chunkYOffset: number;
  },
): { positions: Float32Array; normals: Float32Array; colors: Float32Array; edges: Float32Array } {
  const { chunkSize, chunkRes, voxelSize, chunkYSign, chunkYOffset } = opts;
  const voxels = chunksByKey.get(chunkKey);
  if (!voxels) {
    return {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      colors: new Float32Array(0),
      edges: new Float32Array(0),
    };
  }
  const baseX = chunkPos.x * chunkSize;
  const baseY = chunkPos.y * chunkSize * chunkYSign + chunkYOffset;
  const baseZ = chunkPos.z * chunkSize;

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const edges: number[] = [];

  const voxelAt = (chunk: Uint8Array, x: number, y: number, z: number): number => {
    if (x < 0 || y < 0 || z < 0 || x >= chunkRes || y >= chunkRes || z >= chunkRes) return 0;
    return chunk[voxelIndex(x, y, z, chunkRes)] ?? 0;
  };
  const voxelAtWorldNeighbor = (x: number, y: number, z: number): number => {
    if (x >= 0 && y >= 0 && z >= 0 && x < chunkRes && y < chunkRes && z < chunkRes) {
      return voxelAt(voxels, x, y, z);
    }
    let cx = chunkPos.x;
    let cy = chunkPos.y;
    let cz = chunkPos.z;
    let lx = x;
    let ly = y;
    let lz = z;
    if (lx < 0) {
      cx -= 1;
      lx += chunkRes;
    } else if (lx >= chunkRes) {
      cx += 1;
      lx -= chunkRes;
    }
    if (ly < 0) {
      cy -= 1;
      ly += chunkRes;
    } else if (ly >= chunkRes) {
      cy += 1;
      ly -= chunkRes;
    }
    if (lz < 0) {
      cz -= 1;
      lz += chunkRes;
    } else if (lz >= chunkRes) {
      cz += 1;
      lz -= chunkRes;
    }
    const neighborKey = `${cx},${cy},${cz}`;
    if (!loadedChunkKeys.has(neighborKey)) {
      return 0;
    }
    const neighbor = chunksByKey.get(neighborKey);
    if (!neighbor) return 0;
    return voxelAt(neighbor, lx, ly, lz);
  };
  const occ = (x: number, y: number, z: number): boolean => voxelAtWorldNeighbor(x, y, z) !== 0;

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
    edges.push(
      ax, ay, az, bx, by, bz,
      bx, by, bz, cx, cy, cz,
      cx, cy, cz, dx, dy, dz,
      dx, dy, dz, ax, ay, az,
    );
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
        const t = voxelAt(voxels, x, y, z);
        if (t === 0) continue;
        const rgb = colorForBlockType(t);
        const x0 = baseX + x * voxelSize;
        const y0 = baseY + y * voxelSize;
        const z0 = baseZ + z * voxelSize;
        const x1 = x0 + voxelSize;
        const y1 = y0 + voxelSize;
        const z1 = z0 + voxelSize;

        if (voxelAtWorldNeighbor(x + 1, y, z) === 0) {
          const ao: [number, number, number, number] = [
            aoLevel(occ(x + 1, y - 1, z), occ(x + 1, y, z - 1), occ(x + 1, y - 1, z - 1)),
            aoLevel(occ(x + 1, y + 1, z), occ(x + 1, y, z - 1), occ(x + 1, y + 1, z - 1)),
            aoLevel(occ(x + 1, y + 1, z), occ(x + 1, y, z + 1), occ(x + 1, y + 1, z + 1)),
            aoLevel(occ(x + 1, y - 1, z), occ(x + 1, y, z + 1), occ(x + 1, y - 1, z + 1)),
          ];
          appendQuad(x1,y0,z0, x1,y1,z0, x1,y1,z1, x1,y0,z1, 1,0,0, rgb, ao);
        }
        if (voxelAtWorldNeighbor(x - 1, y, z) === 0) {
          const ao: [number, number, number, number] = [
            aoLevel(occ(x - 1, y - 1, z), occ(x - 1, y, z + 1), occ(x - 1, y - 1, z + 1)),
            aoLevel(occ(x - 1, y + 1, z), occ(x - 1, y, z + 1), occ(x - 1, y + 1, z + 1)),
            aoLevel(occ(x - 1, y + 1, z), occ(x - 1, y, z - 1), occ(x - 1, y + 1, z - 1)),
            aoLevel(occ(x - 1, y - 1, z), occ(x - 1, y, z - 1), occ(x - 1, y - 1, z - 1)),
          ];
          appendQuad(x0,y0,z1, x0,y1,z1, x0,y1,z0, x0,y0,z0, -1,0,0, rgb, ao);
        }
        if (voxelAtWorldNeighbor(x, y + 1, z) === 0) {
          const ao: [number, number, number, number] = [
            aoLevel(
              occ(x - 1, y + 1, z),
              occ(x, y + 1, z + 1),
              occ(x - 1, y + 1, z + 1),
            ),
            aoLevel(
              occ(x + 1, y + 1, z),
              occ(x, y + 1, z + 1),
              occ(x + 1, y + 1, z + 1),
            ),
            aoLevel(
              occ(x + 1, y + 1, z),
              occ(x, y + 1, z - 1),
              occ(x + 1, y + 1, z - 1),
            ),
            aoLevel(
              occ(x - 1, y + 1, z),
              occ(x, y + 1, z - 1),
              occ(x - 1, y + 1, z - 1),
            ),
          ];
          appendQuad(x0,y1,z1, x1,y1,z1, x1,y1,z0, x0,y1,z0, 0,1,0, rgb, ao);
        }
        if (voxelAtWorldNeighbor(x, y - 1, z) === 0) {
          const ao: [number, number, number, number] = [
            aoLevel(
              occ(x - 1, y - 1, z),
              occ(x, y - 1, z - 1),
              occ(x - 1, y - 1, z - 1),
            ),
            aoLevel(
              occ(x + 1, y - 1, z),
              occ(x, y - 1, z - 1),
              occ(x + 1, y - 1, z - 1),
            ),
            aoLevel(
              occ(x + 1, y - 1, z),
              occ(x, y - 1, z + 1),
              occ(x + 1, y - 1, z + 1),
            ),
            aoLevel(
              occ(x - 1, y - 1, z),
              occ(x, y - 1, z + 1),
              occ(x - 1, y - 1, z + 1),
            ),
          ];
          appendQuad(x0,y0,z0, x1,y0,z0, x1,y0,z1, x0,y0,z1, 0,-1,0, rgb, ao);
        }
        if (voxelAtWorldNeighbor(x, y, z + 1) === 0) {
          const ao: [number, number, number, number] = [
            aoLevel(occ(x - 1, y, z + 1), occ(x, y - 1, z + 1), occ(x - 1, y - 1, z + 1)),
            aoLevel(occ(x + 1, y, z + 1), occ(x, y - 1, z + 1), occ(x + 1, y - 1, z + 1)),
            aoLevel(occ(x + 1, y, z + 1), occ(x, y + 1, z + 1), occ(x + 1, y + 1, z + 1)),
            aoLevel(occ(x - 1, y, z + 1), occ(x, y + 1, z + 1), occ(x - 1, y + 1, z + 1)),
          ];
          appendQuad(x0,y0,z1, x1,y0,z1, x1,y1,z1, x0,y1,z1, 0,0,1, rgb, ao);
        }
        if (voxelAtWorldNeighbor(x, y, z - 1) === 0) {
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
    edges: new Float32Array(edges),
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
  const allChunks = Array.isArray(msg.allChunks) ? msg.allChunks : [];
  const meshChunks = Array.isArray(msg.meshChunks) ? msg.meshChunks : [];
  const total = allChunks.length;
  const chunksByKey = new Map<string, Uint8Array>();
  const posByKey = new Map<string, ChunkPos>();
  const loadedChunkKeys = new Set<string>();
  for (let i = 0; i < total; i += 1) {
    if (cancelled) return;
    const raw = allChunks[i];
    if (!Array.isArray(raw) || raw.length < 2) continue;
    const pos = parseChunkPosition(raw[0]);
    if (!pos) continue;
    const key = `${pos.x},${pos.y},${pos.z}`;
    chunksByKey.set(key, decodeChunkVoxelData(raw[1], msg.chunkRes));
    posByKey.set(key, pos);
    loadedChunkKeys.add(key);
    if ((i + 1) % 10 === 0 || i + 1 === total) {
      post({ type: "progress", phase: "Decoding chunks", current: i + 1, total });
    }
  }
  const meshKeys: string[] = [];
  for (let i = 0; i < meshChunks.length; i += 1) {
    const raw = meshChunks[i];
    if (!Array.isArray(raw) || raw.length < 1) continue;
    const pos = parseChunkPosition(raw[0]);
    if (!pos) continue;
    const key = `${pos.x},${pos.y},${pos.z}`;
    if (posByKey.has(key)) meshKeys.push(key);
  }
  const meshTotal = meshKeys.length;
  for (let i = 0; i < meshTotal; i += 1) {
    if (cancelled) return;
    const key = meshKeys[i]!;
    const pos = posByKey.get(key);
    if (!pos) continue;
    const mesh = buildChunkMesh(pos, key, chunksByKey, loadedChunkKeys, {
      chunkSize: msg.chunkSize,
      chunkRes: msg.chunkRes,
      voxelSize: msg.voxelSize,
      chunkYSign: msg.chunkYSign,
      chunkYOffset: msg.chunkYOffset,
    });
    post(
      {
        type: "chunkMesh",
        key: `${pos.x},${pos.y},${pos.z}`,
        positions: mesh.positions,
        normals: mesh.normals,
        colors: mesh.colors,
        edges: mesh.edges,
      },
      [mesh.positions.buffer, mesh.normals.buffer, mesh.colors.buffer, mesh.edges.buffer],
    );
    if ((i + 1) % 10 === 0 || i + 1 === meshTotal) {
      post({ type: "progress", phase: "Building mesh", current: i + 1, total: Math.max(1, meshTotal) });
    }
  }
  post({ type: "done" });
};
