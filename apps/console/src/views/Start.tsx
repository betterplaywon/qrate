import type { ConsoleTenant, InstallStatusResponse } from '@qrate/contracts';
import type { ReactNode } from 'react';
import { QueryBoundary } from '../components/QueryBoundary';
import { MIN_FAQ_FOR_START, setupProgress } from '../install';
import { formatTime } from '../labels';
import { useInstall, useKnowledge } from '../queries';
import { href } from '../route';

// 시작하기. 회사 담당자가 개발자 없이 위젯을 켜는 네 단계(주소 등록 → FAQ → 한 줄 붙이기 → 설치 확인)와 지금 할 일.
// 네 단계가 끝나기 전에는 해시가 빈 첫 화면이 이 화면이다(queries.ts useLanding).

interface StepProps {
  n: number;
  title: string;
  state: 'done' | 'now' | 'later';
  badge?: string;
  children: ReactNode;
}

function Step({ n, title, state, badge, children }: StepProps) {
  return (
    <li className={`start-step ${state}`} data-testid={`start-step-${n}`}>
      <span className="start-step-number" aria-hidden="true">
        {n}
      </span>
      <div className="start-step-body">
        <div className="start-step-head">
          <h3>{title}</h3>
          {state === 'done' && <span className="pill status-done">{badge ?? '끝'}</span>}
          {state === 'now' && <span className="pill status-open">지금 할 일</span>}
        </div>
        {children}
      </div>
    </li>
  );
}

function Steps({ install, faqCount }: { install: InstallStatusResponse; faqCount: number }) {
  const progress = setupProgress(install, faqCount);
  const order = [progress.origins, progress.faq, progress.verified, progress.verified];
  const now = order.findIndex((done) => !done);
  const state = (i: number): StepProps['state'] => (order[i] ? 'done' : i === now ? 'now' : 'later');

  return (
    <>
      <div className="start-progress">
        <strong data-testid="start-progress">4단계 중 {progress.doneCount}단계 끝</strong>
        <progress max={4} value={progress.doneCount} aria-label={`4단계 중 ${progress.doneCount}단계 끝`} />
      </div>
      <ol className="start-steps">
        <Step n={1} title="홈페이지 주소 등록" state={state(0)}>
          <p>위젯은 등록한 주소의 홈페이지에서만 열려요. 다른 사이트가 우리 위젯을 몰래 가져다 쓰지 못하게 하는 장치예요.</p>
          {install.allowedOrigins.length > 0 && <p className="muted">{install.allowedOrigins.join(' · ')}</p>}
          <a href={href.install()}>{progress.origins ? '주소 고치기' : '주소 등록하기'}</a>
        </Step>
        <Step n={2} title="FAQ 쓰기" state={state(1)} badge={`끝 · ${faqCount}개`}>
          <p>위젯은 FAQ에 쓴 내용으로만 답해요. 방문객이 자주 묻는 것부터 {MIN_FAQ_FOR_START}개 이상 써 주세요.</p>
          {!progress.faq && <p className="muted">지금 {faqCount}개</p>}
          <a href={href.faq()}>FAQ 보러 가기</a>
        </Step>
        <Step n={3} title="홈페이지에 한 줄 붙이기" state={state(2)}>
          <p>홈페이지 관리 화면의 코드 넣는 칸에 한 줄을 붙여 넣어요. 카페24, 아임웹, 워드프레스는 화면별 순서를 안내해 드려요.</p>
          <a href={href.install()}>설치 안내 열기</a>
        </Step>
        <Step n={4} title="설치 확인" state={state(3)} badge="설치됨">
          {install.lastOpenedAt ? (
            <p data-testid="start-verified">{formatTime(install.lastOpenedAt)}에 홈페이지에서 위젯이 열렸어요.</p>
          ) : (
            <p>홈페이지에서 위젯이 한 번 열리면 여기에 "설치됨"이 떠요. 직접 홈페이지에 들어가 오른쪽 아래 버튼을 눌러 보세요.</p>
          )}
        </Step>
      </ol>
      <p className="muted">
        {progress.done
          ? '시작을 마쳤어요. 이제 첫 화면은 미응답 큐예요. 이 안내는 메뉴의 "시작하기"에서 다시 볼 수 있어요.'
          : '네 단계를 마치면 첫 화면이 미응답 큐로 바뀌어요.'}
      </p>
    </>
  );
}

export function Start({ tenant }: { tenant: ConsoleTenant }) {
  const install = useInstall();
  const knowledge = useKnowledge();

  return (
    <section className="start">
      <div className="page-intro">
        <h2>{tenant.name} 위젯을 시작해요</h2>
        <p className="muted">네 가지만 하면 홈페이지 방문객이 위젯에 묻고 바로 답을 받을 수 있어요. 개발자 없이 이 화면에서 끝낼 수 있어요.</p>
      </div>
      <QueryBoundary
        pending={install.isPending || knowledge.isPending}
        error={(install.isError || knowledge.isError) && '시작 상태를 불러오지 못했어요.'}
      >
        {install.data && knowledge.data && <Steps install={install.data} faqCount={knowledge.data.items.length} />}
      </QueryBoundary>
    </section>
  );
}
