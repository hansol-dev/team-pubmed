import { lazy, Suspense, useEffect, useState } from "react";
import { hasSupabaseConfig, supabase } from "./lib/supabase";
import Landing from "./components/Landing";
import Dashboard from "./components/Dashboard";

const ResearchGraphPage = lazy(() => import("./components/ResearchGraphPage"));

export default function App() {
  const query = new URLSearchParams(window.location.search);
  const isResearchGraph = window.location.pathname.replace(/\/+$/, "") === "/research-graph";
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

  const renderAuthenticatedView = (activeSession, preview = false) => (
    isResearchGraph
      ? (
        <Suspense fallback={<div className="graph-page-loading"><span className="loading-spinner" /><p>지식 그래프를 구성하고 있습니다.</p></div>}>
          <ResearchGraphPage session={activeSession} />
        </Suspense>
      )
      : <Dashboard session={activeSession} preview={preview} />
  );

  if (localDevelopmentSession) return renderAuthenticatedView(localDevelopmentSession);
  if (previewSession) return renderAuthenticatedView(previewSession, true);
  if (session === undefined) {
    return <div className="auth-loading"><span className="loading-spinner" /><p>Publium을 불러오는 중입니다.</p></div>;
  }
  if (!session) return <Landing supabaseReady={hasSupabaseConfig} />;
  return renderAuthenticatedView(session);
}
