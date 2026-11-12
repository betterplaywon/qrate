import { KNOWLEDGE_LIMITS, type KnowledgeItemDto } from '@qrate/contracts';
import { useState } from 'react';
import { QueryBoundary } from '../components/QueryBoundary';
import { UNSUPPORTED_ID, groupByCategory, matchesQuery } from '../faq';
import { useKnowledge } from '../queries';
import { href, type FaqNotice } from '../route';

// FAQ 목록. 분류별 질문, 찾기, 개수 막대, "지원하지 않는 것" 상자가 있다.
// 위젯은 질문마다 FAQ 전체를 읽고 답한다(ADR-0004). 그래서 개수를 늘 보여 주고, 권장 개수를 넘으면 느려지고 비용이 는다고 알린다.

const { recommendedItems, items: maxItems } = KNOWLEDGE_LIMITS;

function CountMeter({ count }: { count: number }) {
  const hint =
    count >= maxItems
      ? `FAQ는 ${maxItems}개까지예요. 질문을 더 넣으려면 안 쓰는 질문을 지워 주세요.`
      : count > recommendedItems
        ? '권장 개수를 넘었어요. 위젯은 질문마다 FAQ 전체를 읽어서 답이 느려지고 비용이 늘어요. 비슷한 질문은 하나로 합쳐 보세요.'
        : `위젯은 질문마다 FAQ 전체를 읽고 답해요. ${recommendedItems}개를 넘으면 답이 느려지고 비용이 늘어서 알려 드려요.`;
  return (
    <div className={count > recommendedItems ? 'faq-meter over' : 'faq-meter'}>
      <div className="faq-meter-count">
        <div className="faq-meter-label">
          <strong data-testid="faq-count">{count}개</strong>
          <span className="muted">권장 {recommendedItems}개까지</span>
        </div>
        <progress max={recommendedItems} value={Math.min(count, recommendedItems)} aria-label={`FAQ ${count}개, 권장 ${recommendedItems}개`} />
      </div>
      <p className="faq-meter-hint">{hint}</p>
    </div>
  );
}

function Unsupported({ item }: { item: KnowledgeItemDto | undefined }) {
  return (
    <section className="faq-unsupported" data-testid="faq-unsupported">
      <div className="faq-unsupported-head">
        <h3>지원하지 않는 것</h3>
        {item && <span>{item.blocks.length}개</span>}
      </div>
      <p>
        지원하지 않는 기능을 여기 적어 두면 위젯이 "지원하지 않아요"라고 분명하게 답해요. 회사에 관한 질문인데 FAQ 어디에도 없으면 짐작해서 답하지
        않고 상담원에게 넘겨요.
      </p>
      {item ? (
        <ul>
          {item.blocks.map((block, i) => (
            <li key={`${i}:${block}`}>{block}</li>
          ))}
        </ul>
      ) : (
        <p>아직 적은 것이 없어요.</p>
      )}
      <a href={href.faqItem(UNSUPPORTED_ID)}>{item ? '고치기' : '적기'}</a>
    </section>
  );
}

function FaqItems({ items, notice }: { items: KnowledgeItemDto[]; notice: FaqNotice | null }) {
  const [query, setQuery] = useState('');
  const groups = groupByCategory(items.filter((k) => matchesQuery(k, query)));
  const savedId = notice?.kind === 'saved' ? notice.id : null;

  return (
    <>
      <CountMeter count={items.length} />
      <label className="faq-search">
        <span className="muted">찾기</span>
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="질문이나 답의 낱말로 찾기" />
      </label>
      {groups.length === 0 && (
        <p className="status" data-testid="faq-empty">
          {query.trim() ? '찾는 낱말이 들어간 질문이 없어요.' : '아직 질문이 없어요. 방문객이 자주 묻는 질문부터 추가해 보세요.'}
        </p>
      )}
      {groups.map((group) => (
        <details key={group.category} className="faq-group" open data-testid="faq-group">
          <summary>
            <h3>{group.category}</h3>
            <span className="muted">{group.items.length}개</span>
          </summary>
          <ul className="faq-items">
            {group.items.map((k) => (
              <li key={k.id} className={k.id === savedId ? 'faq-item just-saved' : 'faq-item'} data-testid="faq-item">
                <div className="faq-item-main">
                  <span className="faq-item-title">{k.title}</span>
                  <span className="preview faq-item-preview">{k.blocks[0]}</span>
                </div>
                {k.id === savedId && <span className="badge">방금 저장</span>}
                <span className="muted faq-item-blocks">문단 {k.blocks.length}</span>
                <a className="link-button" href={href.faqItem(k.id)} aria-label={`${k.title} 고치기`}>
                  고치기
                </a>
              </li>
            ))}
          </ul>
        </details>
      ))}
      <Unsupported item={items.find((k) => k.id === UNSUPPORTED_ID)} />
    </>
  );
}

export function FaqList({ notice }: { notice: FaqNotice | null }) {
  const knowledge = useKnowledge();
  const full = (knowledge.data?.items.length ?? 0) >= maxItems;

  return (
    <section className="faq">
      <div className="section-head">
        <div className="page-intro">
          <h2>FAQ</h2>
          <p className="muted">위젯은 여기 있는 내용으로만 답해요. 고치면 바로 다음 질문부터 반영돼요.</p>
        </div>
        {full ? (
          <button type="button" disabled>
            질문 추가
          </button>
        ) : (
          <a className="link-button primary" href={href.faqNew()}>
            질문 추가
          </a>
        )}
      </div>
      {notice && (
        <p className="notice" role="status" data-testid="faq-notice">
          {notice.kind === 'saved' ? '저장했어요. 다음 질문부터 반영돼요.' : '질문을 지웠어요. 다음 질문부터 위젯이 그 내용으로 답하지 않아요.'}
        </p>
      )}
      <QueryBoundary pending={knowledge.isPending} error={knowledge.isError && 'FAQ를 불러오지 못했어요.'}>
        {knowledge.data && <FaqItems items={knowledge.data.items} notice={notice} />}
      </QueryBoundary>
    </section>
  );
}
