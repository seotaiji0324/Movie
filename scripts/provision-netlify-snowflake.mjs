import snowflake from "snowflake-sdk/dist/index.js";

snowflake.configure({ logLevel: "OFF" });

const SERVICE_ROLE = "MOVIE_APP_ROLE";
const SERVICE_USER = "MOVIE_APP_SVC";
const DATABASE = "MOVIEDB";
const SCHEMA = "PUBLIC";

function identifier(value, label) {
  const normalized = String(value || "").toUpperCase();
  if (!/^[A-Z][A-Z0-9_$]*$/.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
}

function connectionOptions(overrides = {}) {
  const options = {
    account: process.env.SNOWFLAKE_ACCOUNT,
    username: process.env.SNOWFLAKE_USERNAME,
    application: "MUSECUT_SERVICE_PROVISIONING",
    timeout: 20_000,
    retryTimeout: 0,
    ...overrides,
  };
  if (!overrides.privateKey && process.env.SNOWFLAKE_PASSWORD) options.password = process.env.SNOWFLAKE_PASSWORD;
  if (!overrides.authenticator && process.env.SNOWFLAKE_AUTHENTICATOR) {
    options.authenticator = process.env.SNOWFLAKE_AUTHENTICATOR;
    options.clientStoreTemporaryCredential = process.env.SNOWFLAKE_CLIENT_STORE_TEMPORARY_CREDENTIAL !== "false";
    options.browserActionTimeout = Number(process.env.SNOWFLAKE_BROWSER_ACTION_TIMEOUT || 600_000);
  }
  const proxyValue = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxyValue) {
    const proxy = new URL(proxyValue);
    options.proxyHost = proxy.hostname;
    options.proxyPort = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
    options.proxyProtocol = proxy.protocol.replace(":", "");
  }
  return options;
}

function connect(options) {
  const connection = snowflake.createConnection(options);
  return new Promise((resolve, reject) => {
    const complete = (error) => (error ? reject(error) : resolve(connection));
    if (options.authenticator) connection.connectAsync(complete);
    else connection.connect(complete);
  });
}

function execute(connection, sqlText, binds = []) {
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

function destroy(connection) {
  return new Promise((resolve) => connection.destroy(() => resolve()));
}

function publicKey() {
  const value = String(process.env.MOVIE_SERVICE_PUBLIC_KEY || "").replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/=]{300,}$/.test(value)) throw new Error("MOVIE_SERVICE_PUBLIC_KEY is missing or invalid.");
  return value;
}

async function availableWarehouse(connection) {
  if (process.env.SNOWFLAKE_WAREHOUSE) return identifier(process.env.SNOWFLAKE_WAREHOUSE, "warehouse");
  const rows = await execute(connection, "SHOW WAREHOUSES");
  const row = rows.find((item) => String(item.state || item.STATE).toUpperCase() === "STARTED") || rows[0];
  const name = row?.name || row?.NAME;
  if (!name) throw new Error("No Snowflake warehouse is available.");
  return identifier(name, "warehouse");
}

async function verifyServiceConnection(warehouse) {
  const privateKeyBase64 = process.env.MOVIE_SERVICE_PRIVATE_KEY_BASE64;
  if (!privateKeyBase64) return null;
  const connection = await connect(connectionOptions({
    username: SERVICE_USER,
    authenticator: "SNOWFLAKE_JWT",
    privateKey: Buffer.from(privateKeyBase64, "base64").toString("utf8"),
    role: SERVICE_ROLE,
    warehouse,
  }));
  try {
    const rows = await execute(
      connection,
      `SELECT COUNT(*) AS "videoCount" FROM ${DATABASE}.${SCHEMA}.VIDEO_POSTS WHERE IS_PUBLISHED = TRUE`,
    );
    return Number(rows[0]?.videoCount || 0);
  } finally {
    await destroy(connection);
  }
}

let adminConnection;
try {
  adminConnection = await connect(connectionOptions());
  const initialContext = (await execute(
    adminConnection,
    'SELECT CURRENT_USER() AS "user", CURRENT_ROLE() AS "role", CURRENT_WAREHOUSE() AS "warehouse"',
  ))[0] || {};
  const warehouse = await availableWarehouse(adminConnection);

  if (process.argv.includes("--inspect")) {
    let canUseAccountAdmin = false;
    try {
      await execute(adminConnection, "USE ROLE ACCOUNTADMIN");
      canUseAccountAdmin = true;
    } catch {
      canUseAccountAdmin = false;
    }
    process.stdout.write(`RESULT=${JSON.stringify({ ...initialContext, warehouse, canUseAccountAdmin })}\n`);
  } else if (process.argv.includes("--normalize-categories") || process.argv.includes("--sync-base-categories")) {
    await execute(adminConnection, "USE ROLE ACCOUNTADMIN");
    await execute(
      adminConnection,
      `
        MERGE INTO ${DATABASE}.${SCHEMA}.CATEGORY AS target
        USING (
          SELECT column1 AS NAME, column2 AS DISPLAY_ORDER
          FROM VALUES ('모델', 1), ('음식', 2), ('재미', 3), ('작업', 4), ('기타', 5)
        ) AS source
        ON target.NAME = source.NAME
        WHEN MATCHED THEN UPDATE SET target.DISPLAY_ORDER = source.DISPLAY_ORDER, target.IS_ACTIVE = TRUE, target.UPDATED_AT = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN INSERT (NAME, DISPLAY_ORDER, IS_ACTIVE) VALUES (source.NAME, source.DISPLAY_ORDER, TRUE)
      `,
    );
    const rows = await execute(
      adminConnection,
      `SELECT NAME AS "name", DISPLAY_ORDER AS "displayOrder" FROM ${DATABASE}.${SCHEMA}.CATEGORY WHERE IS_ACTIVE = TRUE ORDER BY DISPLAY_ORDER, NAME`,
    );
    process.stdout.write(`RESULT=${JSON.stringify({ synced: true, categories: rows.map((row) => ({ name: row.name, displayOrder: Number(row.displayOrder) })) })}\n`);
  } else {
    const rsaPublicKey = publicKey();
    await execute(adminConnection, "USE ROLE ACCOUNTADMIN");
    await execute(adminConnection, `CREATE ROLE IF NOT EXISTS ${SERVICE_ROLE} COMMENT = 'Least privilege role for Musecut API'`);
    await execute(adminConnection, `GRANT USAGE ON WAREHOUSE ${warehouse} TO ROLE ${SERVICE_ROLE}`);
    await execute(adminConnection, `GRANT USAGE ON DATABASE ${DATABASE} TO ROLE ${SERVICE_ROLE}`);
    await execute(adminConnection, `GRANT USAGE ON SCHEMA ${DATABASE}.${SCHEMA} TO ROLE ${SERVICE_ROLE}`);
    await execute(adminConnection, `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${DATABASE}.${SCHEMA} TO ROLE ${SERVICE_ROLE}`);
    await execute(adminConnection, `GRANT SELECT, INSERT, UPDATE, DELETE ON FUTURE TABLES IN SCHEMA ${DATABASE}.${SCHEMA} TO ROLE ${SERVICE_ROLE}`);
    await execute(
      adminConnection,
      `CREATE USER IF NOT EXISTS ${SERVICE_USER} TYPE = SERVICE DEFAULT_ROLE = ${SERVICE_ROLE} DEFAULT_WAREHOUSE = ${warehouse} DEFAULT_NAMESPACE = '${DATABASE}.${SCHEMA}' DEFAULT_SECONDARY_ROLES = () RSA_PUBLIC_KEY = '${rsaPublicKey}' COMMENT = 'Musecut Netlify API service user'`,
    );
    await execute(
      adminConnection,
      `ALTER USER ${SERVICE_USER} SET TYPE = SERVICE DEFAULT_ROLE = ${SERVICE_ROLE} DEFAULT_WAREHOUSE = ${warehouse} DEFAULT_NAMESPACE = '${DATABASE}.${SCHEMA}' DEFAULT_SECONDARY_ROLES = () RSA_PUBLIC_KEY = '${rsaPublicKey}'`,
    );
    await execute(adminConnection, `GRANT ROLE ${SERVICE_ROLE} TO USER ${SERVICE_USER}`);
    const videoCount = await verifyServiceConnection(warehouse);
    process.stdout.write(`RESULT=${JSON.stringify({ serviceUser: SERVICE_USER, serviceRole: SERVICE_ROLE, warehouse, videoCount, verified: videoCount !== null })}\n`);
  }
} catch (error) {
  process.stderr.write(`FAILURE=${JSON.stringify({ code: error?.code || null, message: String(error?.message || error).slice(0, 1000) })}\n`);
  process.exitCode = 1;
} finally {
  if (adminConnection) await destroy(adminConnection);
}
