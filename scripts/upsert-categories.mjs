import snowflake from "snowflake-sdk/dist/index.js";

snowflake.configure({ logLevel: "OFF" });

const TARGET_CATEGORIES = ["댄스", "미술", "음악", "뉴스"];
const connectionOptions = {
  account: process.env.SNOWFLAKE_ACCOUNT,
  username: process.env.SNOWFLAKE_USERNAME,
  application: "MUSECUT_CATEGORY_MAINTENANCE",
  timeout: 20_000,
  retryTimeout: 0,
};

if (process.env.SNOWFLAKE_PASSWORD) connectionOptions.password = process.env.SNOWFLAKE_PASSWORD;
if (process.env.SNOWFLAKE_AUTHENTICATOR) {
  connectionOptions.authenticator = process.env.SNOWFLAKE_AUTHENTICATOR;
  connectionOptions.clientStoreTemporaryCredential = process.env.SNOWFLAKE_CLIENT_STORE_TEMPORARY_CREDENTIAL !== "false";
  connectionOptions.browserActionTimeout = Number(process.env.SNOWFLAKE_BROWSER_ACTION_TIMEOUT || 600_000);
}
if (process.env.SNOWFLAKE_WAREHOUSE) connectionOptions.warehouse = process.env.SNOWFLAKE_WAREHOUSE;
if (process.env.SNOWFLAKE_ROLE) connectionOptions.role = process.env.SNOWFLAKE_ROLE;

const proxyValue = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxyValue) {
  const proxy = new URL(proxyValue);
  connectionOptions.proxyHost = proxy.hostname;
  connectionOptions.proxyPort = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
  connectionOptions.proxyProtocol = proxy.protocol.replace(":", "");
}

const connection = snowflake.createConnection(connectionOptions);

function connect() {
  return new Promise((resolve, reject) => {
    const complete = (error) => (error ? reject(error) : resolve());
    if (connectionOptions.authenticator) connection.connectAsync(complete);
    else connection.connect(complete);
  });
}

function execute(sqlText, binds = []) {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      binds,
      complete(error, _statement, rows) {
        if (error) reject(error);
        else resolve(rows || []);
      },
    });
  });
}

function destroy() {
  return new Promise((resolve) => connection.destroy(() => resolve()));
}

let connected = false;
try {
  await connect();
  connected = true;

  await execute(`
    MERGE INTO MOVIEDB.PUBLIC.CATEGORY AS target
    USING (
      SELECT column1 AS NAME, column2 AS DISPLAY_ORDER
      FROM VALUES ('댄스', 6), ('미술', 7), ('음악', 8), ('뉴스', 9)
    ) AS source
    ON target.NAME = source.NAME
    WHEN MATCHED THEN UPDATE SET
      target.DISPLAY_ORDER = source.DISPLAY_ORDER,
      target.IS_ACTIVE = TRUE,
      target.UPDATED_AT = CURRENT_TIMESTAMP()
    WHEN NOT MATCHED THEN INSERT (NAME, DISPLAY_ORDER, IS_ACTIVE)
      VALUES (source.NAME, source.DISPLAY_ORDER, TRUE)
  `);

  if (process.argv.includes("--restore-video-assignments")) {
    await execute(`
      UPDATE MOVIEDB.PUBLIC.VIDEO_POSTS
      SET CATEGORY = CASE
        WHEN TITLE = '귀여운 아이 댄스' THEN '댄스'
        WHEN TITLE = '댄스' THEN '미술'
        ELSE CATEGORY
      END
      WHERE CATEGORY = '기타'
        AND TITLE IN ('귀여운 아이 댄스', '댄스')
    `);
  }

  const rows = await execute(
    `
      SELECT
        NAME AS "name",
        DISPLAY_ORDER AS "displayOrder",
        IS_ACTIVE AS "isActive"
      FROM MOVIEDB.PUBLIC.CATEGORY
      WHERE NAME IN (?, ?, ?, ?)
      ORDER BY DISPLAY_ORDER, NAME
    `,
    TARGET_CATEGORIES,
  );

  const verified = rows.length === TARGET_CATEGORIES.length
    && rows.every((row) => TARGET_CATEGORIES.includes(row.name) && row.isActive === true);

  const assignments = process.argv.includes("--restore-video-assignments")
    ? await execute(`
        SELECT TITLE AS "title", CATEGORY AS "category"
        FROM MOVIEDB.PUBLIC.VIDEO_POSTS
        WHERE TITLE IN ('귀여운 아이 댄스', '댄스')
        ORDER BY TITLE
      `)
    : [];

  process.stdout.write(`RESULT=${JSON.stringify({ verified, rows, assignments })}\n`);
  if (!verified) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`FAILURE=${JSON.stringify({
    code: error?.code || null,
    message: String(error?.message || error).slice(0, 1_000),
  })}\n`);
  process.exitCode = 1;
} finally {
  if (connected) await destroy();
}
