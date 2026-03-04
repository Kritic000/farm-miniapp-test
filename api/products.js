export default async function handler(req, res) {
  try {
    const GS_API_URL = process.env.GS_API_URL;

    if (!GS_API_URL) {
      res.status(500).json({ error: "Missing GS_API_URL env var" });
      return;
    }

    // CORS (на всякий случай)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.status(200).send("ok");
      return;
    }

    const r = await fetch(`${GS_API_URL}?action=products`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    const text = await r.text();
    res.status(r.status).send(text);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
