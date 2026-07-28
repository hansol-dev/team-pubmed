import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

let client;
const LOCAL_DEV_TOKEN = "publium-local-development";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolveLocalDevelopmentUser(token, {
  env = config.env,
  vercel = process.env.VERCEL,
  userId = config.devUserId,
} = {}) {
  if (env !== "development" || vercel || token !== LOCAL_DEV_TOKEN) return null;
  if (!UUID_PATTERN.test(userId)) {
    return { error: "DEV_USER_ID must be set to an existing Supabase user UUID" };
  }
  return {
    user: {
      id: userId,
      email: "local-dev@publium.local",
      user_metadata: { full_name: "로컬 테스트" },
    },
  };
}

function supabase() {
  if (!client) {
    if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
      throw new Error("Supabase authentication is not configured");
    }
    client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return client;
}

export async function requireUser(req, res, next) {
  try {
    const [scheme, token] = (req.headers.authorization || "").split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) {
      return res.status(401).json({ error: "Bearer access token is required" });
    }
    const localDevelopment = resolveLocalDevelopmentUser(token);
    if (localDevelopment?.error) return res.status(503).json({ error: localDevelopment.error });
    if (localDevelopment?.user) {
      req.user = localDevelopment.user;
      return next();
    }
    const { data, error } = await supabase().auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: "Invalid or expired access token" });
    req.user = data.user;
    return next();
  } catch (error) {
    return next(error);
  }
}
