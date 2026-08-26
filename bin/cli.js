#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { saveConfig, getConfigPath, configExists, loadConfig, deleteConfigToken } from "../dist/config.js";
import { GitHubPusher } from "../dist/github.js";
// server.js self-guards on process.argv[2] === "start" (see src/server.ts),
// so importing it statically here is safe for all other commands.
import "../dist/server.js";

const command = process.argv[2];

/**
 * Prompt dengan echo disamarkan jadi '*', memakai SATU readline interface
 * yang sama dengan prompt lain di setup ini (dilewatkan sebagai argumen).
 *
 * Versi sebelumnya membuat readline interface terpisah untuk prompt host,
 * lalu me-listen stdin secara manual untuk prompt token setelahnya. Dua
 * consumer stdin yang berbeda itu saling rebutan: readline.question() bisa
 * membuffer lebih banyak data dari stdin daripada yang dipakainya sendiri,
 * sehingga sisa input (baris token) tidak pernah sampai ke listener manual
 * setelahnya -- proses jadi macet menunggu input yang sebenarnya sudah
 * "termakan". Sekarang seluruh prompt di satu alur setup memakai SATU
 * readline interface yang sama, jadi tidak ada data yang hilang di antara
 * prompt satu dengan berikutnya.
 */
async function questionHidden(rl, question) {
  const original = rl._writeToOutput?.bind(rl);
  rl._writeToOutput = (stringToWrite) => {
    // Saat user mengetik/paste, readline memanggil ini per karakter (atau
    // per chunk saat paste) -- tampilkan '*' sebagai gantinya. Prompt teks
    // itu sendiri dan newline tetap ditulis apa adanya.
    if (stringToWrite === question || stringToWrite === "\n" || stringToWrite === "\r\n") {
      rl.output.write(stringToWrite);
    } else {
      rl.output.write("*".repeat(stringToWrite.length));
    }
  };
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    // Selalu kembalikan ke perilaku normal, supaya prompt berikutnya (kalau
    // ada) di readline yang sama tidak ikut ter-mask.
    if (original) {
      rl._writeToOutput = original;
    } else {
      delete rl._writeToOutput;
    }
  }
}

/**
 * Path config Claude Desktop per-OS. Dipakai untuk auto-registrasi MCP server
 * ini setelah setup selesai, supaya tidak ada langkah copy-paste JSON manual
 * yang gampang salah/hilang (root cause paling umum dari "MCP Error saat
 * launching": path/command di config ini nunjuk ke file yang sudah
 * pindah/hilang).
 *
 * Beberapa instalasi (build custom/modded, mis. folder "Claude-modified")
 * memakai nama folder berbeda dari default "Claude". Kita cek semua kandidat
 * yang punya claude_desktop_config.json dan pakai yang pertama ketemu; kalau
 * tidak ada satu pun yang ada, fallback ke path default "Claude" (dibuat baru).
 */
function getClaudeDesktopConfigPath() {
  const os = platform();
  let baseDir;
  if (os === "win32") {
    baseDir = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  } else if (os === "darwin") {
    baseDir = join(homedir(), "Library", "Application Support");
  } else {
    baseDir = join(homedir(), ".config");
  }

  const candidateFolders = ["Claude", "Claude-modified"];
  for (const folder of candidateFolders) {
    const candidate = join(baseDir, folder, "claude_desktop_config.json");
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  // Tidak ada satu pun ditemukan -- default ke "Claude" (akan dibuat baru).
  return join(baseDir, "Claude", "claude_desktop_config.json");
}

/**
 * Deteksi apakah proses ini berjalan sebagai .exe standalone (pkg) atau
 * lewat `node bin/cli.js`. pkg menyuntikkan process.pkg saat runtime.
 */
function isStandaloneExe() {
  return Boolean(process.pkg);
}

/**
 * Tulis/merge entry MCP server ini ke claude_desktop_config.json, memakai
 * command yang BENAR-BENAR jalan di komputer ini saat ini -- bukan yang
 * diketik manual oleh user. Ini yang mencegah kasus seperti di log: exe
 * dipindah ke Downloads lalu di-rename/dihapus, config lama tetap menunjuk
 * path mati, dan client melempar ENOENT setiap start.
 */
async function writeClaudeDesktopConfig() {
  const configPath = getClaudeDesktopConfigPath();
  let entry;
  if (isStandaloneExe()) {
    // process.execPath == path exe standalone ini sendiri saat ini berjalan.
    entry = { command: process.execPath, args: ["start"] };
  } else {
    entry = { command: "npx", args: ["-y", "@kintil555/mcp-github-push", "start"] };
  }

  let existing = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      console.warn(`\nPeringatan: ${configPath} ada tapi bukan JSON valid -- dilewati, tidak ditimpa.`);
      return null;
    }
  }
  existing.mcpServers = existing.mcpServers || {};
  existing.mcpServers["github-push"] = entry;

  const dir = join(configPath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(existing, null, 2), "utf-8");
  return { configPath, entry };
}

async function checkGitInstalled() {
  return new Promise((resolve) => {
    const child = spawn("git", ["--version"], { windowsHide: true });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function runSetup() {
  console.log("=== Setup mcp-github-push ===\n");

  const hasGit = await checkGitInstalled();
  if (!hasGit) {
    console.error(
      "git tidak ditemukan di PATH. Server ini butuh git CLI terinstall untuk clone/commit/push.\n" +
        "Install dulu dari https://git-scm.com/downloads lalu jalankan setup ini lagi."
    );
    process.exit(1);
  }

  // GitHub Enterprise host dilewatkan sebagai flag opsional (--host=github.mycompany.com),
  // BUKAN pertanyaan interaktif terpisah. Node readline (mode question/promise) punya
  // keterbatasan dikonfirmasi: rl.question() pertama bisa mengonsumsi seluruh buffer
  // stdin, sehingga rl.question() kedua tidak pernah menerima input -- proses macet
  // menunggu token yang sebenarnya sudah "termakan" oleh prompt sebelumnya
  // (nodejs/node#56608). Dengan hanya SATU rl.question() (untuk token), masalah ini
  // dihindari sepenuhnya, dan tetap didukung 100% untuk kasus paling umum (github.com).
  const hostArg = process.argv.find((a) => a.startsWith("--host="));
  const host = hostArg ? hostArg.slice("--host=".length).trim() : "";
  if (host) {
    console.log(`Menggunakan GitHub host: ${host}`);
  }

  console.log("Buat Personal Access Token (PAT) di:");
  console.log("  https://github.com/settings/tokens?type=beta");
  console.log('Scope minimal: "Contents" (read & write) pada repo yang ingin dipakai.\n');
  if (!host) {
    console.log("(Pakai GitHub Enterprise? Batalkan dengan Ctrl+C, lalu jalankan ulang dengan:");
    console.log("  mcp-github-push setup --host=github.mycompany.com)\n");
  }

  const rl = createInterface({ input: stdin, output: stdout });
  let token;
  try {
    token = await questionHidden(rl, "Masukkan GitHub Personal Access Token: ");
  } finally {
    rl.close();
  }

  if (!token) {
    console.error("Token kosong, setup dibatalkan.");
    process.exit(1);
  }

  console.log("\nMemverifikasi token...");
  try {
    const baseUrl = host ? `https://${host}/api/v3` : undefined;
    const pusher = new GitHubPusher(token, baseUrl);
    const info = await pusher.whoAmI();
    console.log(`Token valid. Login sebagai: ${info.login}`);
    console.log(`Scope: ${info.scopes.join(", ") || "(fine-grained token, scope tidak muncul di header)"}`);

    try {
      saveConfig({
        githubToken: token,
        githubHost: baseUrl,
        createdAt: new Date().toISOString(),
      });
    } catch (saveErr) {
      console.error(`\nGagal menyimpan config ke ${getConfigPath()}: ${saveErr.message}`);
      console.error("Cek apakah folder di atas bisa ditulis (permission) lalu coba lagi.");
      process.exit(1);
    }

    // Verifikasi tersimpan dengan baca ulang -- supaya user tahu pasti kalau ada masalah.
    const reloaded = loadConfig();
    if (reloaded.githubToken !== token) {
      console.error(`\nConfig tersimpan tapi isinya tidak sesuai saat dibaca ulang. Coba jalankan setup lagi.`);
      process.exit(1);
    }

    console.log(`\nToken tersimpan & terverifikasi di: ${getConfigPath()}`);

    const claudeConfigPath = getClaudeDesktopConfigPath();
    const rl2 = createInterface({ input: stdin, output: stdout });
    let doWrite;
    try {
      const ans = await rl2.question(
        `\nDaftarkan otomatis ke Claude Desktop (${claudeConfigPath})? [Y/n] `
      );
      doWrite = ans.trim().toLowerCase() !== "n";
    } finally {
      rl2.close();
    }

    if (doWrite) {
      try {
        const result = await writeClaudeDesktopConfig();
        if (result) {
          console.log(`\nTerdaftar di ${result.configPath}:`);
          console.log(JSON.stringify({ "github-push": result.entry }, null, 2));
          console.log("\nRestart Claude Desktop supaya perubahan kebaca.");
        }
      } catch (writeErr) {
        console.error(`\nGagal menulis config otomatis: ${writeErr.message}`);
        console.log("Tambahkan manual, contoh:");
        console.log(`
{
  "mcpServers": {
    "github-push": {
      "command": "${isStandaloneExe() ? process.execPath.replace(/\\/g, "\\\\") : "npx"}",
      "args": ${isStandaloneExe() ? '["start"]' : '["-y", "@kintil555/mcp-github-push", "start"]'}
    }
  }
}
`);
      }
    } else {
      console.log("\nLewati. Tambahkan manual ke config client kamu, contoh:");
      console.log(`
{
  "mcpServers": {
    "github-push": {
      "command": "${isStandaloneExe() ? process.execPath.replace(/\\/g, "\\\\") : "npx"}",
      "args": ${isStandaloneExe() ? '["start"]' : '["-y", "@kintil555/mcp-github-push", "start"]'}
    }
  }
}
`);
    }
  } catch (err) {
    console.error(`\nGagal verifikasi token: ${err.message}`);
    console.error("Pastikan token valid dan punya akses ke repo yang dituju.");
    process.exit(1);
  }
}

async function runStatus() {
  if (!configExists()) {
    console.log("Belum ada config. Jalankan: npx @kintil555/mcp-github-push setup");
    return;
  }
  const cfg = loadConfig();
  console.log(`Config: ${getConfigPath()}`);
  console.log(`Host: ${cfg.githubHost ?? "github.com"}`);
  if (!cfg.githubToken) {
    console.log("Token: (kosong / sudah dihapus)");
    return;
  }
  try {
    const pusher = new GitHubPusher(cfg.githubToken, cfg.githubHost);
    const info = await pusher.whoAmI();
    console.log(`Status: OK — login sebagai ${info.login}`);
  } catch (err) {
    console.log(`Status: token tidak valid (${err.message})`);
  }

  const claudeConfigPath = getClaudeDesktopConfigPath();
  if (existsSync(claudeConfigPath)) {
    try {
      const parsed = JSON.parse(readFileSync(claudeConfigPath, "utf-8"));
      const entry = parsed.mcpServers?.["github-push"];
      if (!entry) {
        console.log(`\nBelum terdaftar di ${claudeConfigPath}. Jalankan "setup" untuk mendaftarkan.`);
        return;
      }
      if (entry.command !== "npx" && !existsSync(entry.command)) {
        console.log(`\nPeringatan: command terdaftar (${entry.command}) TIDAK ditemukan di disk.`);
        console.log('Ini penyebab paling umum "MCP Error saat launching". Jalankan "setup" lagi untuk memperbaiki.');
      } else {
        console.log(`\nRegistrasi Claude Desktop OK: ${entry.command} ${entry.args?.join(" ") ?? ""}`);
      }
    } catch {
      console.log(`\nPeringatan: ${claudeConfigPath} bukan JSON valid.`);
    }
  }
}

async function runLogout() {
  if (!configExists()) {
    console.log("Tidak ada token tersimpan.");
    return;
  }
  deleteConfigToken();
  console.log(`Token dihapus dari ${getConfigPath()}.`);
}

function printHelp() {
  console.log(`mcp-github-push — MCP server untuk push project ke GitHub tanpa git clone lokal

Perintah:
  setup     Konfigurasi Personal Access Token GitHub (interaktif)
  status    Cek apakah token tersimpan masih valid
  logout    Hapus token yang tersimpan
  start     Jalankan MCP server (dipanggil otomatis oleh MCP client, biasanya tidak perlu manual)

Contoh:
  npx @kintil555/mcp-github-push setup
`);
}

switch (command) {
  case "setup":
    await runSetup();
    break;
  case "status":
    await runStatus();
    break;
  case "logout":
    await runLogout();
    break;
  case "start":
    // server.js sudah auto-start via guard di dalamnya (argv[2] === "start")
    // begitu di-import di atas.
    break;
  default:
    printHelp();
    break;
}
