import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Case } from '../../eval/cases.js';
import type { Variant } from '../../eval/models.js';
import { answerKey, type AnswerRecord } from '../../eval/records.js';
import { RunDir } from '../../eval/run-dir.js';

// 평가 도구 시험의 재료. 실제 시험지(cases.json)의 id·그룹에 기대지 않도록 사례는 여기서 만든다.

export function makeCase(id: string, over: { group?: string; message?: string; history?: Case['history']; expect?: Partial<Case['expect']> } = {}): Case {
  return {
    id,
    group: over.group ?? '그룹',
    source: 'draft',
    tags: [],
    message: over.message ?? '질문입니다',
    history: over.history ?? [],
    expect: { handoff: null, cites: [], mustInclude: [], judge: '기대 설명', ...over.expect },
  };
}

export function makeAnswer(variant: Variant, caseId: string, rep: number, over: Partial<AnswerRecord> = {}): AnswerRecord {
  return {
    key: answerKey(variant, caseId, rep),
    variant,
    caseId,
    rep,
    model: 'claude-sonnet-5-5',
    status: 'ok',
    text: '답입니다',
    citations: [],
    handoff: null,
    stopReason: 'end_turn',
    servedBy: 'claude-sonnet-5-5',
    fallbackUsed: false,
    usage: { inputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 1000, outputTokens: 50 },
    ttftMs: 100,
    durationMs: 1000,
    attempts: 1,
    at: '2026-11-11T00:00:00.000Z',
    ...over,
  };
}

/** 임시 실행 폴더. 시험이 끝나면 cleanup으로 지운다. */
export function tempRun(): { run: RunDir; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'qrate-eval-'));
  return { run: new RunDir(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
