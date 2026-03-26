import "dotenv/config";
import { runApp } from "./runtime/app-bootstrap.js";

runApp().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
