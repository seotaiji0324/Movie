import { randomUUID } from "node:crypto";
import snowflake from "snowflake-sdk/dist/index.js";

const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_BYTES || 50 * 1024 * 1024);
const MAX_POSTER_BYTES = 1024 * 1024;
const VIDEO_CHUNK_BYTES = 4 * 1024 * 1024;
let connectionPromise;

snowflake.configure({ logLevel: "OFF" });

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
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
      process.env.SNOWFLAKE_PASSWORD,
  );
}

function connect(connection) {
  return new Promise((resolve, reject) => {
    connection.connect((error, activeConnection) => {
      if (error) reject(error);
      else resolve(activeConnection);
    });
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
          password: process.env.SNOWFLAKE_PASSWORD,
          application: "DAYTRIP_VIDEO_BLOG",
          timeout: 20_000,
          retryTimeout: 0,
        };
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
  const category = String(body.category || "기록").trim().slice(0, 40);
  const location = String(body.location || "").trim().slice(0, 120);
  const caption = String(body.caption || "").trim().slice(0, 600);
  if (!title || !location) throw new Error("INVALID_INPUT");

  const video = decodeDataUrl(body.videoDataUrl, "video/", MAX_VIDEO_BYTES);
  const poster = body.posterDataUrl
    ? decodeDataUrl(body.posterDataUrl, "image/", MAX_POSTER_BYTES)
    : null;
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        poster ? String(body.posterFileName || "poster").slice(0, 255) : null,
        poster?.mimeType || null,
        poster?.data || null,
      ],
    );

    for (let offset = 0, index = 0; offset < video.data.length; offset += VIDEO_CHUNK_BYTES, index += 1) {
      await execute(
        connection,
        `INSERT INTO ${objectName("VIDEO_FILE_CHUNKS")} (VIDEO_ID, CHUNK_INDEX, CHUNK_DATA) VALUES (?, ?, ?)`,
        [id, index, video.data.subarray(offset, offset + VIDEO_CHUNK_BYTES)],
      );
    }
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
      hasPoster: Boolean(poster),
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
  res.setHeader("cache-control", "public, max-age=3600");
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
  res.setHeader("cache-control", "private, max-age=300");
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
        if (!url.pathname.startsWith("/api/videos")) return next();

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
          if (req.method === "GET" && url.pathname === "/api/videos") return await listVideos(connection, res);
          if (req.method === "POST" && url.pathname === "/api/videos") return await createVideo(connection, req, res);

          const posterMatch = url.pathname.match(/^\/api\/videos\/([0-9a-f-]+)\/poster$/i);
          if (req.method === "GET" && posterMatch) return await servePoster(connection, posterMatch[1], res);
          const videoMatch = url.pathname.match(/^\/api\/videos\/([0-9a-f-]+)\/content$/i);
          if (req.method === "GET" && videoMatch) return await serveVideo(connection, req, videoMatch[1], res);

          return json(res, 404, { message: "요청한 API를 찾을 수 없습니다." });
        } catch (error) {
          server.config.logger.error(error);
          return json(res, 500, {
            configured: true,
            connected: false,
            message: publicMessage(error),
          });
        }
      });
    },
  };
}
