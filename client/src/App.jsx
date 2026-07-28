import { useEffect, useState } from "react";
import { hasSupabaseConfig, supabase } from "./lib/supabase";
import Landing from "./components/Landing";
import Dashboard from "./components/Dashboard";

export default function App() {
  const query = new URLSearchParams(window.location.search);
  const isLocalDevelopment = import.meta.env.DEV && query.get("dev") === "1";
  const isPreview = query.get("preview") === "1";
  const localDevelopmentSession = isLocalDevelopment
    ? {
        access_token: "publium-local-development",
        user: {
          email: "local-dev@publium.local",
          user_metadata: { full_name: "로컬 테스트" },
        },
      }
    : null;
  const previewSession = isPreview
    ? {
        access_token: "development-preview-token",
        user: {
          email: "preview@publium.local",
          user_metadata: { full_name: "Publium" },
        },
      }
    : null;
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    if (!supabase) {
      setSession(null);
      return undefined;
    }
    let active = true;
    let authEventReceived = false;
    const currentUrl = new URL(window.location.href);
    const hash = new URLSearchParams(currentUrl.hash.replace(/^#/, ""));
    const callbackError = currentUrl.searchParams.get("error_description")
      || hash.get("error_description")
      || currentUrl.searchParams.get("error")
      || hash.get("error");
    const authCode = currentUrl.searchParams.get("code");

    const clearAuthCallback = () => {
      ["code", "error", "error_code", "error_description"].forEach((key) => {
        currentUrl.searchParams.delete(key);
      });
      currentUrl.hash = "";
      window.history.replaceState({}, document.title, `${currentUrl.pathname}${currentUrl.search}`);
    };

    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => {
      authEventReceived = true;
      if (active) setSession(next);
    });

    const initializeAuth = async () => {
      if (callbackError) {
        clearAuthCallback();
        if (active) {
          window.alert(`Google 로그인에 실패했습니다: ${callbackError}`);
          setSession(null);
        }
        return;
      }

      const result = authCode
        ? await supabase.auth.exchangeCodeForSession(authCode)
        : await supabase.auth.getSession();
      if (authCode) clearAuthCallback();
      if (!active) return;
      if (result.error) {
        window.alert(`로그인 세션을 확인하지 못했습니다: ${result.error.message}`);
        setSession(null);
        return;
      }
      if (!authEventReceived) setSession(result.data.session);
    };

    initializeAuth();
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  if (localDevelopmentSession) return <Dashboard session={localDevelopmentSession} />;
  if (previewSession) return <Dashboard session={previewSession} preview />;
  if (session === undefined) {
    return <div className="auth-loading"><span className="loading-spinner" /><p>Publium을 불러오는 중입니다.</p></div>;
  }
  if (!session) return <Landing supabaseReady={hasSupabaseConfig} />;
  return <Dashboard session={session} />;
}
