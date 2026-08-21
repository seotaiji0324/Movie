import { generateKeyPairSync, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: options.env || process.env,
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) {
    const sensitiveValues = options.sensitiveValues || [];
    let message = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    for (const value of sensitiveValues) {
      if (value) message = message.replaceAll(value, "[hidden]");
    }
    throw new Error(`${command} failed: ${message.slice(0, 1500)}`);
  }
  return String(result.stdout || "").trim();
}

function setNetlifyVariable(key, value, secret = false) {
  if (!value) throw new Error(`${key} is missing.`);
  const args = [
    "--yes",
    "netlify-cli",
    "env:set",
    key,
    value,
    "--context",
    "production",
    "--force",
  ];
  if (secret) args.push("--secret");
  const command = process.platform === "win32" ? process.env.ComSpec : "npx";
  const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npx.cmd", ...args] : args;
  run(command, commandArgs, {
    sensitiveValues: secret ? [value] : [],
  });
  process.stdout.write(`NETLIFY_ENV_SET=${key}\n`);
}

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const publicKeyValue = publicKey.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, "");
const privateKeyBase64 = Buffer.from(privateKey).toString("base64");
const sessionSecret = randomBytes(48).toString("base64url");

const provisionOutput = run(
  process.execPath,
  ["--env-file=.env", "scripts/provision-netlify-snowflake.mjs"],
  {
    env: {
      ...process.env,
      MOVIE_SERVICE_PUBLIC_KEY: publicKeyValue,
      MOVIE_SERVICE_PRIVATE_KEY_BASE64: privateKeyBase64,
    },
    sensitiveValues: [privateKeyBase64],
  },
);
process.stdout.write(`${provisionOutput}\n`);

setNetlifyVariable("SNOWFLAKE_ACCOUNT", process.env.SNOWFLAKE_ACCOUNT, true);
setNetlifyVariable("SNOWFLAKE_PRIVATE_KEY_BASE64", privateKeyBase64, true);
setNetlifyVariable("ADMIN_SESSION_SECRET", sessionSecret, true);
setNetlifyVariable("SNOWFLAKE_USERNAME", "MOVIE_APP_SVC");
setNetlifyVariable("SNOWFLAKE_AUTHENTICATOR", "SNOWFLAKE_JWT");
setNetlifyVariable("SNOWFLAKE_DATABASE", "MOVIEDB");
setNetlifyVariable("SNOWFLAKE_SCHEMA", "PUBLIC");
setNetlifyVariable("SNOWFLAKE_WAREHOUSE", "COMPUTE_WH");
setNetlifyVariable("SNOWFLAKE_ROLE", "MOVIE_APP_ROLE");
setNetlifyVariable("SNOWFLAKE_SKIP_SCHEMA_SETUP", "true");
setNetlifyVariable("ADMIN_COOKIE_CROSS_SITE", "true");
setNetlifyVariable("API_ALLOWED_ORIGINS", "https://seotaiji0324.github.io");
setNetlifyVariable("MAX_VIDEO_BYTES", String(50 * 1024 * 1024));
process.stdout.write("RESULT=Snowflake service identity and Netlify secrets configured\n");
