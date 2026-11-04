import type { HandoffDto } from '@qrate/contracts';
import type { ReactNode } from 'react';
import { REASON_LABEL, SOURCE_LABEL, formatTime } from '../labels';
import { StatusButtons } from './StatusButtons';

// 상담원 연결 요청 한 건의 카드 — 출처·사유·시각, 요약(또는 방문자 메모), 연락처, 상태 버튼. 큐와 대화 상세가 같은 카드를 쓴다.
// footer는 큐에서만 쓰는 "대화 보기" 링크 자리다.

export function HandoffCard({ item, footer, testId }: { item: HandoffDto; footer?: ReactNode; testId?: string }) {
  return (
    <li className="row" data-testid={testId}>
      <div className="row-main">
        <div className="row-top">
          <span className={`badge source-${item.source}`}>{SOURCE_LABEL[item.source]}</span>
          <span className="badge">{REASON_LABEL[item.reason]}</span>
          <time className="muted" dateTime={item.createdAt}>
            {formatTime(item.createdAt)}
          </time>
        </div>
        {item.summary && <p className="summary">{item.summary}</p>}
        {item.contact && (
          <p className="contact">
            연락처 <code>{item.contact}</code>
          </p>
        )}
        {footer}
      </div>
      <StatusButtons item={item} />
    </li>
  );
}
