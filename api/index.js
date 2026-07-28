import { createApp } from "../server/src/app.js";
import { assertRuntimeConfig } from "../server/src/config.js";

assertRuntimeConfig();

export default createApp();
