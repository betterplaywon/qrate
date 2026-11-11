import { readFileSync } from 'node:fs';
import { z } from 'zod';

const profileSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.number(),
      callFrame: z.object({ functionName: z.string(), url: z.string() }),
    }),
  ),
  samples: z.array(z.number()),
  timeDeltas: z.array(z.number()),
});

export function groupOf(functionName: string, url: string): string {
  if (!url) {
    if (functionName === '(idle)') return '(idle)';
    if (functionName === '(garbage collector)') return 'GC';
    if (functionName === '(program)') return '(program) 엔진·네이티브';
    return `(native) ${functionName}`;
  }
  const pkg = /node_modules\/\.pnpm\/([^/]+)\//.exec(url)?.[1];
  if (pkg) return `pkg ${pkg.replace(/^@/, '').replace(/@\d.*$/, '').replace('+', '/')}`;
  if (url.startsWith('wasm://')) return 'wasm';
  if (url.startsWith('node:internal/')) return `node ${(url.slice('node:internal/'.length).split('/')[0] ?? '').replace(/\.js$/, '')}`;
  if (url.startsWith('node:')) return `node ${url.slice('node:'.length)}`;
  const own = /(apps\/server\/[^?]+|packages\/[^?]+)$/.exec(url)?.[1];
  return own ? `app ${own.replace(/\.ts$/, '')}` : `other ${url}`;
}

export interface GroupShare {
  group: string;
  ms: number;
  share: number;
}

export function groupProfile(raw: unknown): { busyMs: number; idleMs: number; groups: GroupShare[] } {
  const profile = profileSchema.parse(raw);
  const frames = new Map(profile.nodes.map((n) => [n.id, n.callFrame]));
  const byGroup = new Map<string, number>();
  let busyUs = 0;
  let idleUs = 0;
  profile.samples.forEach((id, i) => {
    const frame = frames.get(id);
    const dt = profile.timeDeltas[i] ?? 0;
    if (!frame) return;
    const group = groupOf(frame.functionName, frame.url);
    if (group === '(idle)') {
      idleUs += dt;
      return;
    }
    busyUs += dt;
    byGroup.set(group, (byGroup.get(group) ?? 0) + dt);
  });
  const groups = [...byGroup]
    .map(([group, us]) => ({ group, ms: Math.round(us / 1000), share: busyUs === 0 ? 0 : Number(((us / busyUs) * 100).toFixed(1)) }))
    .sort((a, b) => b.ms - a.ms);
  return { busyMs: Math.round(busyUs / 1000), idleMs: Math.round(idleUs / 1000), groups };
}

if (process.argv[1]?.endsWith('profile.ts')) {
  const [file, top = '25'] = process.argv.slice(2);
  if (!file) throw new Error('사용: tsx load/profile.ts <server.cpuprofile> [줄 수]');
  const { busyMs, idleMs, groups } = groupProfile(JSON.parse(readFileSync(file, 'utf8')));
  console.log(`바쁨 ${(busyMs / 1000).toFixed(1)}초, 쉼 ${(idleMs / 1000).toFixed(1)}초`);
  console.log('| 묶음 | 자체 시간 (초) | 바쁜 시간 중 % |');
  console.log('| --- | --- | --- |');
  for (const g of groups.slice(0, Number(top))) console.log(`| ${g.group} | ${(g.ms / 1000).toFixed(2)} | ${g.share} |`);
}
