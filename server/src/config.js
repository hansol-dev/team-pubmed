import "dotenv/config";

function integer(name, fallback) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

export const config = {
  env: process.env.NODE_ENV || "development",
  port: integer("PORT", 4000),
  clientOrigin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
  databaseUrl: process.env.DATABASE_URL || "",
  databaseSsl: (process.env.DATABASE_SSL || "true").toLowerCase() !== "false",
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  chatModel: process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini",
  embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
  ncbiEmail: process.env.NCBI_EMAIL || "",
  ncbiApiKey: process.env.NCBI_API_KEY || "",
  ncbiTool: process.env.NCBI_TOOL || "publium",
};

export function assertRuntimeConfig() {
  const missing = [
    ["DATABASE_URL", config.databaseUrl],
    ["SUPABASE_URL", config.supabaseUrl],
    ["SUPABASE_SERVICE_ROLE_KEY", config.supabaseServiceRoleKey],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
}
