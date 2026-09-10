import { describe, it, before, after } from "./helpers/testkit.mjs";
import { expect } from "./helpers/testkit.mjs";
import { startServer, device } from "./helpers/server.mjs";
import { computeChunkPlan, computeChunkSize, MAX_CHUNK_COUNT } from "../dist/config.js";

/** 动态切片算法：按文件大小在 [1 MiB, 8 MiB] 内取（目标分片数 4096，取最近的 2 的幂） */
describe("动态切片大小（computeChunkSize / computeChunkPlan）", () => {
  const MiB = 1024 * 1024;
  const GiB = 1024 * MiB;

  const cases = [
    [0, 1 * MiB, "空文件 → 下限"],
    [1 * MiB, 1 * MiB, "1 MiB → 1 MiB"],
    [100 * MiB, 1 * MiB, "100 MiB → 1 MiB"],
    [1 * GiB, 1 * MiB, "1 GiB → 1 MiB"],
    [4 * GiB, 1 * MiB, "4 GiB → 1 MiB（4096 片）"],
    [8 * GiB, 2 * MiB, "8 GiB → 2 MiB（4096 片）"],
    [16 * GiB, 4 * MiB, "16 GiB → 4 MiB（4096 片）"],
    [32 * GiB, 8 * MiB, "32 GiB → 8 MiB（4096 片）"],
    [64 * GiB, 8 * MiB, "64 GiB → 上限 8 MiB（8192 片）"],
  ];
  for (const [size, expected, label] of cases) {
    it(label, () => {
      expect(computeChunkSize(size)).toBe(expected);
    });
  }

  it("分片大小始终是 2 的幂，且在 [min, max] 内", () => {
    for (const size of [1, 12345, 8 * MiB, 900 * MiB, 3 * GiB, 7 * GiB, 15 * GiB, 100 * GiB]) {
      const cs = computeChunkSize(size);
      expect(Number.isInteger(Math.log2(cs))).toBe(true);
      expect(cs).toBeGreaterThanOrEqual(1 * MiB);
      expect(cs).toBeLessThanOrEqual(8 * MiB);
    }
  });

  it("可配置：min=max 时等价固定切片", () => {
    expect(computeChunkSize(1 * GiB, 512 * 1024, 512 * 1024)).toBe(512 * 1024);
    expect(computeChunkSize(64 * GiB, 512 * 1024, 512 * 1024)).toBe(512 * 1024);
  });

  it("防御：min > max（非法输入）时返回区间内的合法值", () => {
    // 函数内部把区间收敛为 [min(min,max), max(min,max)]；配置层才是「以 min 为准」的收敛点
    const cs = computeChunkSize(16 * GiB, 4 * MiB, 1 * MiB);
    expect(cs).toBe(1 * MiB);
  });

  it("computeChunkPlan：分片数 = ceil(size / chunkSize)，且不超过硬上限", () => {
    const p1 = computeChunkPlan(4 * GiB);
    expect(p1.chunkSize).toBe(1 * MiB);
    expect(p1.chunkCount).toBe(4096);

    const p2 = computeChunkPlan(16 * GiB);
    expect(p2.chunkSize).toBe(4 * MiB);
    expect(p2.chunkCount).toBe(4096);

    // 极端：把上下限压到 1 MiB 又给个巨大文件 → 兜底放大切片，分片数仍受控
    const p3 = computeChunkPlan(1024 * GiB, 1 * MiB, 1 * MiB);
    expect(p3.chunkCount).toBeLessThanOrEqual(MAX_CHUNK_COUNT);
    expect(p3.chunkSize).toBeGreaterThan(1 * MiB);
  });

  it("边界：size 正好等于切片整数倍时不多出一片", () => {
    const p = computeChunkPlan(4 * GiB + 1); // 4 GiB 用 1 MiB 切片
    expect(p.chunkCount).toBe(4097);
  });
});

/** init 端点下发的切片：与算法一致，且客户端必须跟随 */
describe("init 下发动态切片", () => {
  let s;

  before(async () => {
    s = await startServer({ store: "memory", label: "chunkplan" });
  });

  after(async () => {
    await s.stop();
  });

  const initSize = async (size) => {
    const r = await fetch(s.base + "/api/upload/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x.bin", size, mime: "application/octet-stream", device: device() }),
    });
    return { status: r.status, json: await r.json() };
  };

  it("1 GiB → 1 MiB / 1024 片", async () => {
    const { status, json } = await initSize(1024 * 1024 * 1024);
    expect(status).toBe(200);
    expect(json.chunkSize).toBe(1024 * 1024);
    expect(json.chunkCount).toBe(1024);
  });

  it("16 GiB → 4 MiB / 4096 片", async () => {
    const { json } = await initSize(16 * 1024 * 1024 * 1024);
    expect(json.chunkSize).toBe(4 * 1024 * 1024);
    expect(json.chunkCount).toBe(4096);
  });

  it("分片大小随文件大小单调不减（大文件不会用更小的片）", async () => {
    const sizes = [64 * 1024 * 1024, 512 * 1024 * 1024, 4 * 1024 ** 3, 12 * 1024 ** 3, 16 * 1024 ** 3]; // 不超过默认 maxFileSize(16GiB)
    let prev = 0;
    for (const size of sizes) {
      const { json } = await initSize(size);
      expect(json.chunkSize).toBeGreaterThanOrEqual(prev);
      prev = json.chunkSize;
    }
  });

  it("health 下发切片的上下限（不再下发单一 chunkSize）", async () => {
    const h = await (await fetch(s.base + "/api/health")).json();
    expect(h.limits.chunkSizeMin).toBe(1024 * 1024);
    expect(h.limits.chunkSizeMax).toBe(8 * 1024 * 1024);
    expect(h.limits.chunkSize).toBeUndefined();
  });

  it("配置成固定切片（min=max=512KiB）时 init 也固定下发 512KiB", async () => {
    const s2 = await startServer({ store: "memory", label: "chunkfix", config: { chunkSizeMin: 512 * 1024, chunkSizeMax: 512 * 1024 } });
    try {
      const h = await (await fetch(s2.base + "/api/health")).json();
      expect(h.limits.chunkSizeMin).toBe(512 * 1024);
      expect(h.limits.chunkSizeMax).toBe(512 * 1024);
      const r = await (
        await fetch(s2.base + "/api/upload/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "big.bin", size: 8 * 1024 * 1024 * 1024, device: device() }),
        })
      ).json();
      expect(r.chunkSize).toBe(512 * 1024); // 不再按文件大小放大
      expect(r.chunkCount).toBe(16384);
    } finally {
      await s2.stop();
    }
  });
});
