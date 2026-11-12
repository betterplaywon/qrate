// 플랫폼 운영자의 서버 명령. DB(DATABASE_URL)를 쓰는 서버에서만 쓴다. 메모리 저장소는 서버 프로세스 안에만 있어 바깥 명령이 바꿀 수 없다.
//   pnpm --filter @qrate/server admin <명령>        (운영 이미지: node dist/admin/cli.js <명령>)
//   tenant:add <회사 파일.json> [--update]          회사 등록. 파일은 데모 시드와 같은 형식(회사·허용 사이트·FAQ·초기 크레딧)
//   tenant:list                                     회사 목록
//   console-key:issue <회사 키>                     콘솔 키 발급. 키는 이때 한 번만 보인다. 이전 키와 그 키로 들어온 세션은 바로 끝난다
//   console-key:revoke <회사 키>                    콘솔 키 회수. 그 회사는 콘솔에 로그인할 수 없다
import { parseArgs } from 'node:util';
import { createPrismaClient, createPrismaRepositories } from '../repo/prisma.js';
import { loadSeedFile } from '../repo/seed.js';
import { AdminError, addTenant, issueConsoleKey, listTenants, revokeConsoleKey } from './tenants.js';

const USAGE = [
  '사용: admin <명령>',
  '  tenant:add <회사 파일.json> [--update]',
  '  tenant:list',
  '  console-key:issue <회사 키>',
  '  console-key:revoke <회사 키>',
].join('\n');

function required(value: string | undefined, what: string): string {
  if (!value) throw new AdminError(`${what}가 필요하다\n${USAGE}`);
  return value;
}

/** 표를 공백으로 맞춘다(한글 폭은 두 칸으로 센다). */
function table(rows: readonly string[][]): string {
  const width = (s: string): number => [...s].reduce((w, ch) => w + (/[ᄀ-ᇿ㄰-㆏가-힯]/.test(ch) ? 2 : 1), 0);
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, i) => Math.max(...rows.map((r) => width(r[i] ?? ''))));
  return rows.map((r) => r.map((cell, i) => cell + ' '.repeat((widths[i] ?? 0) - width(cell))).join('  ').trimEnd()).join('\n');
}

const { positionals, values } = parseArgs({ allowPositionals: true, options: { update: { type: 'boolean', default: false } } });
const [command, arg] = positionals;
const databaseUrl = process.env.DATABASE_URL;

if (!command || !databaseUrl) {
  console.error(databaseUrl ? USAGE : `DATABASE_URL이 필요하다. 이 명령은 DB를 쓰는 서버에서만 쓴다\n${USAGE}`);
  process.exit(1);
}

const prisma = createPrismaClient(databaseUrl);
const repos = createPrismaRepositories(prisma);
try {
  switch (command) {
    case 'tenant:add': {
      const added = await addTenant(prisma, loadSeedFile(required(arg, '회사 파일 경로')), { update: values.update });
      const { tenant } = added;
      console.log(
        `[admin] ${added.created ? '회사를 등록했다' : '회사 정보와 FAQ를 파일대로 바꿨다'}: ${tenant.name}(id ${tenant.id}, 회사 키 ${tenant.apiKey}), FAQ ${added.knowledge}개, 초기 크레딧 ${added.initialCredits}`,
      );
      console.log(`[admin] 허용 사이트: ${tenant.allowedOrigins.join(', ') || '(없음. 대화창이 어느 사이트에서도 열리지 않는다)'}`);
      console.log('[admin] 회사 사이트에 넣을 설치 스니펫(스크립트 주소는 배포한 위젯 스크립트로 바꾼다):');
      console.log(`<script src="https://cdn.example.com/widget.js" data-tenant="${tenant.apiKey}" defer></script>`);
      if (added.created) console.log(`[admin] 다음: 콘솔 키 발급  admin console-key:issue ${tenant.apiKey}`);
      break;
    }
    case 'tenant:list': {
      const rows = await listTenants(prisma);
      console.log(
        table([
          ['id', '회사 키', '이름', 'FAQ', '대화', '콘솔 키', '크레딧'],
          ...rows.map((r) => [r.id, r.apiKey, r.name, String(r.knowledge), String(r.conversations), r.consoleKey ? '있음' : '없음', String(r.credits)]),
        ]),
      );
      console.log(`[admin] 회사 ${rows.length}곳`);
      break;
    }
    case 'console-key:issue': {
      const { tenant, key } = await issueConsoleKey(repos.tenants, required(arg, '회사 키'));
      console.log(`[admin] ${tenant.name}(회사 키 ${tenant.apiKey})의 콘솔 키를 발급했다. 이전 키와 그 키로 들어온 로그인 세션은 지금부터 쓸 수 없다.`);
      console.log('[admin] 아래 키는 다시 볼 수 없다. 회사 담당자에게 안전한 길로 전한다.');
      console.log(key);
      break;
    }
    case 'console-key:revoke': {
      const tenant = await revokeConsoleKey(repos.tenants, required(arg, '회사 키'));
      console.log(`[admin] ${tenant.name}(회사 키 ${tenant.apiKey})의 콘솔 키를 회수했다. 콘솔에 로그인할 수 없고, 열려 있던 세션도 끝났다.`);
      break;
    }
    default:
      throw new AdminError(`모르는 명령: ${command}\n${USAGE}`);
  }
} catch (err) {
  if (!(err instanceof AdminError)) throw err;
  console.error(`[admin] ${err.message}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
