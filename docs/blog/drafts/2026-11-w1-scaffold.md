---
title: "AI 상담 위젯 SDK 1주차 — 코드보다 CI 게이트를 먼저 세운 이유"
date: 2026-11-08
category: ""
tags: [pnpm, monorepo, github-actions, docker, sse]
---

<!-- W1 마무리 시점에 작성할 첫 글의 뼈대. [본인 작성] 부분을 채운다.
     면접 질문 뱅크(docs/interview/week1-infra.md)에 답한 내용이 그대로 재료가 된다. -->

## 어떤 문제였나

AI 에이전트 주도로 빠르게 구현하는 프로젝트에서, 사람이 모든 코드를 다 읽을 수 없다면
품질의 최저선을 무엇이 지키는가? [본인 작성: 프로젝트 소개 1~2문장 + 이 질문]

## 어떻게 결정했나

- 첫 커밋이 기능 코드가 아니라 CI 게이트(typecheck·lint·test·build)인 이유: [본인 작성]
- pnpm workspace 모노레포: [본인 작성 — ADR-0001에서 가져오기]
- Docker 멀티 스테이지: [본인 작성]

## 구현하며 배운 것

[본인 작성 — 예: branch protection 없이는 워크플로우가 게이트가 아니라는 것,
`--frozen-lockfile`이 막아주는 사고, currentScript 타이밍 버그 등]

## 면접에서 받을 것 같은 질문과 내 답

[본인 작성 — 질문 뱅크에서 가장 어려웠던 2개]
