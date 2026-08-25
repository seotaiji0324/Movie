import { Readable } from "node:stream";
import { snowflakeApiMiddleware } from "../../server/snowflake.mjs";

const SERVER_ENV_KEYS = [
  "SNOWFLAKE_ACCOUNT",
  "SNOWFLAKE_USERNAME",
  "SNOWFLAKE_AUTHENTICATOR",
  "SNOWFLAKE_PRIVATE_KEY_BASE64",
  "SNOWFLAKE_DATABASE",
  "SNOWFLAKE_SCHEMA",
  "SNOWFLAKE_WAREHOUSE",
  "SNOWFLAKE_ROLE",
  "SNOWFLAKE_SKIP_SCHEMA_SETUP",
  "ADMIN_SESSION_SECRET",
  "ADMIN_COOKIE_CROSS_SITE",
  "API_ALLOWED_ORIGINS",
  "MAX_VIDEO_BYTES",
];

function syncNetlifyEnvironment() {
  for (const key of SERVER_ENV_KEYS) {
    const value = globalThis.Netlify?.env?.get(key);
    if (value) process.env[key] = value;
  }
}

function allowedOrigins() {
  return String(process.env.API_ALLOWED_ORIGINS || "https://seotaiji0324.github.io")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function corsHeaders(request) {
  const origin = request.headers.get("origin");
  const headers = new Headers({
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization, content-type, range",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-expose-headers": "accept-ranges, content-length, content-range",
    vary: "Origin",
  });
  if (origin && allowedOrigins().includes(origin)) headers.set("access-control-allow-origin", origin);
  return headers;
}

function nodeRequest(request, context) {
  const url = new URL(request.url);
  const stream = request.body ? Readable.fromWeb(request.body) : Readable.from([]);
  stream.method = request.method;
  stream.url = `${url.pathname}${url.search}`;
  stream.headers = Object.fromEntries(request.headers.entries());
  stream.socket = { remoteAddress: context.ip || "" };
  return stream;
}

function runMiddleware(request, context) {
  return new Promise((resolve, reject) => {
    const responseHeaders = new Headers();
    const response = {
      statusCode: 200,
      setHeader(name, value) {
        responseHeaders.set(name, String(value));
      },
      getHeader(name) {
        return responseHeaders.get(name);
      },
      end(data) {
        const body = data == null ? null : Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        resolve({ body, headers: responseHeaders, status: this.statusCode });
      },
    };

    Promise.resolve(
      snowflakeApiMiddleware(
        nodeRequest(request, context),
        response,
        () => resolve({ body: Buffer.from("Not found"), headers: new Headers(), status: 404 }),
        console,
      ),
    ).catch(reject);
  });
}

export default async function handler(request, context) {
  syncNetlifyEnvironment();
  const cors = corsHeaders(request);
  const origin = request.headers.get("origin");
  if (origin && !allowedOrigins().includes(origin)) {
    return new Response(JSON.stringify({ message: "허용되지 않은 요청 출처입니다." }), {
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8", vary: "Origin" },
    });
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  try {
    const result = await runMiddleware(request, context);
    for (const [name, value] of cors.entries()) result.headers.set(name, value);
    return new Response(result.body, { status: result.status, headers: result.headers });
  } catch (error) {
    console.error(error);
    for (const [name, value] of cors.entries()) cors.set(name, value);
    cors.set("content-type", "application/json; charset=utf-8");
    return new Response(JSON.stringify({ message: "API 요청을 처리하지 못했습니다." }), { status: 500, headers: cors });
  }
}

export const config = {
  path: "/api/*",
};
