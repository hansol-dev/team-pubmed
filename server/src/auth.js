import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

let client;

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
    const { data, error } = await supabase().auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: "Invalid or expired access token" });
    req.user = data.user;
    return next();
  } catch (error) {
    return next(error);
  }
}
