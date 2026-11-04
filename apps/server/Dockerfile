# syntax=docker/dockerfile:1
# 멀티 스테이지 빌드:
#   build 스테이지 — 전체 의존성 + TS 컴파일
#   runtime 스테이지 — 컴파일 결과(dist)와 프로덕션 의존성만
# 효과: 이미지 크기 감소 + 공격 표면 축소(빌드 도구·devDependencies 미포함). 면접 질문 8번.
#
# 빌드/실행 (리포 루트에서):
#   docker build -f apps/server/Dockerfile -t qrate-server .
#   docker run -p 8787:8787 qrate-server

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS build
WORKDIR /repo
# Prisma CLI(마이그레이션·시드 — compose의 migrate 서비스가 이 스테이지를 실행한다)는 OpenSSL 버전을 보고 스키마 엔진 변형을 고른다.
# slim 이미지에는 openssl이 없어 "failed to detect the libssl/openssl version" 경고와 함께 1.1.x 변형으로 떨어진다. 런타임 스테이지에는 필요 없다.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
# 의존성 메타데이터를 먼저 복사 → 소스만 바뀌면 install 레이어 캐시가 재사용된다.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs tsconfig.base.json ./
COPY apps/server/package.json apps/server/prisma.config.ts apps/server/
# Prisma 스키마는 install 전에 — 서버 postinstall(prisma generate)이 읽는다. @prisma/engines의 postinstall이 스키마 엔진(마이그레이션용)도 여기서 받아 둔다.
COPY apps/server/prisma apps/server/prisma
COPY packages/contracts/package.json packages/contracts/
COPY packages/widget/package.json packages/widget/
COPY apps/console/package.json apps/console/
# `@qrate/server...`: 서버가 의존하는 워크스페이스 패키지(@qrate/contracts, 대화창 자산을 주는 @qrate/widget, 콘솔 앱 @qrate/console)까지 함께 설치한다.
RUN pnpm install --frozen-lockfile --filter @qrate/server...
COPY packages/contracts packages/contracts
COPY packages/widget packages/widget
COPY apps/console apps/console
COPY apps/server apps/server
# 의존 순서대로 빌드: contracts → widget(런처 + 대화창 앱)·console(운영 콘솔) → server. 서버 빌드는 contracts의 dist를 읽는다.
RUN pnpm --filter @qrate/server... build
# 서버 패키지 + 프로덕션 의존성을 /out 으로 추출 (pnpm deploy). 각 패키지에서 package.json의 files에 적힌 것만 담는다 —
# 서버는 dist·seed, 워크스페이스 패키지(contracts·widget·console)는 dist(콘솔의 react는 devDependency라 번들에만 있다). src·test·tsconfig·prisma·.env.example은 빌드 스테이지에만 남는다.
# Prisma 클라이언트는 dist/generated(tsc가 함께 컴파일)와 @prisma/client 런타임(프로덕션 의존성)으로 돈다 — CLI·스키마 엔진은 필요 없다.
# 마이그레이션·시드는 이 빌드 스테이지를 compose의 migrate 서비스가 그대로 실행한다(docker-compose.yml).
RUN pnpm --filter @qrate/server deploy --prod --legacy /out

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /out ./
# 루트가 아닌 node 사용자로 실행 — 컨테이너 탈출 시 피해 축소. 면접 질문 9번.
USER node
EXPOSE 8787
CMD ["node", "dist/index.js"]
