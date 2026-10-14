// Fungsi Vercel: semua request (halaman & data) diarahkan ke sini lewat vercel.json,
// sehingga password berlaku untuk seluruh dashboard.
import { handler } from '../server.js';

export default function (req, res) {
  return handler(req, res);
}
