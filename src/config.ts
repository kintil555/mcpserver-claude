import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AppConfig {
  githubToken: string;
  githubHost?: string; // untuk GitHub Enterprise, opsional
  defaultOwner?: string;
  createdAt: string;
}

const CONFIG_DIR = join(homedir(), ".config", "mcp-github-push");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function configExists(): boolean {
  return existsSync(CONFIG_FILE);
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function loadConfig(): AppConfig {
  if (!configExists()) {
    throw new Error(
      `Config tidak ditemukan di ${CONFIG_FILE}. Jalankan "npx @kintil555/mcp-github-push setup" dulu.`
    );
  }
  const raw = readFileSync(CONFIG_FILE, "utf-8");
  return JSON.parse(raw) as AppConfig;
}

export function saveConfig(config: AppConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  // Pastikan permission benar walau file sudah ada sebelumnya (umask, dsb).
  chmodSync(CONFIG_FILE, 0o600);
}

export function deleteConfigToken(): void {
  if (existsSync(CONFIG_FILE)) {
    writeFileSync(CONFIG_FILE, JSON.stringify({ githubToken: "", createdAt: "" }, null, 2), {
      mode: 0o600,
    });
  }
}
