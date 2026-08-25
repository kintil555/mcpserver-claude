# mcp-github-push

MCP server ringan yang memberi Claude (atau MCP client lain) kemampuan **push project langsung ke GitHub**, tanpa `git clone`/`git pull` di komputer kamu. Dibuat sebagai alternatif connector GitHub yang lebih hemat token dan tidak memenuhi storage lokal.

Berbentuk **CLI terminal** — install lewat npm, setup token sekali, lalu daftarkan ke MCP client kamu.

## Kenapa ini beda dari connector GitHub bawaan?

- **Tidak clone repo ke disk.** Semua operasi lewat GitHub REST/Git Data API langsung, jadi tidak makan storage lokal.
- **Satu commit untuk banyak file.** Pakai Git Data API (blob → tree → commit → ref) supaya perubahan banyak file jadi satu commit rapi, bukan spam commit per file.
- **Wajib konfirmasi sebelum push.** Ada tool `github_preview_push` yang harus dipanggil lebih dulu untuk menampilkan ringkasan perubahan; `github_push_confirmed` hanya boleh dipanggil setelah user menyetujui secara eksplisit.
- **Token disimpan lokal, aman.** File config permission `600`, hanya bisa dibaca oleh user pemilik.

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
| `github_whoami` | Cek token valid & lihat scope |
| `github_repo_exists` | Cek apakah repo ada |
| `github_create_repo` | Buat repo baru |
| `github_read_file` | Baca isi file dari repo |
| `github_preview_push` | **Preview** perubahan sebelum push (tidak mengubah apa pun) |
| `github_push_confirmed` | Push sungguhan — hanya jalan setelah user setuju |

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

## Keamanan

- Token disimpan di `~/.config/mcp-github-push/config.json` dengan permission `600`.
- Gunakan **fine-grained PAT** yang dibatasi ke repo tertentu, bukan classic token dengan akses penuh.
- Set masa berlaku token dan rotasi berkala.
- `github_push_confirmed` didesain agar model AI tidak bisa push tanpa parameter `confirmed: true` — pastikan MCP client kamu juga menampilkan tool call untuk ditinjau user sebelum dieksekusi.

## Lisensi

MIT
