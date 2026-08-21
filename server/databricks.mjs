const DEFAULT_CATALOG = "customfaq";
const DEFAULT_SCHEMA = "custom_schema";
const DEFAULT_TABLE = "custom_faq_list";

function getConfig() {
  const config = {
    host: process.env.DATABRICKS_HOST?.replace(/\/$/, ""),
    token: process.env.DATABRICKS_TOKEN,
    warehouseId: process.env.DATABRICKS_WAREHOUSE_ID,
    catalog: process.env.DATABRICKS_CATALOG || DEFAULT_CATALOG,
    schema: process.env.DATABRICKS_SCHEMA || DEFAULT_SCHEMA,
    table: process.env.DATABRICKS_TABLE || DEFAULT_TABLE,
  };

  if (!config.host || !config.token || !config.warehouseId) {
    throw new Error("Databricks 연결 환경변수가 설정되지 않았습니다.");
  }

  return config;
}

function qualifiedTable(config) {
  return `${config.catalog}.${config.schema}.${config.table}`;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || payload.error_code || "Databricks 요청에 실패했습니다.");
  }
  return payload;
}

async function executeStatement(statement) {
  const config = getConfig();
  const headers = {
    Authorization: `Bearer ${config.token}`,
    "Content-Type": "application/json",
  };

  let payload = await requestJson(`${config.host}/api/2.0/sql/statements`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      warehouse_id: config.warehouseId,
      catalog: config.catalog,
      schema: config.schema,
      statement,
      wait_timeout: "30s",
      on_wait_timeout: "CONTINUE",
      disposition: "INLINE",
      format: "JSON_ARRAY",
    }),
  });

  const deadline = Date.now() + 90_000;
  while (["PENDING", "RUNNING"].includes(payload.status?.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    payload = await requestJson(`${config.host}/api/2.0/sql/statements/${payload.statement_id}`, {
      headers: { Authorization: `Bearer ${config.token}` },
    });
  }

  if (payload.status?.state !== "SUCCEEDED") {
    throw new Error(payload.status?.error?.message || "Databricks SQL 실행이 완료되지 않았습니다.");
  }

  const columns = payload.manifest?.schema?.columns?.map((column) => column.name) || [];
  const data = payload.result?.data_array || [];
  return data.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}

async function listFaqs() {
  const config = getConfig();
  const rows = await executeStatement(`
    SELECT faq_id, question, text_answer, audio_mime_type, needs_policy_confirmation, updated_at
    FROM ${qualifiedTable(config)}
    ORDER BY faq_id
  `);

  return rows.map((row) => ({
    faq_id: Number(row.faq_id),
    question: row.question,
    text_answer: row.text_answer,
    audio_mime_type: row.audio_mime_type || "audio/wav",
    needs_policy_confirmation: row.needs_policy_confirmation === "true",
    updated_at: row.updated_at,
    audio_url: `/api/audio/${Number(row.faq_id)}`,
  }));
}

async function getFaqAudio(id) {
  const config = getConfig();
  const rows = await executeStatement(`
    SELECT audio_answer_path, audio_mime_type
    FROM ${qualifiedTable(config)}
    WHERE faq_id = ${id}
    LIMIT 1
  `);

  const row = rows[0];
  if (!row?.audio_answer_path) return null;

  const encodedPath = row.audio_answer_path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const response = await fetch(`${config.host}/api/2.0/fs/files${encodedPath}`, {
    headers: { Authorization: `Bearer ${config.token}` },
  });

  if (!response.ok) {
    throw new Error("Databricks 음성 파일을 불러오지 못했습니다.");
  }

  return {
    body: Buffer.from(await response.arrayBuffer()),
    contentType: row.audio_mime_type || "audio/wav",
  };
}

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

export function databricksApiPlugin() {
  return {
    name: "databricks-faq-api",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url || "/", "http://localhost");
        if (request.method !== "GET" || !url.pathname.startsWith("/api/")) {
          next();
          return;
        }

        try {
          if (url.pathname === "/api/faqs") {
            const faqs = await listFaqs();
            sendJson(response, 200, { faqs, count: faqs.length, source: "custom_faq_list" });
            return;
          }

          const audioMatch = url.pathname.match(/^\/api\/audio\/(\d+)$/);
          if (audioMatch) {
            const audio = await getFaqAudio(Number(audioMatch[1]));
            if (!audio) {
              sendJson(response, 404, { message: "음성 답변을 찾을 수 없습니다." });
              return;
            }

            response.statusCode = 200;
            response.setHeader("Content-Type", audio.contentType);
            response.setHeader("Content-Length", String(audio.body.length));
            response.setHeader("Cache-Control", "private, max-age=300");
            response.end(audio.body);
            return;
          }

          sendJson(response, 404, { message: "API 경로를 찾을 수 없습니다." });
        } catch (error) {
          sendJson(response, 503, { message: error.message || "FAQ 서비스에 연결하지 못했습니다." });
        }
      });
    },
  };
}
