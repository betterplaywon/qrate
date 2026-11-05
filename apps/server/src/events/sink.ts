import type { ErrorReporter } from '../report.js';
import type { AppEvent, EventRepository } from '../repo/types.js';

/**
 * 사건 기록의 유일한 통로. 반환이 void라 호출자는 기다릴 수 없고 저장 실패를 처리할 책임도 없다 —
 * 응답 경로가 분석용 쓰기를 기다리지 않고, 호출자가 catch를 잊어 unhandled rejection으로 프로세스가 죽는 길이 없다.
 * 테스트는 AppOptions.recordEvent로 바꿔 끼운다(동기 배열 push라 응답 직후 읽어도 결정적).
 */
export type EventSink = (event: AppEvent) => void;

export interface EventSinkOptions {
  repo: Pick<EventRepository, 'record'>;
  reportError: ErrorReporter;
  /** stdout에 사건 JSON 한 줄. index.ts가 NODE_ENV !== 'production'일 때 켠다 — verify·E2E 서버는 NODE_ENV 없이 뜨고 이 줄을 증거로 읽는다. */
  echo?: boolean;
}

export function createEventSink({ repo, reportError, echo = false }: EventSinkOptions): EventSink {
  return (event) => {
    if (echo) console.log(JSON.stringify(event));
    repo.record(event).catch((err: unknown) => {
      reportError(err, { where: 'events', type: event.type, tenantId: event.tenantId });
    });
  };
}
