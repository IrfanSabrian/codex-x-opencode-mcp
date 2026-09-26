# Codex ↔ OpenCode bridge

Bridge MCP lokal untuk [PRD](../codex-opencode-execution-hub-prd.md). Codex mengirim satu `Execution Brief`; OpenCode 1.18.32 mengerjakan tugas; Codex mengambil `Result Contract`, diff, dan bukti untuk melakukan quality gate.

`opencode_hub` adalah nama konektor MCP yang didaftarkan ke Codex di mesin ini. Ini bukan aplikasi dengan antarmuka tersendiri. Saat tool tersedia di task Codex baru, Codex dapat mengirim brief lewat `opencode_execute`, memantau `opencode_status`, lalu membaca `opencode_result`. Jika hasil perlu diperbaiki, Codex dapat mengirim `opencode_correct` setelah siklus sebelumnya selesai.

## Status saat ini

| Bagian | Kondisi |
| --- | --- |
| Koneksi Codex ↔ OpenCode, tujuh tool MCP, state tugas, Result Contract | Berfungsi dan diuji langsung |
| Jev intake pada OpenCode yang dikelola bridge | Hook OpenCode memanggil Jev sebelum Sisyphus, mengirim kategori/skill/ultrawork, dan menulis bukti rute per siklus. Hub menolak hasil tanpa bukti yang cocok; rute `quick` dan `specialist/ultrabrain` diuji langsung. |
| Koreksi, keputusan, penghentian, serta koneksi MCP yang sudah terpasang | Diimplementasikan dan diuji pada test otomatis; koreksi ditolak saat siklus lama masih berjalan |
| Validasi independen dan pemulihan proses | Bridge menjalankan rencana validasi atau skrip Node yang tersedia untuk berkas berubah; kegagalan menahan hasil. Tugas yang terputus dilanjutkan sekali pada sesi yang sama. Keduanya diuji langsung. |
| Jev Decision and Jev Estimate reporting | Bridge shows the original Jev Decision trace when a route is available. After the final result with no pending decisions, bridge shows one Jev Estimate block with absolute Codex tokens saved and context avoided. |
| Penemuan dan pemasangan MCP baru | Kandidat registry ditandai belum ditinjau. Setelah persetujuan eksplisit untuk kandidat dan versi paket yang tepat, paket npm berversi tetap dapat ditambahkan ke proses OpenCode bridge dan status koneksinya diverifikasi. |
| Paket non-npm, profil dan izin tool per agen, telemetri lanjutan | Belum diimplementasikan. Laporan token/konteks adalah pengukuran awal, bukan seluruh metrik Phase 8. |

Hasil OpenCode masih perlu ditinjau Codex terhadap kriteria tugas. Bila belum memenuhi acceptance criteria, Codex mengirim `opencode_correct` dengan kriteria gagal, bukti, dan pengujian ulang spesifik, lalu mengiterasi sampai selesai; implementasi koreksi tidak dikerjakan langsung di Codex. Uji langsung membuktikan alur baca berkas, rute spesialis dengan tiga review paralel, dan penerimaan kontrak hasil; kualitas semua jenis pekerjaan belum diuji.

### Kesesuaian dengan draw.io

| Halaman alur | Status implementasi |
| --- | --- |
| 01, 04, 05: brief → bridge → intake → hasil | Berjalan melalui tujuh tool MCP, sesi OpenCode, status terpisah, dan Result Contract. |
| 08, 08A, 09: Jev → Sisyphus/OMO | Hook Jev berjalan sebelum giliran OpenCode; rute `quick` dan `specialist/ultrabrain` terbukti lewat sesi nyata. Rute spesialis meluncurkan tiga review OMO paralel. |
| 06, 07: capability hub dan MCP dinamis | Provider yang tersedia dapat dihubungkan dan dilepas. Kandidat baru dapat ditemukan; npm dengan versi tetap bisa dipasang setelah persetujuan kandidat yang tepat. Audit paket lengkap, registry selain npm, dan profil per agen tetap belum ada. |
| 11–14: validasi, hasil, quality gate, koreksi | Bridge menjalankan pemeriksaan independen setelah Result Contract, menahan hasil jika gagal, dan menyimpan buktinya. Correction dan decision loop tersedia. Penilaian kriteria yang memerlukan pertimbangan tetap oleh Codex. |
| 18, 19: batas keamanan dan kontrak bridge | Input divalidasi, server dibatasi ke loopback, auth sementara, hasil besar dibaca sesuai kebutuhan. Sesi dan validasi dapat dipulihkan setelah proses berhenti; isolasi MCP per agen ditunda. |

## Kondisi implementasi

- Tujuh tool: `opencode_execute`, `opencode_status`, `opencode_result`, `opencode_inspect`, `opencode_correct`, `opencode_decision`, `opencode_stop`.
- Kontrak brief, correction, decision, dan result divalidasi dengan Zod. Status dan hasil besar diambil terpisah.
- OpenCode HTTP dipanggil hanya melalui loopback. Secara default bridge menjalankan `opencode serve` 1.18.32 sendiri pada port acak dengan Basic auth sementara. `OPENCODE_BASE_URL` dapat menunjuk server lokal yang sudah berjalan.
- Setiap prompt memakai endpoint `/session/{id}/message` dalam permintaan latar belakang. `opencode_execute` menunggu trace Jev hingga 15 detik, lalu mengembalikan tanda terima beserta trace jika sudah tersedia; `opencode_status` dapat mengirim trace yang belum sempat dikembalikan. Status terus menunjukkan eksekusi sampai Result Contract tersedia.
- Pada proses OpenCode yang dikelola bridge, plugin `bridge/plugin/jev-gate.mjs` memanggil `omoRoute()` dari Jev sebelum pesan diteruskan ke Sisyphus. Bridge menyimpan dan mengembalikan trace `Jev Decision` dari formatter Jev tanpa mengubah tampilannya, selain keputusan ringkas untuk routing. Untuk `quick`, panggilan tool delegasi `task`/`delegate_task` ditolak; untuk rute ultrawork, instruksi meminta orkestrasi OMO. Jev yang gagal menghentikan giliran; hasil tanpa bukti rute sesuai nonce dilaporkan `jev_route_missing`. Rute terverifikasi ditambahkan ke `provenance` Result Contract.
- MCP answers carry the Jev Decision trace as a separate text block exactly as formatted by Jev. When `opencode_result` returns the final result with no pending decisions, that block is followed by the `token_savings.display` block titled `Jev Estimate`, for example `Codex tokens saved: ~1.2k tokens` and `Context avoided: ~5k tokens`. Jev Estimate is a separate operation from Jev Decision and never changes routing. Values under that title come only from a genuine Jev estimate source; without one the bridge reports `Codex tokens saved: unavailable` / `Context avoided: unavailable` instead of inventing numbers or presenting local arithmetic as Jev output. The estimate runs once per parent task final outcome; intermediate cycles, pending decisions, and active tasks produce no estimate. Genuine values are absolute approximate token counts: tokens saved estimates Codex usage avoided by delegating execution, context avoided estimates task/repository context Codex never had to process. Values are marked approximate; context-window capacity is never presented as savings. These metrics are Codex-side context only; OpenCode and Jev token usage stay separate.
- A genuine source is implemented in `src/jev-estimate-source.ts` (`SystemOneJevEstimator`): it asks the existing Jev SystemOne backend dedicated banded estimate questions (tiny/small/medium/large, mapped to the disclosed representatives 500/3k/12k/40k tokens) with only transcript/payload lengths as grounding, never content. It needs no new MCP/plugin, credential, or backend change, but enabling it adds one live SystemOne call per final task, so it stays OFF by default. Proposed activation, pending explicit user approval: set `OPENCODE_HUB_JEV_ESTIMATE=1` in the bridge process environment and restart the bridge. Until then every estimate reports unavailable.
- Plugin Jev dipasang hanya lewat konfigurasi inline pada proses OpenCode yang dikelola bridge. Konfigurasi plugin global termasuk OMO tetap digabung oleh OpenCode. Opsi `OPENCODE_PURE=1` ditolak karena mematikan plugin. OpenCode Desktop biasa tidak memakai gerbang ini.
- Registry memetakan 14 MCP yang teramati saat audit. Capability manager membaca status runtime, menghubungkan provider terpasang yang dibutuhkan, dan melepas koneksi yang dibukanya setelah siklus selesai. Provider yang sudah terhubung sebelum tugas tidak diputus.
- Jika kapabilitas belum tersedia, bridge mencari kandidat di [MCP Registry resmi](https://registry.modelcontextprotocol.io/docs) dan mengembalikan metadata berstatus `unreviewed`. Codex menampilkan kandidat, sumber, versi, dan perintah yang akan dijalankan kepada pengguna. Setelah persetujuan eksplisit, Codex mengulang `opencode_execute` dengan `approved_mcp_installation_keys`; bridge mencari ulang kandidat dan memastikan kuncinya masih cocok dengan capability, server, paket, dan versi yang disetujui.
- Untuk kandidat dengan paket npm dan versi semver tetap, bridge membangun perintah terbatas `npx --yes <paket>@<versi>` lalu mendaftarkannya melalui endpoint MCP dinamis OpenCode. Bridge memeriksa status koneksi sebelum memulai task. Ia tidak menjalankan perintah bebas dari metadata registry. Paket registry lain, versi yang tidak tetap, dan kebutuhan konfigurasi rahasia memerlukan penanganan manual.
- Persetujuan dan konfigurasi MCP yang ditambahkan disimpan tanpa kredensial di `.codex-x-opencode-mcp/mcp-installations.json`. Provider dipasang hanya pada proses OpenCode headless yang dikelola bridge, bukan konfigurasi OpenCode Desktop/global. Koneksi yang dibuka bridge dilepas setelah task selesai; konfigurasi provider yang sudah disetujui tetap tersedia untuk task berikutnya dan dapat didaftarkan ulang setelah proses dimulai ulang.
- State tugas menyimpan ID sesi, permintaan siklus terakhir, rencana/hasil validasi, dan hitungan pemulihan di `.codex-x-opencode-mcp/`; transkrip tetap berada di sesi OpenCode. Direktori state masuk `.gitignore` karena brief bisa berisi konteks sensitif. Bukti Jev termasuk trace format asli disimpan di subdirektori `routes/` dan dapat dipulihkan dari transkrip sesi.
- Setelah Result Contract muncul, bridge menjalankan `validation_plan` jika dicantumkan di brief. Setiap langkah menentukan jenis pemeriksaan, executable, argumen, direktori kerja relatif, dan batas waktu; perintah dijalankan tanpa shell dan direktori kerja harus berada di workspace. Jika tidak ada rencana dan hasil menyebut berkas berubah dalam proyek Node, bridge menjalankan skrip `typecheck`, `lint`, `test`, dan `build` yang tersedia di `package.json` terdekat. Pemeriksaan yang tidak tersedia dicatat sebagai `not_run`; kegagalan menghasilkan `validation_failed` dan bukti untuk `opencode_correct`.
- Saat bridge mulai lagi, tugas aktif yang tersimpan direkonsiliasi dengan sesi OpenCode. Hasil yang sudah ada dipakai tanpa mengirim ulang tugas. Jika belum ada hasil dan sesi diam, bridge mengirim satu permintaan lanjutan pada sesi yang sama dengan instruksi memeriksa pekerjaan yang sudah dilakukan. Validasi yang terputus dijalankan lagi. Pemulihan dibatasi satu percobaan otomatis per siklus.
- Binding aktif Sisyphus, Prometheus, dan Momus memakai Muse Spark 1.3. Proses OpenCode yang dikelola bridge menonaktifkan rute 9router Jev dan memakai rute TypeSafe yang sudah dikonfigurasi.

## Menjalankan

Butuh Node.js 22 atau lebih baru dan OpenCode 1.18.32. Di folder `bridge`:

```powershell
npm ci
npm run build
$env:OPENCODE_WORKSPACE = 'E:\Project\Codex X Opencode MCP'
node dist/index.js
```

`stdout` adalah kanal protokol MCP. Gunakan klien MCP untuk menguji server; jangan mengetik permintaan langsung ke terminal tersebut. Untuk server OpenCode yang sudah berjalan, set `OPENCODE_BASE_URL` dan, jika server memakai Basic auth, `OPENCODE_SERVER_USERNAME` serta `OPENCODE_SERVER_PASSWORD` di lingkungan proses. Jangan menyimpan password dalam config Codex.

Pada mesin ini bridge sudah terdaftar di Codex sebagai `opencode_hub`. Buka task Codex baru agar daftar tool MCP yang baru didaftarkan dimuat.

Jalankan verifikasi dengan `npm test`, `npm run lint`, `npm run build`, dan `npm audit --audit-level=high`. `node scripts/stdio-smoke.mjs` memeriksa handshake dan tujuh tool MCP. `node scripts/live-smoke.mjs` mengirim satu tugas baca berkas ke model OpenCode; `node scripts/interruption-smoke.mjs` menghentikan dan menyalakan ulang server di tengah tugas. Keduanya dapat memakai token provider OpenCode.

## Batas saat ini

- Penemuan kandidat MCP membaca metadata dari registry resmi. Metadata tetap tidak tepercaya dan perlu ditinjau untuk penerbit, lisensi, izin, kredensial, daftar tool, serta dampak filesystem/jaringan sebelum persetujuan. Bridge hanya memasang paket npm dengan versi tetap dan memakai argumen yang dibangun sendiri; paket lain berhenti sebagai usulan manual.
- Untuk kandidat yang didukung, alur persetujuan, pemasangan pada runtime OpenCode, pemeriksaan koneksi, lease, dan pelepasan koneksi sudah diterapkan. Instalasi hanya berlaku di server bridge-managed; installer npm tetap menjalankan kode paket yang dipilih setelah pengguna menyetujui kandidat dan versi.
- Koneksi MCP OpenCode berlaku pada proses server, sehingga lease bridge tidak memberi isolasi tool per agen. Batas izin agen tetap harus ditegakkan oleh konfigurasi OpenCode/OMO.
- Uji langsung rute `specialist/ultrabrain` menghasilkan tiga review OMO paralel dan Result Contract valid. Ini membuktikan satu skenario, bukan jaminan perilaku semua tugas `full`, `specialist`, atau visual.
- Jika `OPENCODE_BASE_URL` menunjuk server OpenCode eksternal, pengelola server harus memasang hook dan menyediakan `OPENCODE_HUB_ROUTE_DIR` agar hub dapat memverifikasi bukti Jev. Tanpa direktori itu, pemeriksaan bukti rute tidak aktif.
- Workspace ditentukan oleh `workspace_root` absolut pada setiap Execution Brief. Bridge memcanonicalize path itu, memastikan directory ada, dan menolak brief tanpa workspace valid sebelum sesi OpenCode dibuat. Semua operasi sesi, capability, validasi, dan recovery task itu berjalan pada workspace tersebut melalui parameter `directory` per request HTTP OpenCode 1.18.32. Record task lama tanpa workspace gagal fail-closed (`workspace_missing`) dan tidak pernah dialihkan ke workspace lain.
- `OPENCODE_WORKSPACE` saat bridge mulai hanya menentukan lokasi state (`.codex-x-opencode-mcp/`) dan scope default; ia bukan lagi penentu workspace task. Untuk proyek lain tidak perlu menjalankan bridge terpisah selama setiap brief membawa `workspace_root` yang benar.
- Pemulihan otomatis memakai sesi dan workspace yang sama. Agen diminta memeriksa state sebelum melanjutkan, tetapi efek samping eksternal yang tidak idempoten tetap memerlukan peninjauan; setelah satu percobaan gagal, tugas meminta koreksi. Lease MCP lama yang hanya ada di memori belum dipulihkan, sejalan dengan penundaan pekerjaan MCP.
- Tugas tanpa Result Contract setelah 30 menit sejak awal siklus dinyatakan gagal; jika kontrak valid tiba kemudian, status dapat pulih. Status tidak lagi gagal hanya karena agen latar belakang diam selama 10 detik.
- Bridge memverifikasi keluaran perintah yang dijalankannya sendiri. Kriteria penerimaan yang bersifat semantik tetap dinilai Codex dari hasil, diff, dan bukti. Jika tidak ada rencana validasi maupun skrip proyek yang relevan, laporan bridge adalah `not_run` dan tidak dianggap bukti tes lulus.
- Pada OpenCode 1.18.32 yang diuji, `prompt_async` kadang tidak menghasilkan jawaban, sementara `format: json_schema` menyebabkan pembacaan pesan sesi gagal HTTP 400. Karena itu bridge memakai `/message`, meminta JSON melalui prompt, memvalidasi hasil dengan Zod, dan menormalkan deskripsi tunggal atau objek kosong pada kolom daftar bila aman. Hasil yang tetap tidak sesuai kontrak dilaporkan sebagai kegagalan.

## Protokol dan pembagian keputusan

`opencode_hub` adalah **MCP server lokal** yang menyediakan tujuh tool kontrol kepada Codex. Bridge berbicara ke OpenCode melalui HTTP loopback. Plugin `jev-gate.mjs` adalah komponen plugin OpenCode terpisah yang menjalankan Jev dan menyimpan bukti rute. Jadi keseluruhan hub bukan plugin OpenCode; MCP adalah konektor Codex, sementara plugin Jev adalah hook runtime OpenCode.

ACP yang dimaksud di dokumentasi OpenCode adalah **Agent Client Protocol**. ACP memungkinkan editor atau klien kompatibel menjalankan OpenCode sebagai coding agent melalui proses `opencode acp`. ACP menghubungkan editor ke agent; MCP menghubungkan host AI ke tool server. Untuk workflow ini MCP tetap jalur yang tepat karena Codex perlu memanggil kontrak task/status/result/decision milik bridge. ACP tidak menggantikan kontrak atau otomatis membuat Codex pemegang keputusan. Bridge ini belum memakai ACP.

Codex mengirim tujuan, scope, keputusan arsitektur, batasan, dan kriteria penerimaan. Planner OpenCode seperti Prometheus hanya membagi pekerjaan yang disetujui menjadi subtask dan memilih agent untuk tiap subtask. Jika OpenCode membutuhkan keputusan di luar brief, bridge mengembalikan pertanyaan serta pilihan. Codex menjawab sendiri bila brief sudah cukup; jika keputusan memerlukan preferensi pengguna, Codex memakai pilihan interaktif dengan input teks bebas dan menunggu jawaban sebelum mengirim `opencode_decision`. Batas tunggu lima menit sejak pilihan ditampilkan: diam lima menit penuh berarti Codex memilih opsi rekomendasi yang paling sesuai brief, memberi tahu pengguna tentang fallback beserta alasannya, lalu meneruskan pilihan. Setiap pesan pengguna mereset timer. Pertanyaan lanjutan dari pengguna dijawab sambil keputusan tetap menunggu.

Every MCP response that routes Jev shows the `Jev Decision` block exactly as the receipt formatter produced it. On the final result only, it is followed by the `Jev Estimate` block with `Codex tokens saved` and `Context avoided` lines in absolute tokens. The numbers are computed deterministically by `src/reporting.ts` from characters/4 of the full transcript versus the compact Codex payload; the agent never invents numbers.

Aturan Codex global di `C:\Users\LOQ\.codex\AGENTS.md` mewajibkan setiap task kerja memakai `opencode_hub`, termasuk task kecil. Percakapan dan penjelasan biasa dapat dijawab langsung. Jika bridge tidak tersedia, Codex harus menjelaskan kendalanya dan tidak diam-diam mengerjakan task sendiri.

## Memindahkan ke laptop lain

Bisa, tetapi konfigurasi saat ini belum portabel satu klik karena Codex MCP menunjuk ke path lokal. Laptop baru memerlukan Node.js 22+, OpenCode 1.18.32 yang sudah terautentikasi dan dikonfigurasi dengan OMO, Jev, agent, serta binding model yang dipakai, lalu bridge perlu dipasang (`npm ci` dan `npm run build`) dan didaftarkan ulang di konfigurasi Codex dengan path serta workspace laptop tersebut. Salin juga aturan global Codex agar routing otomatis tetap berlaku. Jangan salin credential mentah; autentikasi ulang provider di laptop baru.

File konfigurasi OpenCode saat audit mengandung kredensial yang ditulis langsung. Jangan menyalin file itu ke workspace atau log bridge; rotasi kredensial tersebut perlu dilakukan pada sisi layanan terkait.
