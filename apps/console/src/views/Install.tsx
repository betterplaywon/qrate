import { MAX_ALLOWED_ORIGINS, widgetSnippet, type InstallStatusResponse } from '@qrate/contracts';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { QueryBoundary } from '../components/QueryBoundary';
import { BUILDER_GUIDES, OTHER_BUILDER_LINKS, developerNote, toSiteOrigin, type BuilderGuide } from '../install';
import { formatTime } from '../labels';
import { useInstall, useSaveOrigins } from '../queries';

// 설치 안내. 1 홈페이지 주소 등록 → 2 한 줄 복사 → 3 빌더 관리 화면에 붙여 넣기 → 4 설치 확인.
// 주소는 추가·지우기마다 목록 전체를 바로 저장한다(따로 저장 버튼이 없다). 서버는 정규형 오리진만 받으므로 여기서 바꿔서 보낸다.

/** 클립보드 복사. 브라우저가 막으면(권한, http 페이지) 직접 선택해 복사하라고 안내한다. */
function useCopy() {
  const [result, setResult] = useState<'copied' | 'failed' | null>(null);
  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => setResult('copied'),
      () => setResult('failed'),
    );
  return { result, copy };
}

function CopyResult({ result }: { result: 'copied' | 'failed' | null }) {
  if (result === 'copied') return <span className="muted" role="status">복사했어요.</span>;
  if (result === 'failed') return <span className="error" role="status">복사하지 못했어요. 글을 직접 선택해서 복사해 주세요.</span>;
  return null;
}

function Origins({ status }: { status: InstallStatusResponse }) {
  const save = useSaveOrigins();
  const [confirming, setConfirming] = useState<string | null>(null);
  const form = useForm<{ address: string }>({ defaultValues: { address: '' } });
  const address = useWatch({ control: form.control, name: 'address' });
  const preview = toSiteOrigin(address);
  const { errors } = form.formState;
  const full = status.allowedOrigins.length >= MAX_ALLOWED_ORIGINS;

  const onSubmit = form.handleSubmit(({ address: typed }) => {
    const origin = toSiteOrigin(typed);
    if (!origin) return form.setError('address', { message: '주소를 읽을 수 없어요. 예: https://www.example.com' });
    if (status.allowedOrigins.includes(origin)) return form.setError('address', { message: '이미 등록한 주소예요.' });
    return save
      .mutateAsync([...status.allowedOrigins, origin])
      .then(() => form.reset())
      .catch(() => undefined);
  });

  const remove = (origin: string) =>
    save
      .mutateAsync(status.allowedOrigins.filter((o) => o !== origin))
      .then(() => setConfirming(null))
      .catch(() => undefined);

  return (
    <section className="install-step" aria-labelledby="install-origins">
      <h3 id="install-origins">1. 위젯을 띄울 홈페이지 주소</h3>
      <p className="muted">여기 등록한 주소에서만 위젯이 열려요. 다른 사이트가 우리 위젯을 가져다 쓰면 크레딧이 빠지니까 막아 두는 거예요.</p>
      {status.allowedOrigins.length === 0 ? (
        <p className="notice">아직 등록한 주소가 없어요. 주소를 넣기 전에는 어느 홈페이지에서도 위젯이 열리지 않아요.</p>
      ) : (
        <ul className="origin-list" data-testid="origin-list">
          {status.allowedOrigins.map((origin) => (
            <li key={origin} className="origin-item">
              <code>{origin}</code>
              {confirming === origin ? (
                <span className="actions">
                  <span>이 주소에서는 위젯이 열리지 않게 돼요.</span>
                  <button type="button" className="danger small-solid" disabled={save.isPending} onClick={() => void remove(origin)}>
                    지우기
                  </button>
                  <button type="button" className="ghost small-solid" onClick={() => setConfirming(null)}>
                    그만두기
                  </button>
                </span>
              ) : (
                <button type="button" className="small" onClick={() => setConfirming(origin)} aria-label={`${origin} 지우기`}>
                  지우기
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {full ? (
        <p className="muted">주소는 {MAX_ALLOWED_ORIGINS}개까지 등록할 수 있어요. 안 쓰는 주소를 지운 뒤 추가해 주세요.</p>
      ) : (
        <form className="origin-form" onSubmit={onSubmit} noValidate>
          <label className="field">
            <span className="field-label">{status.allowedOrigins.length === 0 ? '홈페이지 주소' : '주소 추가 (예: 쇼핑몰이 따로 있을 때)'}</span>
            <span className="origin-input">
              <input id="origin-address" placeholder="https://www.example.com" aria-invalid={Boolean(errors.address)} {...form.register('address')} />
              <button type="submit" disabled={save.isPending}>
                추가
              </button>
            </span>
            {errors.address ? (
              <span className="error field-error">{errors.address.message}</span>
            ) : (
              <span className="hint">
                {preview && preview !== address.trim()
                  ? `등록될 주소: ${preview}`
                  : '주소창에 보이는 앞부분만 넣어요. https://www.example.com/visit 처럼 뒤에 붙은 경로는 빼도 돼요.'}
              </span>
            )}
          </label>
        </form>
      )}
      {save.isError && (
        <p className="error" role="alert">
          주소를 저장하지 못했어요. 다시 해 주세요.
        </p>
      )}
    </section>
  );
}

function Snippet({ snippet }: { snippet: string }) {
  const { result, copy } = useCopy();
  return (
    <section className="install-step" aria-labelledby="install-snippet">
      <h3 id="install-snippet">2. 이 한 줄을 복사해요</h3>
      <pre className="snippet" data-testid="install-snippet">
        <code>{snippet}</code>
      </pre>
      <div className="actions">
        <button type="button" onClick={() => void copy(snippet)}>
          복사
        </button>
        <CopyResult result={result} />
      </div>
      <p className="muted">이 줄에는 비밀번호가 없어요. 누가 봐도 괜찮은 공개 정보예요.</p>
    </section>
  );
}

function Builders({ status, snippet }: { status: InstallStatusResponse; snippet: string }) {
  const [selected, setSelected] = useState<BuilderGuide['id']>('cafe24');
  const guide = BUILDER_GUIDES.find((g) => g.id === selected) ?? BUILDER_GUIDES[0];
  const note = developerNote({ snippet, scriptUrl: status.scriptUrl, allowedOrigins: status.allowedOrigins });
  const { result, copy } = useCopy();

  return (
    <section className="install-step" aria-labelledby="install-builders">
      <h3 id="install-builders">3. 홈페이지 관리 화면에 붙여 넣어요</h3>
      <div className="chips" role="group" aria-label="홈페이지를 만든 곳">
        {BUILDER_GUIDES.map((g) => (
          <button key={g.id} type="button" className={g.id === selected ? 'chip active' : 'chip'} aria-pressed={g.id === selected} onClick={() => setSelected(g.id)}>
            {g.name}
          </button>
        ))}
      </div>
      {guide && (
        <div className="builder-guide" data-testid={`builder-${guide.id}`}>
          <ol>
            {guide.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {guide.id === 'custom' && (
            <>
              <textarea className="developer-note" readOnly rows={9} value={note} aria-label="개발자에게 보낼 안내문" />
              <div className="actions">
                <button type="button" onClick={() => void copy(note)}>
                  안내문 복사
                </button>
                <CopyResult result={result} />
              </div>
            </>
          )}
          {guide.notes.map((n) => (
            <p key={n} className="muted">
              {n}
            </p>
          ))}
          {guide.links.length > 0 && (
            <p className="builder-links">
              화면 그림은 공식 도움말에 있어요.{' '}
              {guide.links.map((l) => (
                <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer">
                  {l.label}
                </a>
              ))}
            </p>
          )}
        </div>
      )}
      <p className="muted">
        다른 곳에서 만든 홈페이지라면 그곳 도움말에서 "코드 삽입"을 찾아 body 끝(또는 푸터) 칸에 넣으면 돼요.{' '}
        {OTHER_BUILDER_LINKS.map((l) => (
          <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer" className="inline-link">
            {l.label}
          </a>
        ))}
      </p>
    </section>
  );
}

function Verify({ status, checking, onCheck }: { status: InstallStatusResponse; checking: boolean; onCheck: () => void }) {
  return (
    <section className="install-step" aria-labelledby="install-verify">
      <h3 id="install-verify">4. 설치 확인</h3>
      {status.lastOpenedAt ? (
        <p className="install-ok" data-testid="install-verified">
          <span className="pill status-done">설치됨</span> {formatTime(status.lastOpenedAt)}에 홈페이지에서 위젯이 열렸어요.
        </p>
      ) : (
        <p data-testid="install-waiting">
          <span className="pill status-open">아직 신호가 없어요</span> 홈페이지에 들어가 오른쪽 아래 위젯 버튼을 한 번 눌러 보세요. 그다음 다시 확인을 누르면 돼요.
        </p>
      )}
      <div className="actions">
        <button type="button" className="ghost" disabled={checking} onClick={onCheck}>
          {checking ? '확인하는 중…' : '다시 확인'}
        </button>
      </div>
      <p className="muted">버튼이 안 보이면 1번에 등록한 주소와 실제 홈페이지 주소(주소창의 앞부분)가 같은지 확인해 주세요.</p>
    </section>
  );
}

export function Install() {
  const install = useInstall();
  const status = install.data;
  const snippet = status ? widgetSnippet({ scriptUrl: status.scriptUrl, tenantKey: status.tenantKey }) : '';

  return (
    <section className="install">
      <div className="page-intro">
        <h2>홈페이지에 위젯 설치</h2>
        <p className="muted">순서대로 따라 하면 돼요. 코드를 이해할 필요는 없어요.</p>
      </div>
      <QueryBoundary pending={install.isPending} error={install.isError && '설치 정보를 불러오지 못했어요.'}>
        {status && (
          <>
            <Origins status={status} />
            <Snippet snippet={snippet} />
            <Builders status={status} snippet={snippet} />
            <Verify status={status} checking={install.isFetching} onCheck={() => void install.refetch()} />
          </>
        )}
      </QueryBoundary>
    </section>
  );
}
