/// <reference types="@webgpu/types" />
import { NO_DATA_Z, SWE_WGSL, WORKGROUP } from "./shaders";
import type { SweParams } from "./swe";

export function webgpuAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator && Boolean(navigator.gpu);
}

/** Runs the shallow-water scheme on the GPU. Create with `GpuSwe.create`. */
export class GpuSwe {
  private readonly device: GPUDevice;
  private readonly n: number;
  private readonly buffers: Record<"params" | "z" | "h" | "qx" | "qy" | "inflow" | "clock" | "hmax" | "readH" | "readClock", GPUBuffer>;
  private readonly bindGroup: GPUBindGroup;
  private readonly pipelines: Record<"fluxX" | "fluxY" | "update" | "clockStep", GPUComputePipeline>;
  private readonly counts: { faceX: number; faceY: number; cells: number };
  private reading = false;

  private constructor(
    device: GPUDevice,
    n: number,
    buffers: GpuSwe["buffers"],
    bindGroup: GPUBindGroup,
    pipelines: GpuSwe["pipelines"],
    counts: GpuSwe["counts"],
  ) {
    this.device = device;
    this.n = n;
    this.buffers = buffers;
    this.bindGroup = bindGroup;
    this.pipelines = pipelines;
    this.counts = counts;
  }

  /** Returns null (with a reason) when WebGPU or a suitable adapter is missing. */
  static async create(ground: Float32Array, p: SweParams): Promise<GpuSwe | { reason: string }> {
    if (!webgpuAvailable()) return { reason: "This browser has no WebGPU." };
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { reason: "WebGPU is present but no GPU adapter is available." };
    const device = await adapter.requestDevice();
    const { nx, ny } = p;
    const n = nx * ny;

    const make = (size: number, usage: number) => device.createBuffer({ size: Math.max(16, size), usage });
    const S = GPUBufferUsage.STORAGE;
    const buffers = {
      params: make(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      z: make(n * 4, S | GPUBufferUsage.COPY_DST),
      h: make(n * 4, S | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST),
      qx: make((nx + 1) * ny * 4, S),
      qy: make(nx * (ny + 1) * 4, S),
      inflow: make(n * 4, S | GPUBufferUsage.COPY_DST),
      clock: make(8, S | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST),
      hmax: make(4, S | GPUBufferUsage.COPY_DST),
      readH: make(n * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
      readClock: make(8, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
    };

    const params = new ArrayBuffer(32);
    const u32 = new Uint32Array(params);
    const f32 = new Float32Array(params);
    u32[0] = nx;
    u32[1] = ny;
    f32[2] = p.dx;
    f32[3] = p.dy;
    f32[4] = p.manning;
    f32[5] = p.rainMmPerHour / 1000 / 3600;
    f32[6] = p.alpha;
    f32[7] = p.maxDt;
    device.queue.writeBuffer(buffers.params, 0, params);
    device.queue.writeBuffer(buffers.z, 0, ground.map((v) => (Number.isFinite(v) ? v : NO_DATA_Z)));
    const inflow = new Float32Array(n);
    for (const { cell, m3s } of p.inflow) inflow[cell] += m3s;
    device.queue.writeBuffer(buffers.inflow, 0, inflow);
    device.queue.writeBuffer(buffers.clock, 0, new Float32Array([p.maxDt, 0]));

    const shader = device.createShaderModule({ code: SWE_WGSL });
    const info = await shader.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === "error");
    if (errors.length) return { reason: `Shader failed to compile: ${errors.map((e) => e.message).join("; ")}` };
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const pipeline = (entryPoint: string) =>
      device.createComputePipeline({ layout: pipelineLayout, compute: { module: shader, entryPoint } });
    const bindGroup = device.createBindGroup({
      layout,
      entries: (["params", "z", "h", "qx", "qy", "inflow", "clock", "hmax"] as const).map((k, binding) => ({
        binding,
        resource: { buffer: buffers[k] },
      })),
    });
    return new GpuSwe(
      device,
      n,
      buffers,
      bindGroup,
      { fluxX: pipeline("fluxX"), fluxY: pipeline("fluxY"), update: pipeline("update"), clockStep: pipeline("clockStep") },
      { faceX: (nx + 1) * ny, faceY: nx * (ny + 1), cells: n },
    );
  }

  /** Queue `steps` time steps (each picks its own dt on the GPU). */
  run(steps: number): void {
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setBindGroup(0, this.bindGroup);
    const groups = (count: number) => Math.ceil(count / WORKGROUP);
    for (let k = 0; k < steps; k++) {
      pass.setPipeline(this.pipelines.fluxX);
      pass.dispatchWorkgroups(groups(this.counts.faceX));
      pass.setPipeline(this.pipelines.fluxY);
      pass.dispatchWorkgroups(groups(this.counts.faceY));
      pass.setPipeline(this.pipelines.update);
      pass.dispatchWorkgroups(groups(this.counts.cells));
      pass.setPipeline(this.pipelines.clockStep);
      pass.dispatchWorkgroups(1);
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  /** Copy depth and simulated time back. Returns null if a read is already in flight. */
  async read(): Promise<{ depth: Float32Array; time: number; dt: number } | null> {
    if (this.reading) return null;
    this.reading = true;
    try {
      const enc = this.device.createCommandEncoder();
      enc.copyBufferToBuffer(this.buffers.h, 0, this.buffers.readH, 0, this.n * 4);
      enc.copyBufferToBuffer(this.buffers.clock, 0, this.buffers.readClock, 0, 8);
      this.device.queue.submit([enc.finish()]);
      await Promise.all([this.buffers.readH.mapAsync(GPUMapMode.READ), this.buffers.readClock.mapAsync(GPUMapMode.READ)]);
      const depth = new Float32Array(this.buffers.readH.getMappedRange().slice(0));
      const [dt, time] = new Float32Array(this.buffers.readClock.getMappedRange().slice(0));
      this.buffers.readH.unmap();
      this.buffers.readClock.unmap();
      return { depth, time, dt };
    } finally {
      this.reading = false;
    }
  }

  destroy(): void {
    for (const b of Object.values(this.buffers)) b.destroy();
    this.device.destroy();
  }
}
