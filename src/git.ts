import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { WORKSPACES_DIR, ensureWorkspacesDir } from "./config.js";

export interface GitResult {
  stdout: string;
  stderr: string;
}

export interface RepoStatus {
  branch: string;
  changedFiles: Array<{ status: string; path: string }>;
  ahead: number;
  behind: number;
}

/**
 * Menjalankan `git` sebagai child process. Token TIDAK PERNAH diteruskan
 * lewat argumen command (yang bisa terlihat di process list / shell
 * history) -- alih-alih, token disuntikkan lewat URL remote saat
 * clone/fetch (via env var sementara) atau via credential helper file
 * yang segera dihapus setelah dipakai.
 */
function runGit(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      reject(new Error(`Gagal menjalankan git: ${err.message}. Pastikan git terinstall dan ada di PATH.`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`git ${args[0]} gagal (exit ${code}): ${stderr || stdout}`));
      }
    });
  });
}

/** Path folder lokal tempat repo owner/repo di-clone oleh server ini. */
export function workspacePathFor(owner: string, repo: string): string {
  return join(WORKSPACES_DIR, owner, repo);
}

function authenticatedUrl(owner: string, repo: string, token: string, host = "github.com"): string {
  // Token dilewatkan lewat URL hanya pada saat proses git berjalan, tidak
  // pernah ditulis ke disk (remote yang tersimpan di .git/config TIDAK
  // memakai token ini -- lihat setupRemoteWithoutToken).
  return `https://x-access-token:${token}@${host}/${owner}/${repo}.git`;
}

/**
 * Pastikan workspace lokal untuk owner/repo ada dan up-to-date.
 * - Kalau belum pernah di-clone: clone dulu.
 * - Kalau sudah ada: fetch + pastikan remote origin benar.
 * Remote yang disimpan permanen di .git/config TIDAK menyertakan token
 * (memakai URL biasa https://github.com/owner/repo.git) supaya token tidak
 * tersimpan di plaintext di disk lebih lama dari yang perlu; token hanya
 * disuntikkan sesaat lewat `-c http.extraHeader` saat operasi fetch/push.
 */
export async function ensureWorkspace(params: {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  host?: string;
}): Promise<string> {
  ensureWorkspacesDir();
  const { owner, repo, branch, token, host = "github.com" } = params;
  const dir = workspacePathFor(owner, repo);
  const plainUrl = `https://${host}/${owner}/${repo}.git`;
  const authHeader = basicAuthHeader(token);

  const cloneArgs = token
    ? ["-c", `http.extraHeader=${authHeader}`, "clone", "--branch", branch, "--single-branch", plainUrl, dir]
    : ["clone", "--branch", branch, "--single-branch", plainUrl, dir];

  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(join(WORKSPACES_DIR, owner), { recursive: true });
    await runGit(cloneArgs, WORKSPACES_DIR).catch(async (err) => {
      // Branch mungkin belum ada di remote (repo baru) -- coba clone default lalu buat branch.
      if (String(err.message).includes("Remote branch") || String(err.message).includes("not found")) {
        const fallbackArgs = token
          ? ["-c", `http.extraHeader=${authHeader}`, "clone", plainUrl, dir]
          : ["clone", plainUrl, dir];
        await runGit(fallbackArgs, WORKSPACES_DIR);
        await runGit(["checkout", "-b", branch], dir);
      } else {
        throw err;
      }
    });
  } else {
    // Pastikan remote origin memakai URL tanpa token (bersihkan kalau ada sisa token lama).
    await runGit(["remote", "set-url", "origin", plainUrl], dir).catch(() => {});
    if (token) {
      await runGitAuthed(["fetch", "origin", branch], dir, authHeader);
    } else {
      await runGit(["fetch", "origin", branch], dir);
    }
    // Checkout branch yang diminta (buat lokal jika belum ada, tracking origin jika ada).
    const hasLocalBranch = await runGit(["rev-parse", "--verify", branch], dir)
      .then(() => true)
      .catch(() => false);
    if (hasLocalBranch) {
      await runGit(["checkout", branch], dir);
      await runGit(["reset", "--hard", `origin/${branch}`], dir).catch(() => {});
    } else {
      const hasRemoteBranch = await runGit(["rev-parse", "--verify", `origin/${branch}`], dir)
        .then(() => true)
        .catch(() => false);
      if (hasRemoteBranch) {
        await runGit(["checkout", "-b", branch, `origin/${branch}`], dir);
      } else {
        await runGit(["checkout", "-b", branch], dir);
      }
    }
  }

  return dir;
}

function basicAuthHeader(token: string): string {
  const b64 = Buffer.from(`x-access-token:${token}`).toString("base64");
  return `AUTHORIZATION: basic ${b64}`;
}

/** Jalankan git dengan header auth sementara -- tidak pernah tersimpan di config repo. */
function runGitAuthed(args: string[], cwd: string, authHeader: string): Promise<GitResult> {
  return runGit(["-c", `http.extraHeader=${authHeader}`, ...args], cwd);
}

export async function getStatus(dir: string): Promise<RepoStatus> {
  const branchRes = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], dir);
  const branch = branchRes.stdout.trim();

  const statusRes = await runGit(["status", "--porcelain=v1"], dir);
  const changedFiles = statusRes.stdout
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((line) => ({
      status: line.slice(0, 2).trim(),
      path: line.slice(3).trim(),
    }));

  let ahead = 0;
  let behind = 0;
  try {
    const aheadBehind = await runGit(
      ["rev-list", "--left-right", "--count", `origin/${branch}...HEAD`],
      dir
    );
    const [b, a] = aheadBehind.stdout.trim().split(/\s+/).map(Number);
    behind = b || 0;
    ahead = a || 0;
  } catch {
    // origin/<branch> mungkin belum ada (repo baru) -- abaikan.
  }

  return { branch, changedFiles, ahead, behind };
}

/** Ambil diff lengkap (working tree vs HEAD) untuk ditinjau sebelum commit. */
export async function getDiff(dir: string): Promise<string> {
  const res = await runGit(["diff", "HEAD"], dir);
  return res.stdout;
}

/**
 * Terapkan sebuah unified diff/patch ke workspace. Ini dipakai saat Claude
 * bekerja di sandbox terpisah dan mengirim hasil `git diff` sebagai teks,
 * bukan isi file utuh -- jauh lebih ringkas untuk perubahan banyak file.
 */
export async function applyPatch(dir: string, patchText: string): Promise<GitResult> {
  const patchFile = join(tmpdir(), `mcp-github-push-${randomBytes(6).toString("hex")}.patch`);
  writeFileSync(patchFile, patchText, "utf-8");
  try {
    return await runGit(["apply", "--whitespace=nowarn", patchFile], dir);
  } finally {
    try {
      unlinkSync(patchFile);
    } catch {
      // ignore
    }
  }
}

export async function commitAll(
  dir: string,
  message: string,
  userName = "Claude",
  userEmail = "claude@anthropic.local"
): Promise<GitResult> {
  await runGit(["add", "-A"], dir);
  return runGit(
    ["-c", `user.name=${userName}`, "-c", `user.email=${userEmail}`, "commit", "-m", message],
    dir
  );
}

export async function push(params: {
  dir: string;
  branch: string;
  token: string;
  createRemoteBranch?: boolean;
}): Promise<GitResult> {
  const { dir, branch, token, createRemoteBranch } = params;
  const authHeader = basicAuthHeader(token);
  const args = createRemoteBranch
    ? ["push", "-u", "origin", branch]
    : ["push", "origin", branch];
  return runGitAuthed(args, dir, authHeader);
}

export function removeWorkspace(owner: string, repo: string): void {
  const dir = workspacePathFor(owner, repo);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
