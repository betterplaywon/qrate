import { METRICS_WINDOW_DAYS, type ConsoleMetricsResponse } from '@qrate/contracts';
import { QueryBoundary } from '../components/QueryBoundary';
import { formatMs, formatRate, formatTime } from '../labels';
import { useMetrics } from '../queries';

// 지표 — 정의서의 성공 지표(첫 응답 시간 p50·p95, 자동 해결률)와 위젯 열림 수. 정의는 서버(events/metrics.ts) 한 곳에 있고,
// 화면은 값과 그 정의 한 줄만 그린다. 위젯 열림은 방문자 브라우저가 보고한 수라 카드로 세우지 않고 한 줄로 둔다.

function Cards({ metrics: { window, ttft, autoResolution, widget } }: { metrics: ConsoleMetricsResponse }) {
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
            표본 <span data-testid="metric-ttft-samples">{ttft.samples}</span>건 · 질문을 받은 때부터 첫 답변 조각을 보낼 때까지,
            조각을 보낸 요청만
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
        </article>
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
