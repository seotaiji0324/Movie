import pg from "pg";

const { Pool } = pg;
const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_BYTES || 50 * 1024 * 1024);
const MAX_POSTER_BYTES = 1024 * 1024;
const VIDEO_CHUNK_BYTES = 768 * 1024;
let poolPromise;

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function targetDatabase() {
  const database = process.env.COCKROACH_DATABASE || "CodexDb";
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(database)) {
    throw new Error("COCKROACH_DATABASE contains unsupported characters.");
  }
  return database;
}

function databaseUrl(name) {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${encodeURIComponent(name)}`;
  return url.toString();
}

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_posts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      slug STRING NOT NULL UNIQUE,
      title STRING NOT NULL,
      caption STRING NOT NULL DEFAULT '',
      category STRING NOT NULL,
      location STRING NOT NULL DEFAULT '',
      recorded_at DATE,
      duration_seconds INT8 NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
      video_file_name STRING NOT NULL,
      video_mime_type STRING NOT NULL CHECK (video_mime_type LIKE 'video/%'),
      video_size_bytes INT8 NOT NULL CHECK (video_size_bytes > 0),
      video_storage_mode STRING NOT NULL DEFAULT 'database_chunks',
      poster_file_name STRING,
      poster_mime_type STRING,
      poster_data BYTES,
      is_published BOOL NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      published_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_file_chunks (
      video_id UUID NOT NULL REFERENCES video_posts (id) ON DELETE CASCADE,
      chunk_index INT4 NOT NULL,
      chunk_data BYTES NOT NULL,
      PRIMARY KEY (video_id, chunk_index)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS video_posts_published_idx
    ON video_posts (is_published, published_at DESC)
  `);
}

async function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!poolPromise) {
    poolPromise = (async () => {
      const database = targetDatabase();
      const adminPool = new Pool({
        connectionString: databaseUrl("defaultdb"),
        max: 1,
        application_name: "daytrip-video-blog-bootstrap",
      });
      try {
        await adminPool.query(`CREATE DATABASE IF NOT EXISTS "${database}"`);
      } finally {
        await adminPool.end();
      }

      const pool = new Pool({
        connectionString: databaseUrl(database),
        max: 4,
        idleTimeoutMillis: 20_000,
        connectionTimeoutMillis: 8_000,
        application_name: "daytrip-video-blog",
      });
      await ensureSchema(pool);
      return pool;
    })().catch((error) => {
      poolPromise = undefined;
      throw error;
    });
  }
  return poolPromise;
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
    hasPoster: row.hasPoster,
    createdAt: row.createdAt,
  };
}

async function listVideos(pool, res) {
  const result = await pool.query(`
    SELECT
      id,
      title,
      caption,
      category,
      location,
      recorded_at AS "recordedAt",
      duration_seconds AS "durationSeconds",
      (poster_data IS NOT NULL) AS "hasPoster",
      created_at AS "createdAt"
    FROM video_posts
    WHERE is_published = true
    ORDER BY published_at DESC
    LIMIT 50
  `);
  json(res, 200, {
    configured: true,
    connected: true,
    database: targetDatabase(),
    videos: result.rows.map(videoSummary),
  });
}

async function createVideo(pool, req, res) {
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

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `
      INSERT INTO video_posts (
        slug, title, caption, category, location, recorded_at, duration_seconds,
        video_file_name, video_mime_type, video_size_bytes,
        poster_file_name, poster_mime_type, poster_data
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING
        id,
        title,
        caption,
        category,
        location,
        recorded_at AS "recordedAt",
        duration_seconds AS "durationSeconds",
        (poster_data IS NOT NULL) AS "hasPoster",
        created_at AS "createdAt"
      `,
      [
        slugify(title),
        title,
        caption,
        category,
        location,
        body.recordedAt || null,
        Math.max(0, Number(body.durationSeconds) || 0),
        String(body.videoFileName || "travel-video").slice(0, 255),
        video.mimeType,
        video.data.length,
        poster ? String(body.posterFileName || "poster").slice(0, 255) : null,
        poster?.mimeType || null,
        poster?.data || null,
      ],
    );

    const videoId = result.rows[0].id;
    for (let offset = 0, index = 0; offset < video.data.length; offset += VIDEO_CHUNK_BYTES, index += 1) {
      await client.query(
        "INSERT INTO video_file_chunks (video_id, chunk_index, chunk_data) VALUES ($1, $2, $3)",
        [videoId, index, video.data.subarray(offset, offset + VIDEO_CHUNK_BYTES)],
      );
    }
    await client.query("COMMIT");
    json(res, 201, { video: videoSummary(result.rows[0]) });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function servePoster(pool, id, res) {
  const result = await pool.query(
    "SELECT poster_data, poster_mime_type FROM video_posts WHERE id = $1 AND is_published = true",
    [id],
  );
  const row = result.rows[0];
  if (!row?.poster_data) return json(res, 404, { message: "표지 이미지를 찾을 수 없습니다." });
  res.statusCode = 200;
  res.setHeader("content-type", row.poster_mime_type || "image/jpeg");
  res.setHeader("cache-control", "public, max-age=3600");
  res.end(row.poster_data);
}

async function serveVideo(pool, req, id, res) {
  const result = await pool.query(
    "SELECT video_mime_type, video_size_bytes FROM video_posts WHERE id = $1 AND is_published = true",
    [id],
  );
  const row = result.rows[0];
  if (!row) return json(res, 404, { message: "동영상을 찾을 수 없습니다." });
  const chunks = await pool.query(
    "SELECT chunk_data FROM video_file_chunks WHERE video_id = $1 ORDER BY chunk_index ASC",
    [id],
  );
  if (!chunks.rows.length) return json(res, 404, { message: "동영상 데이터를 찾을 수 없습니다." });
  const data = Buffer.concat(chunks.rows.map((chunk) => chunk.chunk_data));
  const size = Number(row.video_size_bytes);
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  res.setHeader("content-type", row.video_mime_type || "video/mp4");
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
  if (error.message === "UPLOAD_TOO_LARGE") return "파일 용량이 허용 범위를 넘었습니다.";
  if (error.message === "INVALID_FILE") return "지원하지 않는 파일 형식입니다.";
  if (error.message === "INVALID_INPUT") return "제목과 장소를 확인해 주세요.";
  return "CockroachDB 연결 또는 요청 처리에 실패했습니다.";
}

export function cockroachApiPlugin() {
  return {
    name: "cockroach-video-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || "/", "http://local.test");
        if (!url.pathname.startsWith("/api/videos")) return next();

        if (!process.env.DATABASE_URL) {
          if (req.method === "GET" && url.pathname === "/api/videos") {
            return json(res, 200, {
              configured: false,
              connected: false,
              database: targetDatabase(),
              videos: [],
            });
          }
          return json(res, 503, { message: "DATABASE_URL 설정이 필요합니다." });
        }

        try {
          const pool = await getPool();
          if (req.method === "GET" && url.pathname === "/api/videos") return await listVideos(pool, res);
          if (req.method === "POST" && url.pathname === "/api/videos") return await createVideo(pool, req, res);

          const posterMatch = url.pathname.match(/^\/api\/videos\/([0-9a-f-]+)\/poster$/i);
          if (req.method === "GET" && posterMatch) return await servePoster(pool, posterMatch[1], res);
          const videoMatch = url.pathname.match(/^\/api\/videos\/([0-9a-f-]+)\/content$/i);
          if (req.method === "GET" && videoMatch) return await serveVideo(pool, req, videoMatch[1], res);

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
