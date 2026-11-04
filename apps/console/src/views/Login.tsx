import { zodResolver } from '@hookform/resolvers/zod';
import { consoleLoginSchema, type ConsoleLoginInput } from '@qrate/contracts/schemas';
import { useForm } from 'react-hook-form';
import { ApiError } from '../api';
import { useLogin } from '../queries';

// 로그인 = 테넌트 키(위젯 설치 스니펫의 data-tenant 값) + 콘솔 비밀키. 세션은 서버가 HttpOnly 쿠키로 준다 — 스크립트는 토큰을 만지지 않는다.
// 폼 상태는 react-hook-form, 입력 검사는 서버와 같은 zod 스키마(@qrate/contracts/schemas)다.

/** 서버 응답 → 사람이 읽을 문구. 상태 코드별로 하나씩. */
function loginErrorMessage(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof ApiError && error.status === 401) return '테넌트 키 또는 콘솔 키가 맞지 않아요.';
  if (error instanceof ApiError && error.status === 429) return '시도가 너무 많아요. 잠시 뒤에 다시 해 주세요.';
  return '서버에 연결할 수 없어요.';
}

export function Login() {
  const login = useLogin();
  const form = useForm<ConsoleLoginInput>({ resolver: zodResolver(consoleLoginSchema), defaultValues: { tenant: '', key: '' } });
  const { errors, isSubmitting } = form.formState;
  const busy = isSubmitting || login.isPending;
  const serverError = loginErrorMessage(login.error);

  return (
    <main className="login">
      <form className="card" onSubmit={form.handleSubmit((values) => login.mutateAsync(values).catch(() => undefined))} noValidate>
        <h1>Qrate 콘솔</h1>
        <p className="muted">운영자 로그인. 테넌트 키는 위젯 설치 스니펫의 data-tenant 값이고, 콘솔 키는 운영자에게만 공유된 비밀키예요.</p>
        <label>
          테넌트 키
          <input id="tenant" autoComplete="username" aria-invalid={Boolean(errors.tenant)} {...form.register('tenant')} />
          {errors.tenant && <span className="error field-error">{errors.tenant.message}</span>}
        </label>
        <label>
          콘솔 키
          <input id="key" type="password" autoComplete="current-password" aria-invalid={Boolean(errors.key)} {...form.register('key')} />
          {errors.key && <span className="error field-error">{errors.key.message}</span>}
        </label>
        {serverError && (
          <p className="error" role="alert">
            {serverError}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? '확인하는 중…' : '로그인'}
        </button>
      </form>
    </main>
  );
}
