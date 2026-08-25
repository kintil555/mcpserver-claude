# mcp-github-push

MCP server yang berjalan **di komputer kamu sendiri**, menyimpan GitHub PAT secara lokal, dan melakukan **`git clone`/`commit`/`push` sungguhan** lewat `git` CLI asli — bukan lewat REST API yang mengharuskan isi setiap file diketik ulang dalam parameter tool call.

Berbentuk **CLI terminal** — install lewat npm, setup token sekali, lalu daftarkan ke MCP client kamu.

## Cara kerja

1. Claude bekerja di sandboxnya sendiri (clone, edit file, dsb).
2. Setelah selesai, Claude menghasilkan **`git diff`** dari perubahannya — teks ringkas, bukan isi file utuh.
3. Diff itu dikirim lewat tool call `git_apply_patch` ke MCP server ini, yang menerapkannya ke **workspace lokalnya sendiri** (clone terpisah, tersimpan di `~/.config/mcp-github-push/workspaces/`).
4. Setelah user meninjau (`git_status` / `git_diff`) dan menyetujui, Claude memanggil `git_push` — server ini yang menjalankan `git commit` + `git push` sungguhan pakai token yang tersimpan di server.

**Token GitHub kamu tidak pernah lewat chat/context Claude** — token hanya ada di file config lokal dan disuntikkan langsung ke proses `git` saat fetch/push.

## Kenapa ini beda dari connector GitHub bawaan?

- **Bukan REST API per file.** Push memakai `git` CLI asli di atas clone lokal, jadi mendukung ratusan file sekaligus lewat satu diff — bukan mengetik ulang isi tiap file dalam parameter JSON.
- **Wajib konfirmasi sebelum push.** `git_push` mensyaratkan parameter `confirmed: true`, yang hanya boleh diisi Claude setelah user menyetujui secara eksplisit di percakapan.
- **Token disimpan lokal, tidak pernah ke chat.** File config permission `600` di POSIX (Linux/macOS); di Windows mengikuti ACL folder user biasa.

## Instalasi

### Opsi A — Tanpa Node.js (executable siap pakai)

Tidak perlu install Node.js sama sekali. Download binary sesuai OS kamu dari [halaman Releases](https://github.com/kintil555/mcpserver-claude/releases/latest):

- Windows: `mcp-github-push-win-x64.exe`
- Linux: `mcp-github-push-linux-x64`
- macOS: `mcp-github-push-macos-x64`

Jalankan dari terminal:

```bash
# Windows (PowerShell/CMD)
mcp-github-push-win-x64.exe setup

# Linux/macOS
chmod +x mcp-github-push-linux-x64
./mcp-github-push-linux-x64 setup
```

Lalu daftarkan **path lengkap ke file exe** di config MCP client:

```json
{
  "mcpServers": {
    "github-push": {
      "command": "C:\\path\\ke\\mcp-github-push-win-x64.exe",
      "args": ["start"]
    }
  }
}
```

### Opsi B — Lewat npm (butuh Node.js 18+)

```bash
npx @kintil555/mcp-github-push setup
```

Ikuti instruksi:
1. Buat [Personal Access Token](https://github.com/settings/tokens?type=beta) (fine-grained direkomendasikan) dengan scope **Contents: Read and write** untuk repo yang ingin dipakai.
2. Tempel token saat diminta (input disamarkan di terminal).
3. Token diverifikasi otomatis dan disimpan di `~/.config/mcp-github-push/config.json`.

## Daftarkan ke MCP client

Tambahkan ke config MCP client kamu (mis. Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "github-push": {
      "command": "npx",
      "args": ["-y", "@kintil555/mcp-github-push", "start"]
    }
  }
}
```

Restart client-nya. Tools yang tersedia untuk Claude:

| Tool | Fungsi |
|---|---|
| `github_whoami` | Cek token valid & lihat username |
| `git_sync_workspace` | Clone (kalau belum ada) atau fetch+checkout branch terbaru ke workspace lokal |
| `git_apply_patch` | Terapkan unified diff (dari `git diff` di sandbox Claude) ke workspace lokal |
| `git_status` | Lihat ringkasan file yang berubah, belum di-commit |
| `git_diff` | Lihat detail diff lengkap di workspace lokal |
| `git_push` | Commit + push sungguhan — hanya jalan setelah user setuju (`confirmed: true`) |
| `git_discard_workspace` | Hapus workspace lokal (mis. untuk clone ulang dari awal) |

## Perintah CLI lain

```bash
npx @kintil555/mcp-github-push status   # cek token masih valid
npx @kintil555/mcp-github-push logout   # hapus token tersimpan
```

## Build dari source

```bash
git clone https://github.com/kintil555/mcp-github-push.git
cd mcp-github-push
npm install
npm run build
```

CI di GitHub Actions otomatis build & type-check tiap push/PR ke `main`, dan publish ke npm saat rilis tag baru dibuat.

## Prasyarat

- **`git` CLI harus terinstall** dan ada di PATH (server ini menjalankan `git` sungguhan, bukan REST API). Cek dengan `git --version`. Kalau belum ada: [git-scm.com/downloads](https://git-scm.com/downloads).

## Keamanan

- Token disimpan di `~/.config/mcp-github-push/config.json`. Permission `600` diterapkan di Linux/macOS; di Windows mengandalkan permission folder user default (NTFS ACL), bukan `chmod` Unix.
- Token **tidak pernah** ditulis ke `.git/config` di workspace lokal — hanya disuntikkan sesaat ke proses `git` lewat header HTTP sementara saat fetch/push.
- Gunakan **fine-grained PAT** yang dibatasi ke repo tertentu, bukan classic token dengan akses penuh.
- Set masa berlaku token dan rotasi berkala.
- `git_push` mensyaratkan parameter `confirmed: true` — pastikan MCP client kamu menampilkan tool call untuk ditinjau user sebelum dieksekusi.

## Lisensi

MIT
