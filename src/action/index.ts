/**
 * Bundle entry point: `dist/action.js`. The only place that reads
 * `process.env` and sets the exit code.
 */
import { createActionsIO } from "./io";
import { main } from "./main";

process.exitCode = await main({ io: createActionsIO(), env: process.env });
