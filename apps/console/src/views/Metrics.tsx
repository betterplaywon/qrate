import { METRICS_WINDOW_DAYS, type ConsoleMetricsResponse } from '@qrate/contracts';
import { QueryBoundary } from '../components/QueryBoundary';
import { formatMs, formatRate, formatTime } from '../labels';
import { useMetrics } from '../queries';

// 지표 — 정의서의 성공 지표(첫 응답 시간 p50·p95, 자동 해결률)와 위젯 열림 수. 정의는 서버(events/metrics.ts) 한 곳에 있고,
// 화면은 값과 그 정의 한 줄만 그린다. 해결률에서 뺀 대화(질문 없이 바로 상담원 연결)는 숨기지 않고 정의 아래 한 줄로 센다.
// 위젯 열림은 방문자 브라우저가 보고한 수라 카드로 세우지 않고 한 줄로 둔다.
// 인사말 A/B는 변형별 노출 → 첫 질문을 표 하나로 그린다. 작은 표본은 숫자로 드러낸다(비율 옆에 늘 첫 질문/노출, 임의의 표본 문턱 없음).
// 비율에서 뺀 사건(실험 밖)은 숨기지 않고 한 줄로 센다.

function GreetingCard({ greeting: { variants, outside } }: { greeting: NonNullable<ConsoleMetricsResponse['greeting']> }) {
  return (
    <article className="metric metric-wide" data-testid="metric-greeting">
      <h3>인사말 A/B</h3>
      <table className="greeting-table">
        <thead>
          <tr>
            <th scope="col">인사말</th>
            <th scope="col">노출</th>
            <th scope="col">첫 질문</th>
            <th scope="col">전환율</th>
          </tr>
        </thead>
        <tbody>
          {variants.map((v) => (
            <tr key={v.id} data-testid={`metric-greeting-${v.id}`}>
              <th scope="row">
                {v.label}
                <span className="greeting-text">{v.text}</span>
              </th>
              <td data-testid={`metric-greeting-exposures-${v.id}`}>{v.exposures}</td>
              <td data-testid={`metric-greeting-first-questions-${v.id}`}>{v.firstQuestions}</td>
              <td>
                <span data-testid={`metric-greeting-rate-${v.id}`}>{formatRate(v.rate)}</span>
                <span className="muted">
                  {' '}
                  ({v.firstQuestions}/{v.exposures})
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="metric-def">
        방문자 브라우저 보고 · 노출 = 인사말이 보인 페이지 로드의 첫 열림 · 첫 질문 = 그 페이지 로드의 첫 질문 · 유의성 검정 없음
      </p>
      <p className="metric-def">
        실험 밖 열림 <span data-testid="metric-greeting-outside-opens">{outside.opens}</span>회 · 첫 질문{' '}
        <span data-testid="metric-greeting-outside-questions">{outside.questions}</span>회 · 위 비율에는 넣지 않음
      </p>
    </article>
  );
}

function Cards({ metrics: { window, ttft, autoResolution, widget, greeting } }: { metrics: ConsoleMetricsResponse }) {
  return (
    <>
      <p className="muted metrics-window" data-testid="metrics-window">
        최근 {METRICS_WINDOW_DAYS}일 · {formatTime(window.from)} ~ {formatTime(window.to)}
      </p>
      <div className="metrics">
        <article className="metric" data-testid="metric-ttft">
          <h3>첫 응답 시간</h3>
          {ttft.samples === 0 ? (
            <p className="metric-empty" data-testid="metric-ttft-empty">
              아직 표본이 없어요.
            </p>
          ) : (
            <dl className="metric-values">
              <div>
                <dt>p50</dt>
                <dd data-testid="metric-ttft-p50">{formatMs(ttft.p50Ms)}</dd>
              </div>
              <div>
                <dt>p95</dt>
                <dd data-testid="metric-ttft-p95">{formatMs(ttft.p95Ms)}</dd>
              </div>
            </dl>
          )}
          <p className="metric-def">
            표본 <span data-testid="metric-ttft-samples">{ttft.samples}</span>건 · 질문을 받은 때부터 공백이 아닌 첫 답변 조각을 보낼
            때까지, 그런 조각을 보낸 요청만
          </p>
        </article>
        <article className="metric" data-testid="metric-resolution">
          <h3>자동 해결률</h3>
          {autoResolution.conversations === 0 ? (
            <p className="metric-empty" data-testid="metric-resolution-empty">
              아직 대화가 없어요.
            </p>
          ) : (
            <p className="metric-value" data-testid="metric-resolution-rate">
              {formatRate(autoResolution.rate)}
            </p>
          )}
          <p className="metric-def">
            <span data-testid="metric-resolution-resolved">{autoResolution.resolved}</span>/
            <span data-testid="metric-resolution-conversations">{autoResolution.conversations}</span>건 · 기간 안에 시작해 질문이 있었던 대화 중
            답이 있고 상담원 연결 요청이 없는 대화
          </p>
          <p className="metric-def">
            질문 없이 바로 상담원 연결 <span data-testid="metric-resolution-handoff-only">{autoResolution.handoffOnly}</span>건 · 위 비율에는 넣지
            않음
          </p>
        </article>
        {greeting && <GreetingCard greeting={greeting} />}
      </div>
      <p className="metric-line">
        위젯 열림 <strong data-testid="metric-widget-opens">{widget.opens}</strong>회
        <span className="muted"> · 방문자 브라우저 보고 · 페이지 로드당 첫 열림</span>
      </p>
    </>
  );
}

export function Metrics() {
  const metrics = useMetrics();
  return (
    <section>
      <div className="section-head">
        <h2>지표</h2>
      </div>
      <QueryBoundary pending={metrics.isPending} error={metrics.isError && '지표를 불러오지 못했어요.'}>
        {metrics.data && <Cards metrics={metrics.data} />}
      </QueryBoundary>
    </section>
  );
}
