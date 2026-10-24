/**
 * Minimal glTF 2.0 binary (GLB) writer for one triangle mesh with custom attributes.
 * Custom attribute names must start with "_" (e.g. "_DEPTH"); Cesium exposes them to
 * a CustomShader as vsInput.attributes.depth.
 */

const FLOAT = 5126;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

export interface MeshInput {
  positions: Float32Array; // xyz triples
  scalars: Record<string, Float32Array>; // one value per vertex
  indices: Uint32Array;
}

function pad4(n: number): number {
  return (n + 3) & ~3;
}

export function writeGlb(mesh: MeshInput): ArrayBuffer {
  const vertexCount = mesh.positions.length / 3;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i++) {
    const k = i % 3;
    const v = mesh.positions[i];
    if (v < min[k]) min[k] = v;
    if (v > max[k]) max[k] = v;
  }

  const chunks: ArrayBufferView[] = [mesh.positions];
  const names = Object.keys(mesh.scalars);
  for (const name of names) {
    if (!name.startsWith("_")) throw new Error(`Custom attribute ${name} must start with "_"`);
    if (mesh.scalars[name].length !== vertexCount) throw new Error(`${name} has the wrong length`);
    chunks.push(mesh.scalars[name]);
  }
  chunks.push(mesh.indices);

  const bufferViews: object[] = [];
  let offset = 0;
  chunks.forEach((c, i) => {
    bufferViews.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: c.byteLength,
      target: i === chunks.length - 1 ? ELEMENT_ARRAY_BUFFER : ARRAY_BUFFER,
    });
    offset += pad4(c.byteLength);
  });
  const binLength = offset;

  const accessors: object[] = [
    { bufferView: 0, componentType: FLOAT, count: vertexCount, type: "VEC3", min, max },
    ...names.map((_, i) => ({ bufferView: i + 1, componentType: FLOAT, count: vertexCount, type: "SCALAR" })),
    { bufferView: chunks.length - 1, componentType: UNSIGNED_INT, count: mesh.indices.length, type: "SCALAR" },
  ];
  const attributes: Record<string, number> = { POSITION: 0 };
  names.forEach((n, i) => (attributes[n] = i + 1));

  const json = {
    asset: { version: "2.0", generator: "FloodScope 3D" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes, indices: accessors.length - 1, mode: 4 }] }],
    buffers: [{ byteLength: binLength }],
    bufferViews,
    accessors,
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = pad4(jsonBytes.length);
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const out = new ArrayBuffer(total);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);

  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);

  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  bytes.set(jsonBytes, 20);
  bytes.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength); // pad JSON with spaces

  const binStart = 20 + jsonLength;
  view.setUint32(binStart, binLength, true);
  view.setUint32(binStart + 4, 0x004e4942, true); // "BIN\0"
  let at = binStart + 8;
  for (const c of chunks) {
    bytes.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), at);
    at += pad4(c.byteLength);
  }
  return out;
}
