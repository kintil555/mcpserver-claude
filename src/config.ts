import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export interface AppConfig {
  githubToken: string;
  githubHost?: string; // untuk GitHub Enterprise, opsional
  /** Nama & email yang dipakai untuk git commit oleh server ini. */
  gitUserName?: string;
  gitUserEmail?: string;
  createdAt: string;
}

const IS_WINDOWS = platform() === "win32";

const CONFIG_DIR = join(homedir(), ".config", "mcp-github-push");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
/** Tempat server meng-clone & menyimpan repo kerja secara lokal. */
export const WORKSPACES_DIR = join(CONFIG_DIR, "workspaces");

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
  const parsed = JSON.parse(raw) as AppConfig;
  if (!parsed.githubToken) {
    throw new Error(
      `Token kosong di ${CONFIG_FILE}. Jalankan "npx @kintil555/mcp-github-push setup" ulang.`
    );
  }
  return parsed;
}

/**
 * Simpan config ke disk. Permission 0o600 (read/write hanya owner) hanya
 * diterapkan di POSIX (Linux/macOS) karena Windows/NTFS tidak memakai model
 * permission Unix -- memanggil chmod dengan mode Unix di Windows bisa
 * silent-fail atau melempar error tergantung filesystem, dan itu yang bikin
 * proses saveConfig gagal total di Windows sebelumnya.
 */
export function saveConfig(config: AppConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, ...(IS_WINDOWS ? {} : { mode: 0o700 }) });
  }
  const payload = JSON.stringify(config, null, 2);
  if (IS_WINDOWS) {
    writeFileSync(CONFIG_FILE, payload, "utf-8");
  } else {
    writeFileSync(CONFIG_FILE, payload, { mode: 0o600 });
  }
}

export function deleteConfigToken(): void {
  if (existsSync(CONFIG_FILE)) {
    const empty: AppConfig = { githubToken: "", createdAt: "" };
    saveConfig(empty);
  }
}

export function ensureWorkspacesDir(): void {
  if (!existsSync(WORKSPACES_DIR)) {
    mkdirSync(WORKSPACES_DIR, { recursive: true, ...(IS_WINDOWS ? {} : { mode: 0o700 }) });
  }
}
