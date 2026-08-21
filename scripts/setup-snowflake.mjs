import { readFileSync } from "node:fs";
import snowflake from "snowflake-sdk/dist/index.js";

snowflake.configure({ logLevel: "OFF" });

const connectionOptions = {
  account: process.env.SNOWFLAKE_ACCOUNT,
  username: process.env.SNOWFLAKE_USERNAME,
  password: process.env.SNOWFLAKE_PASSWORD,
  application: "DAYTRIP_VIDEO_BLOG_SETUP",
  timeout: 20_000,
  retryTimeout: 0,
};

const proxyValue = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxyValue) {
  const proxy = new URL(proxyValue);
  connectionOptions.proxyHost = proxy.hostname;
  connectionOptions.proxyPort = Number(
    proxy.port || (proxy.protocol === "https:" ? 443 : 80),
  );
  connectionOptions.proxyProtocol = proxy.protocol.replace(":", "");
}

const connection = snowflake.createConnection(connectionOptions);

function connect() {
  return new Promise((resolve, reject) => {
    connection.connect((error, activeConnection) => {
      if (error) reject(error);
      else resolve(activeConnection);
    });
  });
}

function execute(sqlText) {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      complete: (error, statement, rows) => {
        if (error) reject(error);
        else resolve(rows ?? []);
      },
    });
  });
}

function destroy() {
  return new Promise((resolve) => connection.destroy(() => resolve()));
}

try {
  await connect();

  const sql = readFileSync(new URL("../db/init.sql", import.meta.url), "utf8");
  const statements = sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((value) => value.trim())
    .filter(Boolean);

  for (const sqlText of statements) {
    await execute(sqlText);
  }

  const postRows = await execute(
    "SHOW TABLES LIKE 'VIDEO_POSTS' IN SCHEMA MOVIEDB.PUBLIC",
  );
  const chunkRows = await execute(
    "SHOW TABLES LIKE 'VIDEO_FILE_CHUNKS' IN SCHEMA MOVIEDB.PUBLIC",
  );
  const contextRows = await execute(
    "SELECT CURRENT_USER() AS USER_NAME, CURRENT_ROLE() AS ROLE_NAME, CURRENT_WAREHOUSE() AS WAREHOUSE_NAME",
  );
  const context = contextRows[0] ?? {};

  process.stdout.write(
    `RESULT=${JSON.stringify({
      connected: true,
      user: context.USER_NAME,
      role: context.ROLE_NAME,
      warehouse: context.WAREHOUSE_NAME,
      database: "MOVIEDB",
      tables: [
        postRows.length ? "VIDEO_POSTS" : null,
        chunkRows.length ? "VIDEO_FILE_CHUNKS" : null,
      ].filter(Boolean),
    })}\n`,
  );
} catch (error) {
  const safeMessage = String(error?.message ?? error).replace(
    /password=[^;&\s]*/gi,
    "password=[hidden]",
  );
  process.stderr.write(
    `FAILURE=${JSON.stringify({
      code: error?.code ?? null,
      message: safeMessage.slice(0, 1_000),
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  await destroy();
}
