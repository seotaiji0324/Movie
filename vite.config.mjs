import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { snowflakeApiPlugin } from "./server/snowflake.mjs";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const serverEnvKeys = [
    "SNOWFLAKE_ACCOUNT",
    "SNOWFLAKE_CONNECTION_NAME",
    "SNOWFLAKE_USERNAME",
    "SNOWFLAKE_PASSWORD",
    "SNOWFLAKE_AUTHENTICATOR",
    "SNOWFLAKE_CLIENT_STORE_TEMPORARY_CREDENTIAL",
    "SNOWFLAKE_BROWSER_ACTION_TIMEOUT",
    "SNOWFLAKE_DATABASE",
    "SNOWFLAKE_SCHEMA",
    "SNOWFLAKE_WAREHOUSE",
    "SNOWFLAKE_ROLE",
    "MAX_VIDEO_BYTES",
  ];

  for (const key of serverEnvKeys) {
    const value = Object.hasOwn(env, key) ? env[key] : process.env[key];
    if (value) process.env[key] = value;
    else delete process.env[key];
  }

  const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1];
  const pagesBase = process.env.GITHUB_ACTIONS && repositoryName ? `/${repositoryName}/` : "/";

  return {
    base: pagesBase,
    build: {
      outDir: "dist/client",
    },
    optimizeDeps: {
      include: ["react", "react-dom/client", "@phosphor-icons/react"],
    },
    server: {
      host: "0.0.0.0",
      allowedHosts: ["terminal.local"],
      warmup: {
        clientFiles: ["./src/main.jsx"],
      },
    },
    plugins: [snowflakeApiPlugin(), react()],
  };
});
