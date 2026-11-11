import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { z } from 'zod';

// 프로세스별 값은 ps의 누적 CPU 시간 차이로 센다(ps의 %cpu는 감쇠 평균이라 1초 단위에 맞지 않는다).

/** allCoresPct는 모든 코어 기준 %(100이 최대), 나머지는 코어 하나 기준 %(200이면 코어 두 개분). */
export const cpuSampleSchema = z.object({
  t: z.number(),
  allCoresPct: z.number(),
  serverPct: z.number(),
  k6Pct: z.number(),
  /** Docker의 Linux VM(Postgres가 그 안에서 돈다). */
  dbVmPct: z.number(),
  /** Docker Desktop 백엔드(호스트 포트 5432를 VM으로 넘기는 프록시 포함). */
  dockerPct: z.number(),
});
export type CpuSample = z.infer<typeof cpuSampleSchema>;

type Group = 'serverPct' | 'k6Pct' | 'dbVmPct' | 'dockerPct';

/** ps의 누적 CPU 시간("[dd-][hh:]mm:ss.ss", macOS는 분이 60을 넘어도 그대로 쓴다) → 초. */
export function parsePsTime(raw: string): number {
  const [days, rest] = raw.includes('-') ? raw.split('-') : ['0', raw];
  const parts = (rest ?? '').split(':').map(Number);
  const seconds = parts.reduce((acc, part) => acc * 60 + part, 0);
  return Number(days) * 86_400 + seconds;
}

function groupOf(pid: number, command: string, serverPid: number): Group | null {
  if (pid === serverPid) return 'serverPct';
  if (command === 'k6' || command.endsWith('/k6')) return 'k6Pct';
  if (command.includes('Virtualization.VirtualMachine')) return 'dbVmPct';
  if (command.includes('com.docker.backend')) return 'dockerPct';
  return null;
}

function processTimes(serverPid: number): Record<Group, number> {
  const totals: Record<Group, number> = { serverPct: 0, k6Pct: 0, dbVmPct: 0, dockerPct: 0 };
  const out = spawnSync('ps', ['-Ao', 'pid=,time=,comm='], { encoding: 'utf8' }).stdout;
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!m?.[1] || !m[2] || !m[3]) continue;
    const group = groupOf(Number(m[1]), m[3].trim(), serverPid);
    if (group) totals[group] += parsePsTime(m[2]);
  }
  return totals;
}

function machineTimes(): { busy: number; total: number } {
  let busy = 0;
  let total = 0;
  for (const { times } of os.cpus()) {
    const all = times.user + times.nice + times.sys + times.idle + times.irq;
    total += all;
    busy += all - times.idle;
  }
  return { busy, total };
}

export function sampleCpu(serverPid: number, onSample: (sample: CpuSample) => void): () => void {
  let lastProc = processTimes(serverPid);
  let lastMachine = machineTimes();
  let lastAt = performance.now();
  const timer = setInterval(() => {
    const proc = processTimes(serverPid);
    const machine = machineTimes();
    const now = performance.now();
    const elapsedS = (now - lastAt) / 1000;
    const pct = (group: Group): number => Number((((proc[group] - lastProc[group]) / elapsedS) * 100).toFixed(1));
    const machineTotal = machine.total - lastMachine.total;
    onSample({
      t: Date.now(),
      allCoresPct: machineTotal > 0 ? Number((((machine.busy - lastMachine.busy) / machineTotal) * 100).toFixed(1)) : 0,
      serverPct: pct('serverPct'),
      k6Pct: pct('k6Pct'),
      dbVmPct: pct('dbVmPct'),
      dockerPct: pct('dockerPct'),
    });
    lastProc = proc;
    lastMachine = machine;
    lastAt = now;
  }, 1000);
  return () => clearInterval(timer);
}
