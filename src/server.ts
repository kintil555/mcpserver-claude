#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { GitHubPusher, type PushFile } from "./github.js";

// --- Skema input tiap tool -------------------------------------------------

const PushFileSchema = z.object({
  path: z.string().describe("Path relatif file dari root repo, mis. 'src/index.ts'"),
  content: z.string().optional().describe("Isi file (wajib kecuali delete=true)"),
  delete: z.boolean().optional().describe("Set true untuk menghapus file ini dari repo"),
});

const PreparePushSchema = z.object({
  owner: z.string().describe("Pemilik repo (username/org GitHub)"),
  repo: z.string().describe("Nama repo"),
  branch: z.string().default("main").describe("Branch tujuan"),
  files: z.array(PushFileSchema).min(1).describe("Daftar file yang akan diubah"),
  commitMessage: z.string().describe("Pesan commit"),
});

const ConfirmPushSchema = PreparePushSchema.extend({
  confirmed: z
    .literal(true)
    .describe("Wajib true — menandakan user sudah menyetujui push ini secara eksplisit"),
  createBranchIfMissing: z.boolean().optional().default(false),
});

const RepoRefSchema = z.object({
  owner: z.string(),
  repo: z.string(),
});

const CreateRepoSchema = z.object({
  name: z.string(),
  private: z.boolean().optional().default(true),
  description: z.string().optional(),
});

const ReadFileSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  path: z.string(),
  ref: z.string().optional(),
});

// --- Server -----------------------------------------------------------------

const server = new Server(
  { name: "mcp-github-push", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

function getPusher(): GitHubPusher {
  const cfg = loadConfig();
  if (!cfg.githubToken) {
    throw new Error(
      "Token GitHub belum di-set. Jalankan `npx @kintil555/mcp-github-push setup` di terminal."
    );
  }
  return new GitHubPusher(cfg.githubToken, cfg.githubHost);
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "github_whoami",
      description:
        "Cek token GitHub yang terpasang valid atau tidak, dan tampilkan username serta scope token.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "github_repo_exists",
      description: "Cek apakah sebuah repository GitHub sudah ada.",
      inputSchema: {
        type: "object",
        properties: { owner: { type: "string" }, repo: { type: "string" } },
        required: ["owner", "repo"],
      },
    },
    {
      name: "github_create_repo",
      description: "Buat repository GitHub baru milik user yang terautentikasi.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          private: { type: "boolean" },
          description: { type: "string" },
        },
        required: ["name"],
      },
    },
    {
      name: "github_read_file",
      description: "Baca isi satu file dari repo GitHub (untuk cek isi sebelum overwrite).",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          path: { type: "string" },
          ref: { type: "string" },
        },
        required: ["owner", "repo", "path"],
      },
    },
    {
      name: "github_preview_push",
      description:
        "WAJIB dipanggil SEBELUM github_push_confirmed. Tampilkan ringkasan perubahan " +
        "(file mana yang akan ditambah/diubah/dihapus, ke repo & branch mana) supaya user bisa " +
        "meninjau dan menyetujui sebelum benar-benar push. Tool ini TIDAK mengubah apa pun di GitHub.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          branch: { type: "string" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" },
                delete: { type: "boolean" },
              },
              required: ["path"],
            },
          },
          commitMessage: { type: "string" },
        },
        required: ["owner", "repo", "files", "commitMessage"],
      },
    },
    {
      name: "github_push_confirmed",
      description:
        "Push satu atau banyak file ke GitHub dalam SATU commit via Git Data API (tanpa git clone lokal). " +
        "HANYA panggil tool ini SETELAH user secara eksplisit menyetujui hasil dari github_preview_push " +
        "pada giliran percakapan ini. Jangan pernah set confirmed=true tanpa persetujuan eksplisit dari user.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          branch: { type: "string" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" },
                delete: { type: "boolean" },
              },
              required: ["path"],
            },
          },
          commitMessage: { type: "string" },
          confirmed: { type: "boolean" },
          createBranchIfMissing: { type: "boolean" },
        },
        required: ["owner", "repo", "files", "commitMessage", "confirmed"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "github_whoami": {
        const pusher = getPusher();
        const info = await pusher.whoAmI();
        return {
          content: [
            {
              type: "text",
              text: `Terhubung sebagai: ${info.login}\nScope token: ${
                info.scopes.join(", ") || "(tidak ada / token classic tanpa scope terbaca)"
              }`,
            },
          ],
        };
      }

      case "github_repo_exists": {
        const { owner, repo } = RepoRefSchema.parse(args);
        const pusher = getPusher();
        const exists = await pusher.repoExists(owner, repo);
        return {
          content: [{ type: "text", text: exists ? "Repo ditemukan." : "Repo tidak ditemukan." }],
        };
      }

      case "github_create_repo": {
        const input = CreateRepoSchema.parse(args);
        const pusher = getPusher();
        const repo = await pusher.createRepo(input.name, {
          private: input.private,
          description: input.description,
        });
        return {
          content: [
            {
              type: "text",
              text: `Repo dibuat: ${repo.full_name}\nURL: ${repo.html_url}\nDefault branch: ${repo.default_branch}`,
            },
          ],
        };
      }

      case "github_read_file": {
        const input = ReadFileSchema.parse(args);
        const pusher = getPusher();
        const content = await pusher.getFileContent(input.owner, input.repo, input.path, input.ref);
        return {
          content: [
            {
              type: "text",
              text: content === null ? "File tidak ditemukan di repo." : content,
            },
          ],
        };
      }

      case "github_preview_push": {
        const input = PreparePushSchema.parse(args);
        const lines = input.files.map((f) =>
          f.delete ? `  - HAPUS: ${f.path}` : `  - TULIS: ${f.path} (${(f.content ?? "").length} karakter)`
        );
        return {
          content: [
            {
              type: "text",
              text:
                `Preview push ke ${input.owner}/${input.repo} (branch: ${input.branch}):\n` +
                `Pesan commit: "${input.commitMessage}"\n` +
                `Perubahan (${input.files.length} file):\n${lines.join("\n")}\n\n` +
                `Ini BARU PREVIEW, belum ada perubahan di GitHub. Tampilkan ringkasan ini ke user dan ` +
                `minta persetujuan eksplisit sebelum memanggil github_push_confirmed.`,
            },
          ],
        };
      }

      case "github_push_confirmed": {
        const input = ConfirmPushSchema.parse(args);
        const pusher = getPusher();
        const files: PushFile[] = input.files.map((f) => ({
          path: f.path,
          content: f.content ?? "",
          delete: f.delete,
        }));
        const result = await pusher.pushFiles({
          owner: input.owner,
          repo: input.repo,
          branch: input.branch,
          files,
          commitMessage: input.commitMessage,
          createBranchIfMissing: input.createBranchIfMissing,
        });
        return {
          content: [
            {
              type: "text",
              text:
                `Push berhasil.\n` +
                `Commit: ${result.commitSha}\n` +
                `URL: ${result.commitUrl}\n` +
                `Branch: ${result.branch}\n` +
                `File berubah: ${result.filesChanged}`,
            },
          ],
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error menjalankan MCP server:", err);
  process.exit(1);
});
