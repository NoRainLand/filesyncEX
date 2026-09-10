/**
 * 极小测试工具（describe / it / before / after / expect），**进程内**顺序执行。
 *
 * 为什么不用 node:test / vitest：
 *  - `node --test` 默认给每个测试文件 spawn 子进程（管道 stdio）→ 受限沙箱 / CI 直接 EPERM；Node 18 无隔离开关；
 *  - vitest 依赖 esbuild 子进程加载配置，同样会 spawn。
 * 本工具零依赖、零子进程、零配置：`node test/run.mjs` 直接跑。
 */
import assert from "node:assert/strict";

let nextId = 0;
const root = { name: "", tests: [], befores: [], afters: [], parent: null, depth: -1 };
let current = root;

/** 定义一组用例（支持嵌套） */
export function describe(name, fn) {
  const suite = { name, tests: [], befores: [], afters: [], parent: current, depth: current.depth + 1 };
  const prev = current;
  current = suite;
  fn();
  current = prev;
  (prev.tests ?? []).push({ __suite: true, suite });
}

/** 定义单个用例 */
export function it(name, fn) {
  current.tests.push({ __suite: false, id: nextId++, name, fn, suite: current });
}

export const test = it;
export function before(fn) {
  current.befores.push(fn);
}
export function after(fn) {
  current.afters.push(fn);
}

/** 极简 expect（基于 node:assert/strict），用法接近 vitest/chai */
export function expect(actual) {
  return {
    toBe: (e) => assert.strictEqual(actual, e),
    toEqual: (e) => assert.deepStrictEqual(actual, e),
    toBeTruthy: () => assert.ok(actual),
    toBeFalsy: () => assert.ok(!actual),
    toBeUndefined: () => assert.strictEqual(actual, undefined),
    toBeGreaterThanOrEqual: (n) => assert.ok(actual >= n, `${actual} >= ${n}`),
    toBeGreaterThan: (n) => assert.ok(actual > n, `${actual} > ${n}`),
    toBeLessThan: (n) => assert.ok(actual < n, `${actual} < ${n}`),
    toBeLessThanOrEqual: (n) => assert.ok(actual <= n, `${actual} <= ${n}`),
    toHaveLength: (n) => assert.strictEqual(actual.length, n),
    toContain: (v) => assert.ok(actual.includes(v), `${JSON.stringify(actual)} 应包含 ${JSON.stringify(v)}`),
    toMatch: (re) => assert.match(String(actual), re),
    /** toHaveProperty("a.b") 校验存在；带第二个参数时同时校验值 */
    toHaveProperty: (key, ...rest) => {
      const keys = Array.isArray(key) ? key : String(key).split(".");
      let cur = actual;
      for (const k of keys) {
        assert.ok(cur !== null && cur !== undefined && k in cur, `缺少属性 ${keys.join(".")}`);
        cur = cur[k];
      }
      if (rest.length > 0) assert.deepStrictEqual(cur, rest[0]);
    },
    resolves: {
      toMatchObject: async (o) => {
        const got = await actual;
        for (const [k, v] of Object.entries(o)) {
          assert.deepStrictEqual(got?.[k], v, `字段 ${k} 不匹配：${JSON.stringify(got?.[k])} !== ${JSON.stringify(v)}`);
        }
      },
      toEqual: async (o) => assert.deepStrictEqual(await actual, o),
      toBe: async (o) => assert.strictEqual(await actual, o),
    },
    rejects: {
      toThrow: async (re) => {
        let threw;
        try {
          await actual;
        } catch (e) {
          threw = e;
        }
        assert.ok(threw, "期望 promise reject，但成功 resolve 了");
        if (re) assert.match(String(threw?.message ?? threw), re);
      },
    },
  };
}

/** 运行全部已注册用例；返回 { pass, fail } */
export async function runAll(filter) {
  const stats = { pass: 0, fail: 0, skip: 0 };
  const failures = [];

  const runSuite = async (suite) => {
    const befores = [];
    for (let s = suite; s; s = s.parent) befores.unshift(...s.befores);
    const afters = [];
    for (let s = suite; s; s = s.parent) afters.push(...s.afters);

    const title = suite.name ? `${"  ".repeat(Math.max(suite.depth, 0))}${suite.name}` : "";
    if (title) console.log(`\n${title}`);

    let hookError;
    try {
      for (const b of befores) await b();
    } catch (e) {
      hookError = e;
    }
    if (!hookError) {
      for (const t of suite.tests) {
        if (t.__suite) {
          await runSuite(t.suite);
          continue;
        }
        if (filter && !t.name.includes(filter)) {
          stats.skip++;
          continue;
        }
        try {
          await t.fn();
          stats.pass++;
          console.log(`  ✓ ${t.name}`);
        } catch (e) {
          stats.fail++;
          failures.push({ name: t.name, err: e });
          console.log(`  ✗ ${t.name}`);
        }
      }
    } else {
      stats.fail++;
      failures.push({ name: `${suite.name}（before 钩子）`, err: hookError });
      console.log(`  ✗ before 钩子失败`);
    }
    try {
      for (const a of afters) await a();
    } catch (e) {
      console.warn("  ⚠ after 钩子异常:", e?.message ?? e);
    }
  };

  await runSuite(root);
  if (failures.length > 0) {
    console.log("\n失败详情：");
    for (const f of failures) {
      console.log(`\n✗ ${f.name}`);
      console.log(
        String(f.err?.stack ?? f.err?.message ?? f.err)
          .split("\n")
          .map((l) => "    " + l)
          .join("\n")
      );
    }
  }
  console.log(`\n测试结果：${stats.pass} 通过, ${stats.fail} 失败${stats.skip ? `, ${stats.skip} 跳过` : ""}`);
  return stats;
}
