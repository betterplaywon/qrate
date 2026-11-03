# syntax=docker/dockerfile:1
# 멀티 스테이지 빌드:
#   build 스테이지 — 전체 의존성 + TS 컴파일
#   runtime 스테이지 — 컴파일 결과(dist)와 프로덕션 의존성만
# 효과: 이미지 크기 감소 + 공격 표면 축소(빌드 도구·devDependencies 미포함). 면접 질문 8번.
#
# 빌드/실행 (리포 루트에서):
#   docker build -f apps/server/Dockerfile -t sw-server .
#   docker run -p 8787:8787 sw-server

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS build
WORKDIR /repo
# 의존성 메타데이터를 먼저 복사 → 소스만 바뀌면 install 레이어 캐시가 재사용된다.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --filter @qrate/server
COPY apps/server apps/server
RUN pnpm --filter @qrate/server build
# 서버 패키지 + 프로덕션 의존성만 /out 으로 추출 (pnpm deploy)
RUN pnpm --filter @qrate/server deploy --prod --legacy /out

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /out ./
# 루트가 아닌 node 사용자로 실행 — 컨테이너 탈출 시 피해 축소. 면접 질문 9번.
USER node
EXPOSE 8787
CMD ["node", "dist/index.js"]
