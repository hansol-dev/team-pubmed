# Publium React client

현재 Publium의 색상, clay-card 스타일, 레이아웃과 모바일 수집 시트를 유지한 React 19 + Vite 프론트엔드입니다.

## 로컬 실행

```bash
cp .env.example .env.local
npm install
npm run dev
```

로컬에서는 Vite proxy가 Express 개발 서버로 `/api/...` 요청을 전달합니다.
Vercel에서는 프론트엔드와 Express Function이 같은 origin을 사용하므로
`VITE_API_URL`을 등록하지 않습니다.

Supabase Google 로그인을 사용하려면 `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`를 설정하고 Supabase Auth의 redirect URL에 로컬 및 Vercel 주소를 등록해야 합니다.

## Vercel

Vercel 프로젝트 Root Directory는 저장소 루트(`.`)로 지정합니다. 루트의
`vercel.json`이 `client/dist` 정적 빌드와 `api/index.js` Express Function을
함께 배포합니다.
