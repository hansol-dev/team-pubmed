import { useCallback, useRef } from "react";
import { supabase } from "../lib/supabase";

export default function Landing({ supabaseReady }) {
  const frameRef = useRef(null);

  const login = useCallback(async () => {
    if (!supabase) {
      window.alert(
        "Supabase 로그인 설정이 필요합니다. client/.env에 VITE_SUPABASE_URL과 VITE_SUPABASE_ANON_KEY를 설정해 주세요.",
      );
      return;
    }
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) {
      window.alert(`Google 로그인을 시작하지 못했습니다: ${error.message}`);
    }
  }, []);

  const prepareLegacyLanding = useCallback(() => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc) return;

    doc.querySelectorAll('a[href="/auth/login"]').forEach((link) => {
      link.href = "#google-login";
      link.addEventListener("click", (event) => {
        event.preventDefault();
        login();
      });
      if (!supabaseReady) {
        link.title = "Supabase 환경변수를 먼저 설정해 주세요.";
        link.setAttribute("data-config-missing", "true");
      }
    });

    const preview = doc.querySelector(".live-app-showcase__frame iframe");
    if (preview) {
      preview.removeAttribute("src");
      preview.srcdoc = `<!doctype html><html><head><style>*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;background:#f5f2ff}body{display:flex;align-items:flex-start;justify-content:center;overflow:hidden}img{display:block;width:100%;height:100%;object-fit:cover;object-position:top center}</style></head><body><img src="/publium-dashboard.png" alt="Publium 서비스 화면 미리보기"></body></html>`;
    }

    const resize = () => {
      const height = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight || 0);
      if (height) frame.style.height = `${height}px`;
    };
    resize();
    window.setTimeout(resize, 150);
    window.setTimeout(resize, 800);
  }, [login, supabaseReady]);

  return (
    <iframe
      ref={frameRef}
      className="legacy-landing-frame"
      src="/landing-legacy.html"
      title="Publium"
      onLoad={prepareLegacyLanding}
    />
  );
}
