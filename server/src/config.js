import "dotenv/config";

export function cleanEnvValue(name, rawValue, fallback = "") {
  let value = String(rawValue ?? fallback).trim();
  if (
    value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }
  const assignmentPrefix = `${name}=`;
  if (value.startsWith(assignmentPrefix)) value = value.slice(assignmentPrefix.length).trim();
  if (
    value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

function environment(name, fallback = "") {
  return cleanEnvValue(name, process.env[name], fallback);
}

function integer(name, fallback) {
  const value = Number.parseInt(environment(name, String(fallback)), 10);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

export const config = {
  env: environment("NODE_ENV", "development"),
  port: integer("PORT", 4000),
  clientOrigin: environment("CLIENT_ORIGIN", "http://localhost:5173"),
  databaseUrl: environment("DATABASE_URL"),
  databaseSsl: environment("DATABASE_SSL", "true").toLowerCase() !== "false",
  supabaseUrl: environment("SUPABASE_URL"),
  supabaseServiceRoleKey: environment("SUPABASE_SERVICE_ROLE_KEY"),
  devUserId: environment("DEV_USER_ID"),
  openaiApiKey: environment("OPENAI_API_KEY"),
  chatModel: environment("OPENAI_CHAT_MODEL", "gpt-5.6-terra"),
  embeddingModel: environment("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"),
  ncbiEmail: environment("NCBI_EMAIL"),
  ncbiApiKey: environment("NCBI_API_KEY"),
  ncbiTool: environment("NCBI_TOOL", "publium"),
};

export function assertRuntimeConfig() {
  const missing = [
    ["DATABASE_URL", config.databaseUrl],
    ["SUPABASE_URL", config.supabaseUrl],
    ["SUPABASE_SERVICE_ROLE_KEY", config.supabaseServiceRoleKey],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
}
