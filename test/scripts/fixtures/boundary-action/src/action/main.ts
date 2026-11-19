import * as core from "@actions/core";
import { context } from "@actions/github";

export const token = process.env.GITHUB_TOKEN;
export const run = () => core.info(context.eventName);
