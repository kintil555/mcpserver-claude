import { Octokit } from "@octokit/rest";

export interface PushFile {
  /** Path relatif dari root repo, mis. "src/index.ts" */
  path: string;
  /** Isi file dalam bentuk teks UTF-8 */
  content: string;
  /** Set true jika file ini harus dihapus dari repo */
  delete?: boolean;
}

export interface PushResult {
  commitSha: string;
  commitUrl: string;
  branch: string;
  filesChanged: number;
}

export class GitHubPusher {
  private octokit: Octokit;

  constructor(token: string, baseUrl?: string) {
    this.octokit = new Octokit({
      auth: token,
      ...(baseUrl ? { baseUrl } : {}),
    });
  }

  /** Verifikasi token valid & kembalikan info user login. */
  async whoAmI(): Promise<{ login: string; scopes: string[] }> {
    const res = await this.octokit.rest.users.getAuthenticated();
    const scopesHeader = (res.headers as Record<string, string>)["x-oauth-scopes"] ?? "";
    return {
      login: res.data.login,
      scopes: scopesHeader.split(",").map((s) => s.trim()).filter(Boolean),
    };
  }

  async repoExists(owner: string, repo: string): Promise<boolean> {
    try {
      await this.octokit.rest.repos.get({ owner, repo });
      return true;
    } catch (e: any) {
      if (e.status === 404) return false;
      throw e;
    }
  }

  async createRepo(name: string, opts: { private?: boolean; description?: string } = {}) {
    const res = await this.octokit.rest.repos.createForAuthenticatedUser({
      name,
      private: opts.private ?? true,
      description: opts.description,
      auto_init: true, // supaya branch default & commit awal ada (Git Data API butuh minimal 1 commit)
    });
    return res.data;
  }

  async listBranches(owner: string, repo: string): Promise<string[]> {
    const res = await this.octokit.rest.repos.listBranches({ owner, repo, per_page: 100 });
    return res.data.map((b) => b.name);
  }

  /**
   * Push banyak file (tambah/update/hapus) dalam SATU commit menggunakan Git Data API:
   * blob -> tree -> commit -> update ref.
   */
  async pushFiles(params: {
    owner: string;
    repo: string;
    branch: string;
    files: PushFile[];
    commitMessage: string;
    createBranchIfMissing?: boolean;
  }): Promise<PushResult> {
    const { owner, repo, branch, files, commitMessage } = params;

    if (files.length === 0) {
      throw new Error("Tidak ada file untuk di-push.");
    }

    // 1. Ambil ref branch saat ini (atau buat branch baru dari default branch).
    let baseSha: string;
    try {
      const ref = await this.octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`,
      });
      baseSha = ref.data.object.sha;
    } catch (e: any) {
      if (e.status === 404 && params.createBranchIfMissing) {
        const repoInfo = await this.octokit.rest.repos.get({ owner, repo });
        const defaultBranch = repoInfo.data.default_branch;
        const defaultRef = await this.octokit.rest.git.getRef({
          owner,
          repo,
          ref: `heads/${defaultBranch}`,
        });
        baseSha = defaultRef.data.object.sha;
        await this.octokit.rest.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${branch}`,
          sha: baseSha,
        });
      } else {
        throw new Error(
          `Branch "${branch}" tidak ditemukan di ${owner}/${repo}. ` +
            `Set createBranchIfMissing=true untuk membuatnya otomatis dari default branch.`
        );
      }
    }

    // 2. Ambil base commit -> base tree
    const baseCommit = await this.octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: baseSha,
    });
    const baseTreeSha = baseCommit.data.tree.sha;

    // 3. Buat blob untuk tiap file yang tidak dihapus.
    const treeItems: Array<{
      path: string;
      mode: "100644";
      type: "blob";
      sha: string | null;
    }> = [];

    for (const file of files) {
      if (file.delete) {
        // sha: null menandakan "hapus path ini" di tree API
        treeItems.push({ path: file.path, mode: "100644", type: "blob", sha: null });
        continue;
      }
      const blob = await this.octokit.rest.git.createBlob({
        owner,
        repo,
        content: Buffer.from(file.content, "utf-8").toString("base64"),
        encoding: "base64",
      });
      treeItems.push({ path: file.path, mode: "100644", type: "blob", sha: blob.data.sha });
    }

    // 4. Buat tree baru di atas base tree.
    const newTree = await this.octokit.rest.git.createTree({
      owner,
      repo,
      base_tree: baseTreeSha,
      tree: treeItems as any,
    });

    // 5. Buat commit baru menunjuk ke tree baru + parent = commit lama.
    const newCommit = await this.octokit.rest.git.createCommit({
      owner,
      repo,
      message: commitMessage,
      tree: newTree.data.sha,
      parents: [baseSha],
    });

    // 6. Update ref branch supaya menunjuk ke commit baru (fast-forward push).
    await this.octokit.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: newCommit.data.sha,
    });

    return {
      commitSha: newCommit.data.sha,
      commitUrl: `https://github.com/${owner}/${repo}/commit/${newCommit.data.sha}`,
      branch,
      filesChanged: files.length,
    };
  }

  async getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref?: string
  ): Promise<string | null> {
    try {
      const res = await this.octokit.rest.repos.getContent({ owner, repo, path, ref });
      if (!Array.isArray(res.data) && res.data.type === "file" && res.data.content) {
        return Buffer.from(res.data.content, "base64").toString("utf-8");
      }
      return null;
    } catch (e: any) {
      if (e.status === 404) return null;
      throw e;
    }
  }
}
