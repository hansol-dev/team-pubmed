import { useEffect, useState } from "react";
import { hasSupabaseConfig, supabase } from "./lib/supabase";
import Landing from "./components/Landing";
import Dashboard from "./components/Dashboard";

export default function App() {
  const previewSession = import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1"
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
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  if (previewSession) return <Dashboard session={previewSession} />;
  if (session === undefined) {
    return <div className="auth-loading"><span className="loading-spinner" /><p>Publium을 불러오는 중입니다.</p></div>;
  }
  if (!session) return <Landing supabaseReady={hasSupabaseConfig} />;
  return <Dashboard session={session} />;
}
