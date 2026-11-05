#!/usr/bin/env node
// Notification 훅. Claude가 권한 승인이나 입력을 기다릴 때 macOS 알림을 띄운다 — 자율 실행이 멈춘 것을 바로 알 수 있게.
import { notify, readInput } from './_shared.mjs';

const input = readInput();
notify('Claude Code · qrate', '입력을 기다립니다', input.message ?? '');
