#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { saveConfig, getConfigPath, configExists, loadConfig, deleteConfigToken } from "../dist/config.js";
import { GitHubPusher } from "../dist/github.js";
// server.js self-guards on process.argv[2] === "start" (see src/server.ts),
// so importing it statically here is safe for all other commands.
import "../dist/server.js";

const command = process.argv[2];

async function promptHidden(question) {
  // Input token disembunyikan dari layar terminal (mirip prompt password).
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout });
    stdout.write(question);
    const onData = (char) => {
      char = char.toString();
      if (char === "\n" || char === "\r" || char === "\u0004") {
        stdin.removeListener("data", onData);
      }
    };
    stdin.on("data", onData);
    // @ts-ignore - _writeToOutput dipakai untuk menyembunyikan echo
    rl._writeToOutput = function (stringToWrite) {
      if (rl.line.length === 0 || stringToWrite.trim().length === 0 || stringToWrite === "\n") {
        rl.output.write(stringToWrite);
      } else {
        rl.output.write("*");
      }
    };
    rl.question("", (answer) => {
      rl.close();
      stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

async function checkGitInstalled() {
  const { spawn } = await import("node:child_process");
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

  console.log("Buat Personal Access Token (PAT) di:");
  console.log("  https://github.com/settings/tokens?type=beta");
  console.log('Scope minimal: "Contents" (read & write) pada repo yang ingin dipakai.\n');

  const rl = createInterface({ input: stdin, output: stdout });
  const host = await rl.question(
    "GitHub host [kosongkan untuk github.com, isi jika pakai GitHub Enterprise]: "
  );
  rl.close();

  const token = await promptHidden("Masukkan GitHub Personal Access Token: ");
  if (!token) {
    console.error("Token kosong, setup dibatalkan.");
    process.exit(1);
  }

  console.log("\nMemverifikasi token...");
  try {
    const baseUrl = host.trim() ? `https://${host.trim()}/api/v3` : undefined;
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
    console.log("\nSetup selesai. Sekarang tambahkan MCP server ini ke config client kamu, contoh:");
    console.log(`
{
  "mcpServers": {
    "github-push": {
      "command": "npx",
      "args": ["-y", "@kintil555/mcp-github-push", "start"]
    }
  }
}
`);
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
