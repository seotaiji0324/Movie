import { createHash, pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import snowflake from "snowflake-sdk/dist/index.js";

const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_BYTES || 50 * 1024 * 1024);
const MAX_POSTER_BYTES = 1024 * 1024;
const VIDEO_CHUNK_BYTES = 4 * 1024 * 1024;
const ADMIN_USERNAME = "SEOHYUNHO";
const ADMIN_SESSION_COOKIE = "daytrip_admin_session";
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PASSWORD_ITERATIONS = 210_000;
const adminSessions = new Map();
let connectionPromise;

snowflake.configure({ logLevel: "OFF" });

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  if (status >= 400 || payload?.authenticated !== undefined) res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function identifier(value, fallback, label) {
  const result = String(value || fallback).toUpperCase();
  if (!/^[A-Z][A-Z0-9_$]*$/.test(result)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
  return result;
}

function databaseName() {
  return identifier(process.env.SNOWFLAKE_DATABASE, "movieDB", "SNOWFLAKE_DATABASE");
}

function schemaName() {
  return identifier(process.env.SNOWFLAKE_SCHEMA, "PUBLIC", "SNOWFLAKE_SCHEMA");
}

function objectName(name) {
  return `${databaseName()}.${schemaName()}.${name}`;
}

function isConfigured() {
  if (process.env.SNOWFLAKE_CONNECTION_NAME) return true;
  return Boolean(
    process.env.SNOWFLAKE_ACCOUNT &&
      process.env.SNOWFLAKE_USERNAME &&
      (process.env.SNOWFLAKE_PASSWORD || process.env.SNOWFLAKE_AUTHENTICATOR),
  );
}

function connect(connection) {
  return new Promise((resolve, reject) => {
    const complete = (error, activeConnection) => {
      if (error) reject(error);
      else resolve(activeConnection);
    };
    if (process.env.SNOWFLAKE_AUTHENTICATOR) connection.connectAsync(complete);
    else connection.connect(complete);
  });
}

function execute(connection, sqlText, binds = []) {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      binds,
      complete(error, statement, rows) {
        if (error) reject(error);
        else resolve({ statement, rows: rows || [] });
      },
    });
  });
}

async function ensureWarehouse(connection) {
  if (process.env.SNOWFLAKE_WAREHOUSE) {
    const warehouse = identifier(process.env.SNOWFLAKE_WAREHOUSE, "", "SNOWFLAKE_WAREHOUSE");
    await execute(connection, `USE WAREHOUSE ${warehouse}`);
    return warehouse;
  }

  const current = await execute(connection, 'SELECT CURRENT_WAREHOUSE() AS "warehouse"');
  if (current.rows[0]?.warehouse) return current.rows[0].warehouse;

  const available = await execute(connection, "SHOW WAREHOUSES");
  const warehouseName = available.rows.find((row) => row.name || row.NAME)?.name || available.rows[0]?.NAME;
  if (!warehouseName) throw new Error("NO_WAREHOUSE");
  const warehouse = identifier(warehouseName, "", "warehouse name");
  await execute(connection, `USE WAREHOUSE ${warehouse}`);
  return warehouse;
}

async function ensureSchema(connection) {
  const database = databaseName();
  const schema = schemaName();
  await execute(connection, `CREATE DATABASE IF NOT EXISTS ${database}`);
  await execute(connection, `CREATE SCHEMA IF NOT EXISTS ${database}.${schema}`);
  await execute(
    connection,
    `
      CREATE TABLE IF NOT EXISTS ${objectName("VIDEO_POSTS")} (
        ID VARCHAR(36) NOT NULL PRIMARY KEY,
        SLUG VARCHAR(80) NOT NULL UNIQUE,
        TITLE VARCHAR(140) NOT NULL,
        CAPTION VARCHAR(600) NOT NULL DEFAULT '',
        CATEGORY VARCHAR(40) NOT NULL,
        LOCATION VARCHAR(120) NOT NULL DEFAULT '',
        RECORDED_AT DATE,
        DURATION_SECONDS NUMBER(38, 0) NOT NULL DEFAULT 0,
        VIDEO_FILE_NAME VARCHAR(255) NOT NULL,
        VIDEO_MIME_TYPE VARCHAR(100) NOT NULL,
        VIDEO_SIZE_BYTES NUMBER(38, 0) NOT NULL,
        VIDEO_STORAGE_MODE VARCHAR(40) NOT NULL DEFAULT 'snowflake_binary_chunks',
        POSTER_FILE_NAME VARCHAR(255),
        POSTER_MIME_TYPE VARCHAR(100),
        POSTER_DATA BINARY(1048576),
        IS_PUBLISHED BOOLEAN NOT NULL DEFAULT TRUE,
        CREATED_AT TIMESTAMP_LTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
        PUBLISHED_AT TIMESTAMP_LTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()
      )
    `,
  );
  await execute(
    connection,
    `
      CREATE TABLE IF NOT EXISTS ${objectName("VIDEO_FILE_CHUNKS")} (
        VIDEO_ID VARCHAR(36) NOT NULL,
        CHUNK_INDEX NUMBER(38, 0) NOT NULL,
        CHUNK_DATA BINARY(4194304) NOT NULL,
        CREATED_AT TIMESTAMP_LTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
        PRIMARY KEY (VIDEO_ID, CHUNK_INDEX)
      )
    `,
  );
  await execute(
    connection,
    `
      CREATE TABLE IF NOT EXISTS ${objectName("MEMBER")} (
        ID VARCHAR(36) NOT NULL PRIMARY KEY,
        USERNAME VARCHAR(120) NOT NULL UNIQUE,
        DISPLAY_NAME VARCHAR(120) NOT NULL,
        PASSWORD_HASH VARCHAR(128) NOT NULL,
        PASSWORD_SALT VARCHAR(64) NOT NULL,
        MEMBER_ROLE VARCHAR(40) NOT NULL DEFAULT 'ADMIN',
        IS_ACTIVE BOOLEAN NOT NULL DEFAULT TRUE,
        CREATED_AT TIMESTAMP_LTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
        UPDATED_AT TIMESTAMP_LTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
        LAST_LOGIN_AT TIMESTAMP_LTZ
      )
    `,
  );
  await execute(
    connection,
    `
      CREATE TABLE IF NOT EXISTS ${objectName("CATEGORY")} (
        NAME VARCHAR(40) NOT NULL PRIMARY KEY,
        DISPLAY_ORDER NUMBER(38, 0) NOT NULL,
        IS_ACTIVE BOOLEAN NOT NULL DEFAULT TRUE,
        CREATED_AT TIMESTAMP_LTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
        UPDATED_AT TIMESTAMP_LTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()
      )
    `,
  );
  await execute(
    connection,
    `
      MERGE INTO ${objectName("CATEGORY")} AS target
      USING (
        SELECT column1 AS NAME, column2 AS DISPLAY_ORDER
        FROM VALUES
          ('모델', 1),
          ('음식', 2),
          ('재미', 3),
          ('작업', 4),
          ('기타', 5)
      ) AS source
      ON target.NAME = source.NAME
      WHEN MATCHED THEN UPDATE SET
        target.DISPLAY_ORDER = source.DISPLAY_ORDER,
        target.IS_ACTIVE = TRUE,
        target.UPDATED_AT = CURRENT_TIMESTAMP()
      WHEN NOT MATCHED THEN INSERT (NAME, DISPLAY_ORDER, IS_ACTIVE)
        VALUES (source.NAME, source.DISPLAY_ORDER, TRUE)
    `,
  );
  await execute(
    connection,
    `UPDATE ${objectName("CATEGORY")} SET IS_ACTIVE = FALSE, UPDATED_AT = CURRENT_TIMESTAMP() WHERE NAME NOT IN ('모델', '음식', '재미', '작업', '기타')`,
  );
  await execute(
    connection,
    `
      UPDATE ${objectName("VIDEO_POSTS")}
      SET CATEGORY = '모델'
      WHERE TITLE = '모델'
        AND CATEGORY NOT IN (SELECT NAME FROM ${objectName("CATEGORY")} WHERE IS_ACTIVE = TRUE)
    `,
  );
  await execute(
    connection,
    `
      UPDATE ${objectName("VIDEO_POSTS")}
      SET CATEGORY = '기타'
      WHERE CATEGORY NOT IN (SELECT NAME FROM ${objectName("CATEGORY")} WHERE IS_ACTIVE = TRUE)
    `,
  );
}

async function getConnection() {
  if (!isConfigured()) return null;
  if (!connectionPromise) {
    connectionPromise = (async () => {
      let connection;
      if (process.env.SNOWFLAKE_CONNECTION_NAME) {
        const connectionName = String(process.env.SNOWFLAKE_CONNECTION_NAME);
        if (!/^[A-Za-z0-9_.-]+$/.test(connectionName)) {
          throw new Error("SNOWFLAKE_CONNECTION_NAME contains unsupported characters.");
        }
        process.env.SNOWFLAKE_DEFAULT_CONNECTION_NAME = connectionName;
        connection = snowflake.createConnection();
      } else {
        const options = {
          account: process.env.SNOWFLAKE_ACCOUNT,
          username: process.env.SNOWFLAKE_USERNAME,
          application: "DAYTRIP_VIDEO_BLOG",
          timeout: 20_000,
          retryTimeout: 0,
        };
        if (process.env.SNOWFLAKE_PASSWORD) options.password = process.env.SNOWFLAKE_PASSWORD;
        if (process.env.SNOWFLAKE_AUTHENTICATOR) {
          options.authenticator = process.env.SNOWFLAKE_AUTHENTICATOR;
          options.clientStoreTemporaryCredential = process.env.SNOWFLAKE_CLIENT_STORE_TEMPORARY_CREDENTIAL !== "false";
          options.browserActionTimeout = Number(process.env.SNOWFLAKE_BROWSER_ACTION_TIMEOUT || 600_000);
        }
        const proxyValue = process.env.HTTPS_PROXY || process.env.https_proxy;
        if (proxyValue) {
          const proxy = new URL(proxyValue);
          options.proxyHost = proxy.hostname;
          options.proxyPort = Number(
            proxy.port || (proxy.protocol === "https:" ? 443 : 80),
          );
          options.proxyProtocol = proxy.protocol.replace(":", "");
        }
        if (process.env.SNOWFLAKE_ROLE) options.role = process.env.SNOWFLAKE_ROLE;
        connection = snowflake.createConnection(options);
      }
      await connect(connection);
      await ensureWarehouse(connection);
      await ensureSchema(connection);
      return connection;
    })().catch((error) => {
      connectionPromise = undefined;
      throw error;
    });
  }
  return connectionPromise;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  const limit = Math.ceil((MAX_VIDEO_BYTES + MAX_POSTER_BYTES) * 1.45);
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("UPLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function decodeDataUrl(value, expectedPrefix, maxBytes) {
  if (typeof value !== "string") throw new Error("INVALID_FILE");
  const match = value.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match || !match[1].startsWith(expectedPrefix)) throw new Error("INVALID_FILE");
  const data = Buffer.from(match[2], "base64");
  if (!data.length || data.length > maxBytes) throw new Error("UPLOAD_TOO_LARGE");
  return { mimeType: match[1], data };
}

function binaryBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "hex");
  return Buffer.alloc(0);
}

function slugify(title) {
  const base = String(title)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "travel-film";
  return `${base}-${Date.now().toString(36)}`;
}

function passwordDigest(password, salt) {
  return pbkdf2Sync(String(password), salt, PASSWORD_ITERATIONS, 32, "sha256").toString("hex");
}

function validPassword(password) {
  return typeof password === "string" && password.length >= 12 && password.length <= 128;
}

function verifyPassword(password, salt, expectedHash) {
  if (!validPassword(password) || !salt || !expectedHash) return false;
  const actual = Buffer.from(passwordDigest(password, salt), "hex");
  const expected = Buffer.from(String(expectedHash), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parseCookies(req) {
  return String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separator = part.indexOf("=");
      if (separator < 0) return cookies;
      cookies[part.slice(0, separator)] = decodeURIComponent(part.slice(separator + 1));
      return cookies;
    }, {});
}

function tokenKey(token) {
  return createHash("sha256").update(token).digest("hex");
}

function issueAdminSession(res) {
  const token = randomBytes(32).toString("base64url");
  adminSessions.set(tokenKey(token), {
    username: ADMIN_USERNAME,
    expiresAt: Date.now() + ADMIN_SESSION_TTL_MS,
  });
  res.setHeader(
    "set-cookie",
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`,
  );
}

function clearAdminSession(req, res) {
  const token = parseCookies(req)[ADMIN_SESSION_COOKIE];
  if (token) adminSessions.delete(tokenKey(token));
  res.setHeader(
    "set-cookie",
    `${ADMIN_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
  );
}

function currentAdminSession(req) {
  const token = parseCookies(req)[ADMIN_SESSION_COOKIE];
  if (!token) return null;
  const key = tokenKey(token);
  const session = adminSessions.get(key);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    adminSessions.delete(key);
    return null;
  }
  return session;
}

function isLoopbackRequest(req) {
  const address = String(req.socket?.remoteAddress || "");
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function findAdminMember(connection) {
  const result = await execute(
    connection,
    `
      SELECT
        ID AS "id",
        USERNAME AS "username",
        DISPLAY_NAME AS "displayName",
        PASSWORD_HASH AS "passwordHash",
        PASSWORD_SALT AS "passwordSalt",
        MEMBER_ROLE AS "memberRole",
        IS_ACTIVE AS "isActive"
      FROM ${objectName("MEMBER")}
      WHERE USERNAME = ?
      LIMIT 1
    `,
    [ADMIN_USERNAME],
  );
  return result.rows[0] || null;
}

async function authenticatedAdmin(connection, req) {
  const session = currentAdminSession(req);
  if (!session || session.username !== ADMIN_USERNAME) throw httpError(401, "관리자 로그인이 필요합니다.");
  const member = await findAdminMember(connection);
  if (!member?.isActive || member.memberRole !== "ADMIN") throw httpError(401, "관리자 로그인이 필요합니다.");
  return member;
}

async function adminSessionStatus(connection, req, res) {
  const member = await findAdminMember(connection);
  const session = currentAdminSession(req);
  const authenticated = Boolean(
    member?.isActive && member.memberRole === "ADMIN" && session?.username === ADMIN_USERNAME,
  );
  json(res, 200, {
    authenticated,
    setupRequired: !member,
    username: ADMIN_USERNAME,
    displayName: authenticated ? member.displayName : null,
  });
}

async function setupAdmin(connection, req, res) {
  if (!isLoopbackRequest(req)) throw httpError(403, "최초 관리자 설정은 로컬 개발 서버에서만 가능합니다.");
  if (await findAdminMember(connection)) throw httpError(409, "관리자 계정이 이미 설정되어 있습니다.");
  const body = await readJson(req);
  if (String(body.username || ADMIN_USERNAME).toUpperCase() !== ADMIN_USERNAME) {
    throw httpError(400, `관리자 이름은 ${ADMIN_USERNAME}만 사용할 수 있습니다.`);
  }
  if (!validPassword(body.password)) throw httpError(400, "관리자 비밀번호는 12자 이상으로 설정해 주세요.");
  const salt = randomBytes(16).toString("hex");
  const passwordHash = passwordDigest(body.password, salt);
  await execute(
    connection,
    `
      INSERT INTO ${objectName("MEMBER")} (
        ID, USERNAME, DISPLAY_NAME, PASSWORD_HASH, PASSWORD_SALT, MEMBER_ROLE, IS_ACTIVE
      ) VALUES (?, ?, ?, ?, ?, 'ADMIN', TRUE)
    `,
    [randomUUID(), ADMIN_USERNAME, ADMIN_USERNAME, passwordHash, salt],
  );
  issueAdminSession(res);
  json(res, 201, {
    authenticated: true,
    setupRequired: false,
    username: ADMIN_USERNAME,
    displayName: ADMIN_USERNAME,
  });
}

async function loginAdmin(connection, req, res) {
  const body = await readJson(req);
  const username = String(body.username || "").trim().toUpperCase();
  const member = await findAdminMember(connection);
  if (
    username !== ADMIN_USERNAME ||
    !member?.isActive ||
    member.memberRole !== "ADMIN" ||
    !verifyPassword(body.password, member.passwordSalt, member.passwordHash)
  ) {
    throw httpError(401, "관리자 이름 또는 비밀번호가 올바르지 않습니다.");
  }
  await execute(
    connection,
    `UPDATE ${objectName("MEMBER")} SET LAST_LOGIN_AT = CURRENT_TIMESTAMP(), UPDATED_AT = CURRENT_TIMESTAMP() WHERE ID = ?`,
    [member.id],
  );
  issueAdminSession(res);
  json(res, 200, {
    authenticated: true,
    setupRequired: false,
    username: ADMIN_USERNAME,
    displayName: member.displayName,
  });
}

async function logoutAdmin(req, res) {
  clearAdminSession(req, res);
  json(res, 200, { authenticated: false, username: ADMIN_USERNAME });
}

async function categoryExists(connection, name) {
  const result = await execute(
    connection,
    `SELECT NAME AS "name" FROM ${objectName("CATEGORY")} WHERE NAME = ? AND IS_ACTIVE = TRUE LIMIT 1`,
    [name],
  );
  return Boolean(result.rows[0]);
}

async function listCategories(connection, res) {
  const result = await execute(
    connection,
    `
      SELECT NAME AS "name"
      FROM ${objectName("CATEGORY")}
      WHERE IS_ACTIVE = TRUE
      ORDER BY DISPLAY_ORDER ASC, NAME ASC
    `,
  );
  json(res, 200, {
    configured: true,
    connected: true,
    database: databaseName(),
    categories: result.rows.map((row) => row.name),
  });
}

function videoSummary(row) {
  return {
    id: row.id,
    title: row.title,
    caption: row.caption,
    category: row.category,
    location: row.location,
    recordedAt: row.recordedAt,
    durationSeconds: Number(row.durationSeconds),
    hasPoster: Boolean(row.hasPoster),
    createdAt: row.createdAt,
  };
}

function adminVideoSummary(row) {
  return {
    ...videoSummary(row),
    isPublished: Boolean(row.isPublished),
    videoFileName: row.videoFileName,
    videoSizeBytes: Number(row.videoSizeBytes),
  };
}

async function listAdminVideos(connection, req, res) {
  await authenticatedAdmin(connection, req);
  const result = await execute(
    connection,
    `
      SELECT
        ID AS "id",
        TITLE AS "title",
        CAPTION AS "caption",
        CATEGORY AS "category",
        LOCATION AS "location",
        RECORDED_AT AS "recordedAt",
        DURATION_SECONDS AS "durationSeconds",
        (POSTER_DATA IS NOT NULL) AS "hasPoster",
        CREATED_AT AS "createdAt",
        IS_PUBLISHED AS "isPublished",
        VIDEO_FILE_NAME AS "videoFileName",
        VIDEO_SIZE_BYTES AS "videoSizeBytes"
      FROM ${objectName("VIDEO_POSTS")}
      ORDER BY CREATED_AT DESC
      LIMIT 100
    `,
  );
  json(res, 200, { videos: result.rows.map(adminVideoSummary) });
}

async function insertVideoChunks(connection, id, data) {
  for (let offset = 0, index = 0; offset < data.length; offset += VIDEO_CHUNK_BYTES, index += 1) {
    await execute(
      connection,
      `INSERT INTO ${objectName("VIDEO_FILE_CHUNKS")} (VIDEO_ID, CHUNK_INDEX, CHUNK_DATA) VALUES (?, ?, TO_BINARY(?, 'HEX'))`,
      [id, index, data.subarray(offset, offset + VIDEO_CHUNK_BYTES).toString("hex")],
    );
  }
}

async function updateAdminVideo(connection, req, id, res) {
  await authenticatedAdmin(connection, req);
  const body = await readJson(req);
  const title = String(body.title || "").trim().slice(0, 140);
  const caption = String(body.caption || "").trim().slice(0, 600);
  const category = String(body.category || "").trim();
  const location = String(body.location || "").trim().slice(0, 120);
  const recordedAt = String(body.recordedAt || "").trim() || null;
  const isPublished = body.isPublished === true;
  const replacementVideo = body.videoDataUrl
    ? decodeDataUrl(body.videoDataUrl, "video/", MAX_VIDEO_BYTES)
    : null;
  const replacementPoster = replacementVideo && body.posterDataUrl
    ? decodeDataUrl(body.posterDataUrl, "image/", MAX_POSTER_BYTES)
    : null;
  if (!title || !location || !(await categoryExists(connection, category))) {
    throw httpError(400, "제목, 장소, 카테고리를 확인해 주세요.");
  }
  if (recordedAt && !/^\d{4}-\d{2}-\d{2}$/.test(recordedAt)) {
    throw httpError(400, "기록 날짜 형식을 확인해 주세요.");
  }
  if (replacementVideo && !replacementPoster) {
    throw httpError(400, "교체 동영상의 첫 화면 이미지가 필요합니다.");
  }
  const existing = await execute(
    connection,
    `SELECT ID AS "id" FROM ${objectName("VIDEO_POSTS")} WHERE ID = ? LIMIT 1`,
    [id],
  );
  if (!existing.rows[0]) throw httpError(404, "수정할 영상을 찾을 수 없습니다.");

  await execute(connection, "BEGIN");
  try {
    if (replacementVideo) {
      await execute(
        connection,
        `
          UPDATE ${objectName("VIDEO_POSTS")}
          SET
            TITLE = ?,
            CAPTION = ?,
            CATEGORY = ?,
            LOCATION = ?,
            RECORDED_AT = ?,
            PUBLISHED_AT = CASE WHEN ? = TRUE AND IS_PUBLISHED = FALSE THEN CURRENT_TIMESTAMP() ELSE PUBLISHED_AT END,
            IS_PUBLISHED = ?,
            DURATION_SECONDS = ?,
            VIDEO_FILE_NAME = ?,
            VIDEO_MIME_TYPE = ?,
            VIDEO_SIZE_BYTES = ?,
            POSTER_FILE_NAME = ?,
            POSTER_MIME_TYPE = ?,
            POSTER_DATA = TO_BINARY(?, 'HEX')
          WHERE ID = ?
        `,
        [
          title,
          caption,
          category,
          location,
          recordedAt,
          isPublished,
          isPublished,
          Math.max(0, Number(body.durationSeconds) || 0),
          String(body.videoFileName || "replacement-video").slice(0, 255),
          replacementVideo.mimeType,
          replacementVideo.data.length,
          String(body.posterFileName || "replacement-first-frame.jpg").slice(0, 255),
          replacementPoster.mimeType,
          replacementPoster.data.toString("hex"),
          id,
        ],
      );
      await execute(
        connection,
        `DELETE FROM ${objectName("VIDEO_FILE_CHUNKS")} WHERE VIDEO_ID = ?`,
        [id],
      );
      await insertVideoChunks(connection, id, replacementVideo.data);
    } else {
      await execute(
        connection,
        `
          UPDATE ${objectName("VIDEO_POSTS")}
          SET
            TITLE = ?,
            CAPTION = ?,
            CATEGORY = ?,
            LOCATION = ?,
            RECORDED_AT = ?,
            PUBLISHED_AT = CASE WHEN ? = TRUE AND IS_PUBLISHED = FALSE THEN CURRENT_TIMESTAMP() ELSE PUBLISHED_AT END,
            IS_PUBLISHED = ?
          WHERE ID = ?
        `,
        [title, caption, category, location, recordedAt, isPublished, isPublished, id],
      );
    }
    await execute(connection, "COMMIT");
  } catch (error) {
    await execute(connection, "ROLLBACK").catch(() => {});
    throw error;
  }

  const result = await execute(
    connection,
    `
      SELECT
        ID AS "id",
        TITLE AS "title",
        CAPTION AS "caption",
        CATEGORY AS "category",
        LOCATION AS "location",
        RECORDED_AT AS "recordedAt",
        DURATION_SECONDS AS "durationSeconds",
        (POSTER_DATA IS NOT NULL) AS "hasPoster",
        CREATED_AT AS "createdAt",
        IS_PUBLISHED AS "isPublished",
        VIDEO_FILE_NAME AS "videoFileName",
        VIDEO_SIZE_BYTES AS "videoSizeBytes"
      FROM ${objectName("VIDEO_POSTS")}
      WHERE ID = ?
      LIMIT 1
    `,
    [id],
  );
  if (!result.rows[0]) throw httpError(404, "수정할 영상을 찾을 수 없습니다.");
  json(res, 200, { video: adminVideoSummary(result.rows[0]) });
}

async function deleteAdminVideo(connection, req, id, res) {
  await authenticatedAdmin(connection, req);
  const existing = await execute(
    connection,
    `SELECT ID AS "id", TITLE AS "title" FROM ${objectName("VIDEO_POSTS")} WHERE ID = ? LIMIT 1`,
    [id],
  );
  if (!existing.rows[0]) throw httpError(404, "삭제할 영상을 찾을 수 없습니다.");

  await execute(connection, "BEGIN");
  try {
    await execute(
      connection,
      `DELETE FROM ${objectName("VIDEO_FILE_CHUNKS")} WHERE VIDEO_ID = ?`,
      [id],
    );
    await execute(
      connection,
      `DELETE FROM ${objectName("VIDEO_POSTS")} WHERE ID = ?`,
      [id],
    );
    await execute(connection, "COMMIT");
  } catch (error) {
    await execute(connection, "ROLLBACK").catch(() => {});
    throw error;
  }

  json(res, 200, { deleted: true, id, title: existing.rows[0].title });
}

async function listVideos(connection, res) {
  const result = await execute(
    connection,
    `
      SELECT
        ID AS "id",
        TITLE AS "title",
        CAPTION AS "caption",
        CATEGORY AS "category",
        LOCATION AS "location",
        RECORDED_AT AS "recordedAt",
        DURATION_SECONDS AS "durationSeconds",
        (POSTER_DATA IS NOT NULL) AS "hasPoster",
        CREATED_AT AS "createdAt"
      FROM ${objectName("VIDEO_POSTS")}
      WHERE IS_PUBLISHED = TRUE
      ORDER BY PUBLISHED_AT DESC
      LIMIT 50
    `,
  );
  json(res, 200, {
    configured: true,
    connected: true,
    database: databaseName(),
    videos: result.rows.map(videoSummary),
  });
}

async function createVideo(connection, req, res) {
  const body = await readJson(req);
  const title = String(body.title || "").trim().slice(0, 140);
  const category = String(body.category || "기타").trim().slice(0, 40);
  const location = String(body.location || "").trim().slice(0, 120);
  const caption = String(body.caption || "").trim().slice(0, 600);
  if (!title || !location || !(await categoryExists(connection, category))) {
    throw httpError(400, "제목, 장소, 카테고리를 확인해 주세요.");
  }

  const video = decodeDataUrl(body.videoDataUrl, "video/", MAX_VIDEO_BYTES);
  if (!body.posterDataUrl) throw httpError(400, "동영상의 첫 화면 이미지가 필요합니다.");
  const poster = decodeDataUrl(body.posterDataUrl, "image/", MAX_POSTER_BYTES);
  const id = randomUUID();
  const recordedAt = body.recordedAt || null;
  const durationSeconds = Math.max(0, Number(body.durationSeconds) || 0);

  await execute(connection, "BEGIN");
  try {
    await execute(
      connection,
      `
        INSERT INTO ${objectName("VIDEO_POSTS")} (
          ID, SLUG, TITLE, CAPTION, CATEGORY, LOCATION, RECORDED_AT, DURATION_SECONDS,
          VIDEO_FILE_NAME, VIDEO_MIME_TYPE, VIDEO_SIZE_BYTES,
          POSTER_FILE_NAME, POSTER_MIME_TYPE, POSTER_DATA
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TO_BINARY(?, 'HEX'))
      `,
      [
        id,
        slugify(title),
        title,
        caption,
        category,
        location,
        recordedAt,
        durationSeconds,
        String(body.videoFileName || "travel-video").slice(0, 255),
        video.mimeType,
        video.data.length,
        String(body.posterFileName || "video-first-frame.jpg").slice(0, 255),
        poster.mimeType,
        poster.data.toString("hex"),
      ],
    );

    await insertVideoChunks(connection, id, video.data);
    await execute(connection, "COMMIT");
  } catch (error) {
    await execute(connection, "ROLLBACK").catch(() => {});
    throw error;
  }

  json(res, 201, {
    video: videoSummary({
      id,
      title,
      caption,
      category,
      location,
      recordedAt,
      durationSeconds,
      hasPoster: true,
      createdAt: new Date().toISOString(),
    }),
  });
}

async function servePoster(connection, id, res) {
  const result = await execute(
    connection,
    `SELECT POSTER_DATA AS "posterData", POSTER_MIME_TYPE AS "posterMimeType" FROM ${objectName("VIDEO_POSTS")} WHERE ID = ? AND IS_PUBLISHED = TRUE`,
    [id],
  );
  const row = result.rows[0];
  const data = binaryBuffer(row?.posterData);
  if (!data.length) return json(res, 404, { message: "포스터 이미지를 찾을 수 없습니다." });
  res.statusCode = 200;
  res.setHeader("content-type", row.posterMimeType || "image/jpeg");
  res.setHeader("cache-control", "private, max-age=0, must-revalidate");
  res.end(data);
}

async function serveVideo(connection, req, id, res) {
  const metadata = await execute(
    connection,
    `SELECT VIDEO_MIME_TYPE AS "videoMimeType", VIDEO_SIZE_BYTES AS "videoSizeBytes" FROM ${objectName("VIDEO_POSTS")} WHERE ID = ? AND IS_PUBLISHED = TRUE`,
    [id],
  );
  const row = metadata.rows[0];
  if (!row) return json(res, 404, { message: "동영상을 찾을 수 없습니다." });
  const chunks = await execute(
    connection,
    `SELECT CHUNK_DATA AS "chunkData" FROM ${objectName("VIDEO_FILE_CHUNKS")} WHERE VIDEO_ID = ? ORDER BY CHUNK_INDEX ASC`,
    [id],
  );
  const data = Buffer.concat(chunks.rows.map((chunk) => binaryBuffer(chunk.chunkData)));
  if (!data.length) return json(res, 404, { message: "동영상 데이터를 찾을 수 없습니다." });

  const size = Number(row.videoSizeBytes);
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  res.setHeader("content-type", row.videoMimeType || "video/mp4");
  res.setHeader("accept-ranges", "bytes");
  res.setHeader("cache-control", "private, max-age=0, must-revalidate");
  if (!range) {
    res.statusCode = 200;
    res.setHeader("content-length", size);
    return res.end(data);
  }

  const start = range[1] ? Number(range[1]) : 0;
  const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    res.statusCode = 416;
    res.setHeader("content-range", `bytes */${size}`);
    return res.end();
  }
  res.statusCode = 206;
  res.setHeader("content-range", `bytes ${start}-${end}/${size}`);
  res.setHeader("content-length", end - start + 1);
  return res.end(data.subarray(start, end + 1));
}

function publicMessage(error) {
  if (error.message === "UPLOAD_TOO_LARGE") return "파일 용량이 허용 범위를 초과했습니다.";
  if (error.message === "INVALID_FILE") return "지원하지 않는 파일 형식입니다.";
  if (error.message === "INVALID_INPUT") return "제목과 장소를 확인해 주세요.";
  if (error.message === "NO_WAREHOUSE") return "사용 가능한 Snowflake Warehouse가 필요합니다.";
  if (/browser action timed out/i.test(error.message || "")) {
    return "브라우저에서 Snowflake 로그인을 승인해 주세요.";
  }
  if (/authentication|incorrect username|password/i.test(error.message || "")) {
    return "Snowflake 계정 또는 비밀번호를 확인해 주세요.";
  }
  return "Snowflake 연결 또는 요청 처리에 실패했습니다.";
}

export function snowflakeApiPlugin() {
  return {
    name: "snowflake-video-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || "/", "http://local.test");
        const isVideoApi = url.pathname.startsWith("/api/videos");
        const isAdminApi = url.pathname.startsWith("/api/admin");
        const isCategoryApi = url.pathname.startsWith("/api/categories");
        if (!isVideoApi && !isAdminApi && !isCategoryApi) return next();

        if (!isConfigured()) {
          if (req.method === "GET" && url.pathname === "/api/videos") {
            return json(res, 200, {
              configured: false,
              connected: false,
              database: databaseName(),
              videos: [],
            });
          }
          return json(res, 503, { message: "Snowflake 환경변수 설정이 필요합니다." });
        }

        try {
          const connection = await getConnection();
          if (req.method === "GET" && url.pathname === "/api/categories") {
            return await listCategories(connection, res);
          }
          if (req.method === "GET" && url.pathname === "/api/admin/session") {
            return await adminSessionStatus(connection, req, res);
          }
          if (req.method === "POST" && url.pathname === "/api/admin/setup") {
            return await setupAdmin(connection, req, res);
          }
          if (req.method === "POST" && url.pathname === "/api/admin/login") {
            return await loginAdmin(connection, req, res);
          }
          if (req.method === "POST" && url.pathname === "/api/admin/logout") {
            return await logoutAdmin(req, res);
          }
          if (req.method === "GET" && url.pathname === "/api/admin/videos") {
            return await listAdminVideos(connection, req, res);
          }
          const adminVideoMatch = url.pathname.match(/^\/api\/admin\/videos\/([0-9a-f-]+)$/i);
          if (req.method === "PATCH" && adminVideoMatch) {
            return await updateAdminVideo(connection, req, adminVideoMatch[1], res);
          }
          if (req.method === "DELETE" && adminVideoMatch) {
            return await deleteAdminVideo(connection, req, adminVideoMatch[1], res);
          }
          if (req.method === "GET" && url.pathname === "/api/videos") return await listVideos(connection, res);
          if (req.method === "POST" && url.pathname === "/api/videos") return await createVideo(connection, req, res);

          const posterMatch = url.pathname.match(/^\/api\/videos\/([0-9a-f-]+)\/poster$/i);
          if (req.method === "GET" && posterMatch) return await servePoster(connection, posterMatch[1], res);
          const videoMatch = url.pathname.match(/^\/api\/videos\/([0-9a-f-]+)\/content$/i);
          if (req.method === "GET" && videoMatch) return await serveVideo(connection, req, videoMatch[1], res);

          return json(res, 404, { message: "요청한 API를 찾을 수 없습니다." });
        } catch (error) {
          const statusCode = Number(error.statusCode) || 500;
          if (statusCode >= 500) server.config.logger.error(error);
          return json(res, statusCode, {
            configured: true,
            connected: statusCode < 500,
            message: statusCode < 500 ? error.message : publicMessage(error),
          });
        }
      });
    },
  };
}
