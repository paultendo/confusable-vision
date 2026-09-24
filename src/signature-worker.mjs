// Registers tsx inside the worker thread, then loads the TypeScript worker.
import { register } from "tsx/esm/api";
register();
await import("./signature-worker.ts");
