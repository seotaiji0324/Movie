import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
const targetArgs = process.argv.slice(3);

if (!target) {
  console.error("실행할 스크립트 경로가 필요합니다.");
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [
    "--openssl-shared-config",
    `--openssl-config=${join(projectRoot, ".certs", "openssl-compat.cnf")}`,
    resolve(projectRoot, target),
    ...targetArgs,
  ],
  {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_EXTRA_CA_CERTS: join(projectRoot, ".certs", "sds-root.pem"),
    },
  },
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
