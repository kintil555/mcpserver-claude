#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import {
  ensureWorkspace,
  getStatus,
  getDiff,
  applyPatch,
  commitAll,
  push,
  workspacePathFor,
  removeWorkspace,
} from "./git.js";
import { GitHubPusher } from "./github.js";

// --- Skema input tiap tool -------------------------------------------------

const RepoRefSchema = z.object({
  owner: z.string().describe("Pemilik repo (username/org GitHub)"),
  repo: z.string().describe("Nama repo"),
  branch: z.string().default("main").describe("Branch kerja"),
});

const ApplyPatchSchema = RepoRefSchema.extend({
  patch: z
    .string()
    .describe(
      "Isi unified diff (hasil `git diff` dari sandbox Claude). Bisa mencakup banyak file sekaligus."
    ),
});

const PushSchema = RepoRefSchema.extend({
  commitMessage: z.string().describe("Pesan commit"),
  confirmed: z
    .literal(true)
    .describe("Wajib true — menandakan user sudah menyetujui push ini secara eksplisit"),
});

// --- Server -----------------------------------------------------------------

const server = new Server(
  { name: "mcp-github-push", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

function getToken(): { token: string; host?: string } {
  const cfg = loadConfig();
  return { token: cfg.githubToken, host: cfg.githubHost };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "git_sync_workspace",
      description:
        "Siapkan workspace lokal untuk owner/repo (clone kalau belum ada, atau fetch + checkout " +
        "branch terbaru kalau sudah ada). Panggil ini SEBELUM git_apply_patch, supaya workspace " +
        "server ini punya salinan repo yang sinkron dengan remote sebelum patch diterapkan.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          branch: { type: "string" },
        },
        required: ["owner", "repo"],
      },
    },
    {
      name: "git_apply_patch",
      description:
        "Terapkan unified diff (hasil `git diff` yang dihasilkan Claude di sandboxnya sendiri) ke " +
        "workspace lokal server ini. Jauh lebih ringkas daripada mengirim isi file utuh satu-satu, " +
        "terutama untuk perubahan banyak file. Panggil git_sync_workspace dulu sebelum ini.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          branch: { type: "string" },
          patch: { type: "string" },
        },
        required: ["owner", "repo", "patch"],
      },
    },
    {
      name: "git_status",
      description:
        "Lihat ringkasan perubahan yang sudah diterapkan ke workspace lokal (file apa saja yang " +
        "berubah/ditambah/dihapus), belum di-commit atau di-push. Gunakan untuk verifikasi sebelum push.",
      inputSchema: {
        type: "object",
        properties: { owner: { type: "string" }, repo: { type: "string" } },
        required: ["owner", "repo"],
      },
    },
    {
      name: "git_diff",
      description:
        "Tampilkan diff lengkap (working tree vs HEAD) di workspace lokal. Gunakan untuk preview " +
        "detail perubahan sebelum push.",
      inputSchema: {
        type: "object",
        properties: { owner: { type: "string" }, repo: { type: "string" } },
        required: ["owner", "repo"],
      },
    },
    {
      name: "git_push",
      description:
        "Commit semua perubahan di workspace lokal lalu push ke GitHub menggunakan token yang " +
        "tersimpan di server ini (token TIDAK PERNAH dikirim lewat chat/context Claude). " +
        "HANYA panggil ini SETELAH user secara eksplisit menyetujui perubahan pada giliran " +
        "percakapan ini (lihat git_status/git_diff dulu). Jangan pernah set confirmed=true tanpa " +
        "persetujuan eksplisit dari user.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          branch: { type: "string" },
          commitMessage: { type: "string" },
          confirmed: { type: "boolean" },
        },
        required: ["owner", "repo", "commitMessage", "confirmed"],
      },
    },
    {
      name: "git_discard_workspace",
      description:
        "Hapus workspace lokal untuk owner/repo (mis. kalau ingin clone ulang dari awal karena " +
        "konflik atau state rusak). Ini TIDAK mempengaruhi apa pun di GitHub, hanya folder lokal.",
      inputSchema: {
        type: "object",
        properties: { owner: { type: "string" }, repo: { type: "string" } },
        required: ["owner", "repo"],
      },
    },
    {
      name: "github_whoami",
      description: "Cek token GitHub yang terpasang valid atau tidak, dan tampilkan username.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "git_sync_workspace": {
        const input = RepoRefSchema.parse(args);
        const { token, host } = getToken();
        const dir = await ensureWorkspace({
          owner: input.owner,
          repo: input.repo,
          branch: input.branch,
          token,
          host,
        });
        const status = await getStatus(dir);
        return {
          content: [
            {
              type: "text",
              text:
                `Workspace siap di: ${dir}\n` +
                `Branch: ${status.branch}\n` +
                `Ahead ${status.ahead} / Behind ${status.behind} dari origin.`,
            },
          ],
        };
      }

      case "git_apply_patch": {
        const input = ApplyPatchSchema.parse(args);
        const dir = workspacePathFor(input.owner, input.repo);
        await applyPatch(dir, input.patch);
        const status = await getStatus(dir);
        return {
          content: [
            {
              type: "text",
              text:
                `Patch diterapkan ke workspace lokal.\n` +
                `File berubah (${status.changedFiles.length}):\n` +
                status.changedFiles.map((f) => `  ${f.status} ${f.path}`).join("\n") +
                `\n\nBelum di-commit / belum di-push. Tinjau dengan git_diff atau git_status, ` +
                `lalu minta persetujuan user sebelum memanggil git_push.`,
            },
          ],
        };
      }

      case "git_status": {
        const input = RepoRefSchema.parse(args);
        const dir = workspacePathFor(input.owner, input.repo);
        const status = await getStatus(dir);
        return {
          content: [
            {
              type: "text",
              text:
                status.changedFiles.length === 0
                  ? "Tidak ada perubahan yang belum di-commit."
                  : `File berubah (${status.changedFiles.length}):\n` +
                    status.changedFiles.map((f) => `  ${f.status} ${f.path}`).join("\n"),
            },
          ],
        };
      }

      case "git_diff": {
        const input = RepoRefSchema.parse(args);
        const dir = workspacePathFor(input.owner, input.repo);
        const diff = await getDiff(dir);
        return {
          content: [{ type: "text", text: diff || "(tidak ada perubahan)" }],
        };
      }

      case "git_push": {
        const input = PushSchema.parse(args);
        const dir = workspacePathFor(input.owner, input.repo);
        const { token } = getToken();

        const preStatus = await getStatus(dir);
        if (preStatus.changedFiles.length === 0) {
          return {
            content: [{ type: "text", text: "Tidak ada perubahan untuk di-commit/push." }],
          };
        }

        await commitAll(dir, input.commitMessage);
        await push({ dir, branch: input.branch, token, createRemoteBranch: true });

        return {
          content: [
            {
              type: "text",
              text:
                `Push berhasil ke ${input.owner}/${input.repo} (branch: ${input.branch}).\n` +
                `Pesan commit: "${input.commitMessage}"\n` +
                `File yang di-push: ${preStatus.changedFiles.length}`,
            },
          ],
        };
      }

      case "git_discard_workspace": {
        const input = RepoRefSchema.parse(args);
        removeWorkspace(input.owner, input.repo);
        return {
          content: [{ type: "text", text: `Workspace lokal untuk ${input.owner}/${input.repo} dihapus.` }],
        };
      }

      case "github_whoami": {
        const { token, host } = getToken();
        const pusher = new GitHubPusher(token, host);
        const info = await pusher.whoAmI();
        return {
          content: [{ type: "text", text: `Terhubung sebagai: ${info.login}` }],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Tool tidak dikenal: ${name}` }],
          isError: true,
        };
    }
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Error: ${err.message ?? String(err)}` }],
      isError: true,
    };
  }
});

export async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Hanya auto-start saat dijalankan sebagai command "start" dari cli.js
// (yang meng-import file ini secara statis). Guard ini mencegah import
// biasa (mis. tooling/tsc) ikut men-trigger koneksi stdio.
if (process.argv[2] === "start") {
  main().catch((err) => {
    console.error("Fatal error menjalankan MCP server:", err);
    process.exit(1);
  });
}
