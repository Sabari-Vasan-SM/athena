import { describe, expect, it } from 'vitest';
import { AnalysisScheduler, type Planner, type PlannerInput } from '../../src/services/scheduler.js';
import type { SyncPlan } from '../../src/services/sync.js';
import type { WalkSnapshot } from '../../src/core/analyzer/incremental.js';

interface Call {
  input: PlannerInput;
  release: (ok?: boolean) => void;
}

/** A planner whose runs finish only when the test releases them. */
function controlledPlanner() {
  const calls: Call[] = [];
  let n = 0;
  const planner: Planner = (_root, input) =>
    new Promise((resolve, reject) => {
      const id = ++n;
      const snapshot = { takenAt: input.incremental ? input.incremental.snapshot.takenAt : Date.now() + id, configHash: 'c', excludeText: null } as unknown as WalkSnapshot;
      const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      input.signal.addEventListener('abort', onAbort, { once: true });
      calls.push({
        input,
        release: (ok = true) => {
          input.signal.removeEventListener('abort', onAbort);
          if (ok) resolve({ plan: { id: `plan-${id}` } as SyncPlan, snapshot });
          else reject(new Error(`run ${id} failed`));
        },
      });
    });
  return { planner, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !pred(); i++) await tick();
  if (!pred()) throw new Error('condition not reached');
}

describe('AnalysisScheduler', () => {
  it('runs concurrent requests as one analysis plus one coalesced follow-up', async () => {
    const { planner, calls } = controlledPlanner();
    const s = new AnalysisScheduler('/p', { planner });
    const first = s.request({ reason: 'a' });
    await until(() => calls.length === 1);
    const others = [s.request({ reason: 'b' }), s.request({ reason: 'c' }), s.request({ reason: 'd' })];
    await tick();
    expect(calls).toHaveLength(1); // single flight
    calls[0]!.release();
    expect((await first).id).toBe('plan-1');
    await until(() => calls.length === 2);
    calls[1]!.release();
    const plans = await Promise.all(others);
    expect(plans.map((p) => p.id)).toEqual(['plan-2', 'plan-2', 'plan-2']); // one follow-up for all
    expect(s.stats.runs).toBe(2);
    expect(s.busy).toBe(false);
  });

  it('coalesces a burst of watcher paths into one follow-up run with their union', async () => {
    const { planner, calls } = controlledPlanner();
    const s = new AnalysisScheduler('/p', { planner });
    s.setTracking(true);
    const first = s.request({ reason: 'watch', paths: ['a.ts'] });
    await until(() => calls.length === 1);
    calls[0]!.release();
    await first;
    // Baseline exists now; a burst while the second run is in flight:
    const second = s.request({ reason: 'watch', paths: ['b.ts'] });
    await until(() => calls.length === 2);
    expect(calls[1]!.input.incremental?.changedPaths).toEqual(['b.ts']);
    const burst = ['c.ts', 'd.ts', 'c.ts', 'e.ts'].map((p) => s.request({ reason: 'watch', paths: [p] }));
    calls[1]!.release();
    await second;
    await until(() => calls.length === 3);
    expect([...calls[2]!.input.incremental!.changedPaths].sort()).toEqual(['c.ts', 'd.ts', 'e.ts']);
    calls[2]!.release();
    expect(new Set((await Promise.all(burst)).map((p) => p.id))).toEqual(new Set(['plan-3']));
    expect(calls).toHaveLength(3);
  });

  it('only plans incrementally with change tracking and a baseline', async () => {
    const { planner, calls } = controlledPlanner();
    const s = new AnalysisScheduler('/p', { planner });
    const r1 = s.request({ reason: 'x', paths: ['a'] });
    await until(() => calls.length === 1);
    calls[0]!.release();
    await r1;
    const r2 = s.request({ reason: 'x', paths: ['a'] });
    await until(() => calls.length === 2);
    expect(calls[1]!.input.incremental).toBeUndefined(); // not tracking
    calls[1]!.release();
    await r2;

    s.setTracking(true);
    const r3 = s.request({ reason: 'x' });
    await until(() => calls.length === 3);
    expect(calls[2]!.input.incremental).toBeUndefined(); // first run after tracking starts walks
    calls[2]!.release();
    await r3;
    s.noteChanges(['z.ts']);
    const r4 = s.request({ reason: 'x' });
    await until(() => calls.length === 4);
    expect(calls[3]!.input.incremental?.changedPaths).toEqual(['z.ts']);
    calls[3]!.release();
    await r4;

    s.resetBaseline();
    const r5 = s.request({ reason: 'x', paths: ['q'] });
    await until(() => calls.length === 5);
    expect(calls[4]!.input.incremental).toBeUndefined();
    calls[4]!.release();
    await r5;
    const r6 = s.request({ reason: 'x', full: true });
    await until(() => calls.length === 6);
    expect(calls[5]!.input.incremental).toBeUndefined();
    calls[5]!.release();
    await r6;
  });

  it('a superseding request aborts a stale in-flight plan; its waiters get the fresh plan', async () => {
    const { planner, calls } = controlledPlanner();
    const s = new AnalysisScheduler('/p', { planner });
    s.setTracking(true);
    const stale = s.request({ reason: 'watch', paths: ['a.ts'] });
    await until(() => calls.length === 1);
    const fresh = s.request({ reason: 'watch', paths: ['b.ts'], supersede: true });
    expect(calls[0]!.input.signal.aborted).toBe(true);
    await until(() => calls.length === 2);
    // The aborted run's paths are carried into the follow-up.
    expect(calls[1]!.input.incremental).toBeUndefined(); // no baseline yet: full walk
    calls[1]!.release();
    expect((await stale).id).toBe('plan-2');
    expect((await fresh).id).toBe('plan-2');
    expect(s.stats.aborted).toBe(1);
  });

  it('a watcher request supersedes on changes noted since the run started, not on an empty poke', async () => {
    const { planner, calls } = controlledPlanner();
    const s = new AnalysisScheduler('/p', { planner });
    s.setTracking(true);
    const r1 = s.request({ reason: 'watch' });
    await until(() => calls.length === 1);
    const poke = s.request({ reason: 'watch', supersede: true }); // nothing new: must not abort
    expect(calls[0]!.input.signal.aborted).toBe(false);
    s.noteChanges(['a.ts']); // watcher event, then the debounced request
    const r2 = s.request({ reason: 'watch', supersede: true });
    expect(calls[0]!.input.signal.aborted).toBe(true);
    await until(() => calls.length === 2);
    calls[1]!.release();
    expect(new Set([(await r1).id, (await poke).id, (await r2).id])).toEqual(new Set(['plan-2']));
  });

  it('never aborts more than maxConsecutiveAborts runs in a row', async () => {
    const { planner, calls } = controlledPlanner();
    const s = new AnalysisScheduler('/p', { planner, maxConsecutiveAborts: 1 });
    const p1 = s.request({ reason: 'w', paths: ['a'], supersede: true });
    await until(() => calls.length === 1);
    const p2 = s.request({ reason: 'w', paths: ['b'], supersede: true }); // aborts run 1
    await until(() => calls.length === 2);
    const p3 = s.request({ reason: 'w', paths: ['c'], supersede: true }); // must not abort run 2
    expect(calls[1]!.input.signal.aborted).toBe(false);
    calls[1]!.release();
    expect((await p1).id).toBe('plan-2');
    expect((await p2).id).toBe('plan-2');
    await until(() => calls.length === 3);
    calls[2]!.release();
    expect((await p3).id).toBe('plan-3');
  });

  it('carries the paths of a failed run into the next one and rejects every waiter of the failed run', async () => {
    const { planner, calls } = controlledPlanner();
    const s = new AnalysisScheduler('/p', { planner });
    s.setTracking(true);
    const r0 = s.request({ reason: 'w' });
    await until(() => calls.length === 1);
    calls[0]!.release();
    await r0;

    const a = s.request({ reason: 'w', paths: ['x.ts'] });
    await until(() => calls.length === 2);
    calls[1]!.release(false);
    await expect(a).rejects.toThrow('run 2 failed');

    // Several waiters on one run all see the error.
    const b = s.request({ reason: 'w', paths: ['y.ts'] });
    await until(() => calls.length === 3);
    expect([...calls[2]!.input.incremental!.changedPaths].sort()).toEqual(['x.ts', 'y.ts']);
    const c = s.request({ reason: 'w' });
    const d = s.request({ reason: 'w' });
    calls[2]!.release(false);
    await expect(b).rejects.toThrow('run 3 failed');
    await until(() => calls.length === 4);
    calls[3]!.release(false);
    await expect(c).rejects.toThrow('run 4 failed');
    await expect(d).rejects.toThrow('run 4 failed');
  });

  it('propagates onPlan errors and runs exclusive work between plans', async () => {
    const { planner, calls } = controlledPlanner();
    const s = new AnalysisScheduler('/p', { planner });
    const order: string[] = [];
    s.hooks.onPlan = async (plan) => {
      order.push(`onPlan ${plan.id}`);
      if (plan.id === 'plan-1') throw new Error('refresh failed');
    };
    const r1 = s.request({ reason: 'a' });
    await until(() => calls.length === 1);
    const ex = s.exclusive(async () => {
      order.push('exclusive');
    });
    const r2 = s.request({ reason: 'b' });
    calls[0]!.release();
    await expect(r1).rejects.toThrow('refresh failed');
    await ex;
    await until(() => calls.length === 2);
    calls[1]!.release();
    await r2;
    expect(order).toEqual(['onPlan plan-1', 'exclusive', 'onPlan plan-2']);
  });

  it('close() rejects pending requests', async () => {
    const { planner, calls } = controlledPlanner();
    const s = new AnalysisScheduler('/p', { planner });
    const a = s.request({ reason: 'a' });
    await until(() => calls.length === 1);
    const b = s.request({ reason: 'b' });
    s.close();
    await expect(a).rejects.toThrow(/cancelled/);
    await expect(b).rejects.toThrow(/cancelled/);
    await expect(s.request({ reason: 'c' })).rejects.toThrow(/cancelled/);
  });
});
