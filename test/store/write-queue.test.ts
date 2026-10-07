import { describe, it, expect } from "vitest";
import { WriteQueue } from "../../src/store/write-queue";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("WriteQueue", () => {
  it("runs ops strictly in enqueue order, one at a time", async () => {
    const q = new WriteQueue();
    const log: string[] = [];
    let active = 0, maxActive = 0;
    const op = (name: string, ms: number) => async () => {
      active++; maxActive = Math.max(maxActive, active);
      log.push(`start ${name}`);
      await tick(ms);
      log.push(`end ${name}`);
      active--;
    };
    q.enqueue("a", op("a", 15));
    q.enqueue("b", op("b", 1));
    q.enqueue("c", op("c", 5));
    expect(q.size).toBe(3);
    await q.flush();
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(maxActive).toBe(1);
    expect(q.size).toBe(0);
  });

  it("logs a failing op with its label and keeps going", async () => {
    const logs: string[] = [];
    const q = new WriteQueue((m) => logs.push(m));
    const ran: string[] = [];
    q.enqueue("bad", async () => { throw new Error("boom"); });
    q.enqueue("good", async () => { ran.push("good"); });
    await q.flush();
    expect(ran).toEqual(["good"]);
    expect(q.failed).toBe(1);
    expect(logs.join("\n")).toMatch(/bad.*boom/);
  });

  it("enqueue never throws into the caller, even for a synchronously throwing op", async () => {
    const q = new WriteQueue();
    expect(() => q.enqueue("sync-throw", () => { throw new Error("sync"); })).not.toThrow();
    await q.flush();
    expect(q.failed).toBe(1);
  });

  it("flush waits for ops enqueued by other ops", async () => {
    const q = new WriteQueue();
    const ran: string[] = [];
    q.enqueue("outer", async () => { ran.push("outer"); q.enqueue("inner", async () => { await tick(2); ran.push("inner"); }); });
    await q.flush();
    expect(ran).toEqual(["outer", "inner"]);
  });
});
