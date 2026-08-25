import { Octokit } from "@octokit/rest";

/**
 * Wrapper Octokit minimal -- dipakai HANYA untuk verifikasi token (whoami)
 * saat setup CLI dan operasi metadata ringan (cek/buat repo). Operasi push
 * file yang sesungguhnya sekarang lewat `git` CLI asli (lihat git.ts),
 * bukan lewat REST API, supaya Claude bisa mengirim diff/patch alih-alih
 * isi file utuh.
 */
export class GitHubPusher {
  private octokit: Octokit;

  constructor(token: string, baseUrl?: string) {
    this.octokit = new Octokit({
      auth: token,
      ...(baseUrl ? { baseUrl } : {}),
    });
  }

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
      auto_init: true,
    });
    return res.data;
  }
}
