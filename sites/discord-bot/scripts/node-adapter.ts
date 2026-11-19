/**
 * Runs a Web-standard route module (`export function GET(request)`) on Vercel's
 * Node.js runtime, which hands the function a Node request and response.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

type Method = "GET" | "POST";
export type RouteModule = Partial<
  Record<Method, (request: Request) => Promise<Response> | Response>
>;

function toWebRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const method = req.method ?? "GET";
  const url = `https://${headers.get("host") ?? "localhost"}${req.url ?? "/"}`;
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    ...(hasBody && {
      body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
      duplex: "half",
    }),
  });
}

export function toNodeHandler(route: RouteModule) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const handler = route[req.method as Method];
    if (handler === undefined) {
      res.writeHead(405, { allow: Object.keys(route).join(", ") }).end();
      return;
    }
    const response = await handler(toWebRequest(req));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}
