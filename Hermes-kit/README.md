# Hermes-kit

Kumpulan berkas acuan (epistemik) untuk menyiapkan Hermes Agent di mesin lain supaya perilakunya konsisten dengan yang berjalan di server ini.

Folder ini **bukan** kode yang dieksekusi bot. Isinya salinan konfigurasi acuan yang dipakai Hermes saat ini, disimpan di source bot agar tidak hilang ketika instalasi Hermes di-install ulang atau dipindah.

## Isi

| Berkas | Asal (sumber kebenaran) | Fungsi |
|---|---|---|
| `SOUL.md` | `~/.hermes/SOUL.md` | Instruksi sistem Hermes: aturan environment VPS, daftar MCP + kapan dipakai, aturan sitasi, dan kebijakan security review default |

## Status salinan

```text
sha256  SOUL.md : b96272c9d58d3eb63db3783dcf626f76f56117f562dd49bfbd80d241446f2e29
ukuran          : 26.363 byte / 195 baris
disalin dari    : /root/.hermes/SOUL.md
```

Kalau `~/.hermes/SOUL.md` diubah, salinan di sini **harus** ikut diperbarui, kalau tidak acuan setup jadi menyesatkan. Cara cek cepat:

```bash
sha256sum ~/.hermes/SOUL.md /LlamaAgentHermes/Hermes-kit/SOUL.md
```

Kalau hash-nya beda, sinkronkan:

```bash
cp -a ~/.hermes/SOUL.md /LlamaAgentHermes/Hermes-kit/SOUL.md
```

## Cara pakai di mesin baru

```bash
# 1. Pastikan Hermes sudah terpasang dan $HERMES_HOME diketahui
#    (default: ~/.hermes)
hermes --version

# 2. Pasang SOUL.md
cp /path/ke/LlamaAgentHermes/Hermes-kit/SOUL.md "$HOME/.hermes/SOUL.md"

# 3. Sesuaikan bagian yang bergantung pada mesin ini:
#    - path MCP server (/LlamaAgentHermes/..., /root/.local/bin/...)
#    - path venv Python yang punya paket mcp
#    - nama proses PM2 dan port (5680 bridge, 5685 control API, 8888 hexstrike)
#    - path token (/LlamaAgentHermes/control/control_token)

# 4. Verifikasi MCP setelah disesuaikan
hermes mcp test wa_control
```

## Yang perlu diperhatikan

- `SOUL.md` mengasumsikan MCP `wa_control` dan plugin `wa_media` sudah terdaftar. Tanpa pendaftaran, instruksi di dalamnya menunjuk ke tool yang tidak ada. Prosedur lengkap ada di `README.md` root, bagian 10.
- Berkas ini tidak memuat kredensial. Token control API tetap di `control/control_token` (mode `0600`) dan tidak pernah disalin ke sini.
- Jangan mengedit `SOUL.md` langsung di folder ini. Ubah di `~/.hermes/SOUL.md` (sumber kebenaran), lalu salin ulang.
