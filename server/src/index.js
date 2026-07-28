import { createApp } from "./app.js";
import { assertRuntimeConfig, config } from "./config.js";

assertRuntimeConfig();
const server = createApp().listen(config.port, () => {
  console.log(`Publium API listening on http://localhost:${config.port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
