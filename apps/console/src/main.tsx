// zod 설정이 가장 먼저 — 아래 import들이 계약 스키마를 평가하기 전에 걸려야 한다(zod-config.ts).
import './zod-config';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { queryClient } from './queries';
import './styles.css';

const el = document.getElementById('root');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}
