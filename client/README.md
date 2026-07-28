# Publium React client

현재 Publium의 색상, clay-card 스타일, 레이아웃과 모바일 수집 시트를 유지한 React 19 + Vite 프론트엔드입니다.

## 로컬 실행

```bash
cp .env.example .env.local
npm install
npm run dev
```

`VITE_API_URL`에는 Express 서버의 origin을 입력합니다. API 요청은 이 값 뒤에 `/api/...`를 붙입니다.

Supabase Google 로그인을 사용하려면 `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`를 설정하고 Supabase Auth의 redirect URL에 로컬 및 Vercel 주소를 등록해야 합니다.

## Vercel

Vercel 프로젝트 Root Directory를 `client`로 지정하고 세 환경변수를 등록합니다. 빌드 결과는 `dist`에 생성되며 `vercel.json`이 SPA 경로를 `index.html`로 연결합니다.
