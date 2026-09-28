import { config as loadDotenv } from "dotenv";
import { rootEnvFilePath } from "./workspace-root.js";

/** Side-effect-only module: loads this process's `.env` files the moment it is imported. */

loadDotenv({ quiet: true });

const rootPath = rootEnvFilePath();
if (rootPath) {
  loadDotenv({ path: rootPath, quiet: true });
}
