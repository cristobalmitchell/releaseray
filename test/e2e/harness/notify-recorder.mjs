/**
 * Preloaded into the bundle's process with `node --import` (see
 * `notifyRecorder` in run-action.ts). It answers requests to the Slack, Teams
 * and Intercom hosts the way those services do and appends each one to the
 * file named by RELEASERAY_E2E_NOTIFY_LOG, one JSON line per request. Every
 * other request, such as those to the fake GitHub, goes through unchanged.
 *
 * The bundle is not changed for the test: its host allowlists still run
 * before `fetch` is called, so only an allowed URL ever reaches this file.
 */
import { appendFileSync } from "node:fs";
import process from "node:process";

const log = process.env.RELEASERAY_E2E_NOTIFY_LOG;
const original = globalThis.fetch;

function answer(hostname, method) {
  if (hostname === "hooks.slack.com" || hostname === "hooks.slack-gov.com") {
    return new globalThis.Response("ok", { status: 200 });
  }
  if (hostname.endsWith(".webhook.office.com") || hostname.endsWith(".office365.com")) {
    return new globalThis.Response("1", { status: 200 });
  }
  if (hostname === "api.intercom.io") {
    const body =
      method === "GET"
        ? { type: "list", data: [], total_count: 0 }
        : { type: "article", id: "1", url: "https://intercom.help/articles/1" };
    return new globalThis.Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

globalThis.fetch = async (input, init) => {
  const request = new globalThis.Request(input, init);
  const { hostname } = new globalThis.URL(request.url);
  const response = log ? answer(hostname, request.method) : null;
  if (!response) return original(input, init);
  const body = await request.text();
  appendFileSync(log, `${JSON.stringify({ method: request.method, url: request.url, body })}\n`);
  return response;
};
