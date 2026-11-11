import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';

// 실행 폴더: 한 번의 평가(답 → 심판 → 보고)가 남기는 파일 전부. 단계마다 자기 파일에만 붙여 쓴다.
// 같은 폴더를 두 프로세스가 동시에 쓰면 예산 장부가 둘로 갈라져 상한을 두 번 쓰게 된다 — 그래서 호출하는 단계는 잠금을 잡는다.

export const RUN_FILES = {
  info: 'run.json',
  calls: 'calls.jsonl',
  answers: 'answers.jsonl',
  judgments: 'judgments.jsonl',
  judgeCheck: 'judge-check.jsonl',
  errors: 'errors.jsonl',
  summary: 'summary.json',
  report: 'report.md',
  labelsInput: 'labels-input.json',
  labels: 'labels.json',
  agreement: 'agreement.md',
  lock: 'run.lock',
} as const;
export type RunFile = keyof typeof RUN_FILES;

function errnoOf(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errnoOf(err) === 'EPERM';
  }
}

export class RunDir {
  private readonly tailChecked = new Set<string>();

  constructor(readonly path: string) {
    mkdirSync(path, { recursive: true });
  }

  file(name: RunFile): string {
    return join(this.path, RUN_FILES[name]);
  }

  exists(name: RunFile): boolean {
    return existsSync(this.file(name));
  }

  /**
   * 줄마다 JSON 하나. JSON으로 읽히지 않는 줄은 쓰다가 멈춘 흔적이라 건너뛰고 수만 센다.
   * JSON인데 스키마와 다르면 던진다 — 코드와 기록이 어긋났다는 뜻이고, 조용히 버리면 집계가 틀린다.
   */
  readJsonl<S extends z.ZodType>(name: RunFile, schema: S): { rows: z.infer<S>[]; skipped: number } {
    const path = this.file(name);
    if (!existsSync(path)) return { rows: [], skipped: 0 };
    const rows: z.infer<S>[] = [];
    let skipped = 0;
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (line.trim() === '') return;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          skipped += 1;
          return;
        }
        const parsed = schema.safeParse(value);
        if (!parsed.success) throw new Error(`${path}:${i + 1} 모양이 맞지 않음 — ${parsed.error.message}`);
        rows.push(parsed.data);
      });
    return { rows, skipped };
  }

  appendJsonl(name: RunFile, row: unknown): void {
    const path = this.file(name);
    // 쓰다가 멈춘 줄 뒤에 바로 붙이면 다음 줄까지 망가진다. 프로세스마다 처음 한 번 끝이 줄바꿈인지 본다.
    if (!this.tailChecked.has(path)) {
      this.tailChecked.add(path);
      if (existsSync(path) && statSync(path).size > 0 && !readFileSync(path, 'utf8').endsWith('\n')) appendFileSync(path, '\n');
    }
    appendFileSync(path, `${JSON.stringify(row)}\n`);
  }

  readJson(name: RunFile): unknown {
    const path = this.file(name);
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : null;
  }

  /** 임시 파일에 쓰고 이름을 바꾼다 — 읽는 쪽이 반쯤 쓴 보고서를 보지 않게. */
  writeAtomic(name: RunFile, text: string): string {
    const path = this.file(name);
    writeFileSync(`${path}.tmp`, text);
    renameSync(`${path}.tmp`, path);
    return path;
  }

  /** 없을 때만 쓴다. 썼으면 true. run.json은 폴더가 생길 때 한 번만 쓴다. */
  writeOnce(name: RunFile, text: string): boolean {
    try {
      writeFileSync(this.file(name), text, { flag: 'wx' });
      return true;
    } catch (err) {
      if (errnoOf(err) === 'EEXIST') return false;
      throw err;
    }
  }

  /** 호출하는 단계의 잠금. 죽은 프로세스가 남긴 잠금은 pid로 알아보고 넘겨받는다. 돌려준 함수로 푼다. */
  lock(): () => void {
    const path = this.file('lock');
    for (let tries = 0; tries < 2; tries += 1) {
      try {
        writeFileSync(path, String(process.pid), { flag: 'wx' });
        return () => {
          if (existsSync(path)) unlinkSync(path);
        };
      } catch (err) {
        if (errnoOf(err) !== 'EEXIST') throw err;
        const holder = Number(readFileSync(path, 'utf8').trim());
        if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) {
          throw new Error(`다른 프로세스(pid ${holder})가 이 실행 폴더를 쓰는 중이다: ${this.path}`);
        }
        unlinkSync(path);
      }
    }
    throw new Error(`잠금을 잡지 못했다: ${path}`);
  }
}
