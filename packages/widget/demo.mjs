/* global process, console, URL */
// 데모 페이지를 허용 오리진(http://localhost:5173)에서 서빙한다.
// file://로 열면 Origin이 null이라 서버가 대화창 iframe을 막는다(시드 allowedOrigins, apps/server/seed/demo-tenant.notes.md).
// 의존성 없이 이 패키지 디렉터리만 정적으로 낸다. 실행: pnpm --filter @qrate/widget demo
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

const root = import.meta.dirname;
const port = Number(process.env.PORT) || 5173;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
};

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const file = join(root, normalize(pathname === '/' ? '/demo.html' : pathname));
  if (!file.startsWith(root + sep)) {
    res.writeHead(403).end();
    return;
  }
  let stat;
  try {
    stat = statSync(file);
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
}).listen(port, () => {
  console.log(`[demo] http://localhost:${port}/demo.html (서버 pnpm dev, 위젯 build 뒤)`);
});
