import { zodResolver } from '@hookform/resolvers/zod';
import { KNOWLEDGE_LIMITS, type KnowledgeItemDto } from '@qrate/contracts';
import { knowledgeBlockSchema, knowledgeBlocks, knowledgeInputSchema } from '@qrate/contracts/schemas';
import { useState } from 'react';
import { useFieldArray, useForm, useWatch, type Control } from 'react-hook-form';
import { z } from 'zod';
import { QueryBoundary } from '../components/QueryBoundary';
import { UNSUPPORTED_DEFAULTS, UNSUPPORTED_ID, categoriesOf, newKnowledgeId, saveErrorMessage } from '../faq';
import { useDeleteKnowledge, useKnowledge, useSaveKnowledge } from '../queries';
import { href } from '../route';

// FAQ 한 항목 고치기·추가. 폼은 react-hook-form, 검사는 서버와 같은 계약 스키마(@qrate/contracts/schemas)다.
// 옆에는 방문객에게 보이는 출처 모양을 그린다. 답 문장은 위젯이 그때그때 쓰므로 지어내지 않는다.

// useFieldArray는 원소마다 key를 붙이려고 객체 배열을 받는다. 그래서 폼은 문단을 {text}로 들고, 보낼 때 문자열 배열로 편다.
const faqFormSchema = z.object({
  title: knowledgeInputSchema.shape.title,
  category: knowledgeInputSchema.shape.category,
  blocks: knowledgeBlocks(z.object({ text: knowledgeBlockSchema })),
});
type FaqFormValues = z.infer<typeof faqFormSchema>;

/** 고칠 대상. 없는 id는 "지원하지 않는 것"일 때만 새로 만들고, 그 밖에는 찾을 수 없다고 알린다. */
type Target = { id: string; existing: boolean; initial: FaqFormValues } | null;

function resolveTarget(id: string | null, newId: string, items: KnowledgeItemDto[]): Target {
  const found = id === null ? undefined : items.find((k) => k.id === id);
  if (found) {
    return { id: found.id, existing: true, initial: { title: found.title, category: found.category, blocks: found.blocks.map((text) => ({ text })) } };
  }
  if (id === UNSUPPORTED_ID) return { id, existing: false, initial: { ...UNSUPPORTED_DEFAULTS, blocks: [{ text: '' }] } };
  return id === null ? { id: newId, existing: false, initial: { title: '', category: '', blocks: [{ text: '' }] } } : null;
}

function Preview({ control, tenantName }: { control: Control<FaqFormValues>; tenantName: string }) {
  const [title = '', blocks = []] = useWatch({ control, name: ['title', 'blocks'] });
  const shownTitle = title.trim() || '방문객이 묻는 질문';
  const quotes = blocks.map((b) => b.text.trim()).filter(Boolean);
  return (
    <aside className="faq-preview" aria-label="방문객에게 보이는 모습">
      <h3>방문객에게 이렇게 보여요</h3>
      <div className="faq-preview-widget">
        <div className="faq-preview-head">{tenantName} 문의</div>
        <div className="faq-preview-body">
          <p className="faq-preview-question">{shownTitle}</p>
          <div className="faq-preview-answer">
            <p className="muted">위젯이 FAQ를 읽고 답을 써요.</p>
            <div className="faq-preview-sources">
              <span className="muted">출처 1건</span>
              <strong>{shownTitle}</strong>
              <ul>
                {quotes.map((q, i) => (
                  <li key={`${i}:${q}`}>
                    <q>{q}</q>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
      <p className="muted faq-preview-note">예시 모습이에요. 실제 답은 위젯이 FAQ 전체를 읽고 그때그때 써요. 출처에는 답에 쓴 문단만 나와요.</p>
    </aside>
  );
}

function DeleteButton({ id }: { id: string }) {
  const remove = useDeleteKnowledge();
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" className="danger-ghost" onClick={() => setConfirming(true)}>
        이 질문 지우기
      </button>
    );
  }
  return (
    <div className="faq-confirm" role="group" aria-label="지우기 확인">
      <p>이 질문을 지울까요? 다음 질문부터 위젯이 이 내용으로 답하지 않아요. 지운 뒤에는 되돌릴 수 없어요.</p>
      <div className="actions">
        <button
          type="button"
          className="danger"
          disabled={remove.isPending}
          onClick={() =>
            void remove
              .mutateAsync(id)
              .then(() => {
                window.location.hash = href.faq({ kind: 'deleted' });
              })
              .catch(() => undefined)
          }
        >
          {remove.isPending ? '지우는 중…' : '지우기'}
        </button>
        <button type="button" className="ghost" disabled={remove.isPending} onClick={() => setConfirming(false)}>
          그만두기
        </button>
      </div>
      {remove.isError && (
        <p className="error" role="alert">
          지우지 못했어요. 다시 눌러 주세요.
        </p>
      )}
    </div>
  );
}

function FaqForm({ target, categories, tenantName }: { target: NonNullable<Target>; categories: string[]; tenantName: string }) {
  const save = useSaveKnowledge();
  const form = useForm<FaqFormValues>({ resolver: zodResolver(faqFormSchema), defaultValues: target.initial });
  const blocks = useFieldArray({ control: form.control, name: 'blocks' });
  const category = useWatch({ control: form.control, name: 'category' });
  const { errors, isSubmitting } = form.formState;
  const busy = isSubmitting || save.isPending;
  const unsupported = target.id === UNSUPPORTED_ID;
  const serverError = saveErrorMessage(save.error);
  const blocksError = errors.blocks?.message ?? errors.blocks?.root?.message;

  const onSubmit = form.handleSubmit((values) =>
    save
      .mutateAsync({ id: target.id, body: { title: values.title, category: values.category, blocks: values.blocks.map((b) => b.text) } })
      .then(() => {
        window.location.hash = href.faq({ kind: 'saved', id: target.id });
      })
      .catch(() => undefined),
  );

  return (
    <div className="faq-edit">
      <form className="faq-form" onSubmit={onSubmit} noValidate>
        <h2>{unsupported ? '지원하지 않는 것' : target.existing ? '질문 고치기' : '질문 추가'}</h2>
        <label className="field">
          <span className="field-label">방문객이 묻는 질문</span>
          <input id="faq-title" aria-invalid={Boolean(errors.title)} {...form.register('title')} />
          {errors.title ? (
            <span className="error field-error">{errors.title.message}</span>
          ) : (
            <span className="hint">짧은 제목이면 돼요. 방문객에게는 출처 이름으로 보여요.</span>
          )}
        </label>
        <div className="field">
          <label className="field-label" htmlFor="faq-category">
            분류
          </label>
          <input id="faq-category" aria-invalid={Boolean(errors.category)} {...form.register('category')} />
          {categories.length > 0 && (
            <div className="chips" role="group" aria-label="있는 분류">
              {categories.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={c === category.trim() ? 'chip active' : 'chip'}
                  aria-pressed={c === category.trim()}
                  onClick={() => form.setValue('category', c, { shouldDirty: true, shouldValidate: true })}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
          {errors.category ? (
            <span className="error field-error">{errors.category.message}</span>
          ) : (
            <span className="hint">있는 분류를 누르거나 새 분류를 써 주세요. 목록에서 같은 분류끼리 모여요.</span>
          )}
        </div>
        <fieldset className="faq-blocks">
          <legend className="field-label">답</legend>
          {blocks.fields.map((field, i) => (
            <div key={field.id} className="faq-block">
              <div className="faq-block-head">
                <label htmlFor={`faq-block-${i}`} className="muted">
                  문단 {i + 1}
                </label>
                {blocks.fields.length > 1 && (
                  <button type="button" className="small" onClick={() => blocks.remove(i)}>
                    문단 {i + 1} 지우기
                  </button>
                )}
              </div>
              <textarea id={`faq-block-${i}`} rows={3} aria-invalid={Boolean(errors.blocks?.[i]?.text)} {...form.register(`blocks.${i}.text`)} />
              {errors.blocks?.[i]?.text && <span className="error field-error">{errors.blocks[i]?.text?.message}</span>}
            </div>
          ))}
          {blocksError && <span className="error field-error">{blocksError}</span>}
          <button
            type="button"
            className="add-block"
            disabled={blocks.fields.length >= KNOWLEDGE_LIMITS.blocks}
            onClick={() => blocks.append({ text: '' })}
          >
            문단 추가
          </button>
        </fieldset>
        <div className="faq-tips">
          <strong>잘 쓰는 법</strong>
          {unsupported ? (
            <span>지원하지 않는 것 하나를 한 문단에 써 주세요. 예: "휴대폰 앱은 제공하지 않습니다."</span>
          ) : (
            <span>문단 하나가 출처 한 줄이 돼요. 한 문단에 한 가지 사실만 쓰면 위젯이 정확하게 인용해요.</span>
          )}
          <span>시간과 요금 같은 숫자는 다른 질문에 쓴 것과 같은지 확인해 주세요.</span>
        </div>
        {serverError && (
          <p className="error" role="alert">
            {serverError}
          </p>
        )}
        <div className="faq-form-actions">
          <button type="submit" disabled={busy}>
            {busy ? '저장하는 중…' : '저장'}
          </button>
          <a className="link-button" href={href.faq()}>
            취소
          </a>
        </div>
        {target.existing && <DeleteButton id={target.id} />}
      </form>
      <Preview control={form.control} tenantName={tenantName} />
    </div>
  );
}

export function FaqEdit({ id, tenantName }: { id: string | null; tenantName: string }) {
  const knowledge = useKnowledge();
  // 새 질문의 id는 이 화면을 여는 동안 하나다(Shell이 해시마다 이 컴포넌트를 새로 만든다).
  const [newId] = useState(newKnowledgeId);
  const items = knowledge.data?.items ?? [];
  const target = knowledge.data ? resolveTarget(id, newId, items) : null;

  return (
    <section className="faq-page">
      <a className="back" href={href.faq()}>
        ← FAQ 목록으로
      </a>
      <QueryBoundary
        pending={knowledge.isPending}
        error={knowledge.isError && 'FAQ를 불러오지 못했어요.'}
        empty={
          !target && (
            <p className="status" data-testid="faq-missing">
              이 질문을 찾을 수 없어요. 다른 사람이 지웠을 수 있어요.
            </p>
          )
        }
      >
        {target && <FaqForm key={target.id} target={target} categories={categoriesOf(items)} tenantName={tenantName} />}
      </QueryBoundary>
    </section>
  );
}
