import ResearchGraph from "./ResearchGraph";

export default function ResearchGraphPage({ session }) {
  const displayName = session?.user?.user_metadata?.full_name
    || session?.user?.user_metadata?.name
    || session?.user?.email
    || "사용자";

  return <ResearchGraph standalone displayName={displayName} />;
}
