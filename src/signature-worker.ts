import { parentPort } from "node:worker_threads";
import { computeEnrichedSignature } from "./raycasting.js";

parentPort!.on("message", (msg: any) => {
  if (msg.type === "exit") process.exit(0);
  const sig = computeEnrichedSignature(msg.segments, msg.numAngles, msg.raysPerAngle, msg.gridSize, msg.frame);
  parentPort!.postMessage({ id: msg.id, ...sig });
});
