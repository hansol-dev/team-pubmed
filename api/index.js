import { API_REVISION, createApp } from "../server/src/app.js";
import { assertRuntimeConfig } from "../server/src/config.js";

assertRuntimeConfig();

// Keep the serverless entry explicit so API dependency changes invalidate the
// deployed function bundle together with the frontend build.
const app = createApp();
app.locals.apiRevision = API_REVISION;

export default app;
