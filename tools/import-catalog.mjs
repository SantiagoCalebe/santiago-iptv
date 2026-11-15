import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const resultPath = fileURLToPath(new URL("../catalog/channels.json", import.meta.url));
const translations = new Map([
  ["animation", "Animação"], ["auto", "Automóveis"], ["business", "Negócios"],
  ["classic", "Clássicos"], ["comedy", "Comédia"], ["cooking", "Culinária"],
  ["culture", "Cultura"], ["documentary", "Documentários"], ["education", "Educação"],
  ["entertainment", "Entretenimento"], ["family", "Família"], ["general", "Geral"],
  ["interactive", "Interativo"], ["kids", "Infantil"], ["legislative", "Legislativo"],
  ["lifestyle", "Estilo de vida"], ["movies", "Filmes"], ["music", "Música"],
  ["news", "Notícias"], ["outdoor", "Ao ar livre"], ["public", "Canais públicos"],
  ["relax", "Relaxamento"], ["religious", "Religião"], ["science", "Ciência"],
  ["series", "Séries"], ["shop", "Compras"], ["sports", "Esportes"],
  ["travel", "Viagem"], ["weather", "Tempo"], ["others", "Outros"]
]);
const topCategories = ["general", "news", "culture", "education", "sports", "kids", "movies"];

async function readPlaylist(input) {
  if (!/^https?:\/\//i.test(input)) return readFile(input, "utf8");
  const response = await fetch(input, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error("A playlist retornou HTTP " + response.status + ".");
  return response.text();
}

function slug(value) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function formatFor(address) {
  try {
    const url = new URL(address);
    if (!["http:", "https:"].includes(url.protocol)) return "unsupported";
    const path = url.pathname.toLowerCase();
    if (path.endsWith(".mpd")) return "dash";
    if (path.endsWith(".mp4") || path.endsWith(".m4v") || path.endsWith(".mov")) return "mp4";
    if (path.endsWith(".mkv")) return "mkv";
    if (path.endsWith(".ts")) return "unsupported";
    return "hls";
  } catch {
    return "unsupported";
  }
}

function parsePlaylist(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim());
  if (!/^#EXTM3U(?:\s|$)/i.test(lines[0]) || lines.some((line) => line.startsWith("#EXT-X-"))) {
    throw new Error("Informe uma lista de canais M3U estendida.");
  }
  const channels = [];
  const names = new Map();
  const identifiers = new Map();
  const allocatedIds = new Set();
  let parsedCount = 0;
  let row;

  for (const line of lines) {
    if (/^#EXTINF:/i.test(line)) {
      const info = /^#EXTINF:((?:[^",]|"[^"]*")*),(.*)$/i.exec(line);
      parsedCount += 1;
      if (!info || row) throw new Error("Entrada M3U incompleta na posição " + parsedCount + ".");
      const attributes = new Map(
        Array.from(info[1].matchAll(/([\w-]+)="([^"]*)"/g), ([, key, value]) => [key.toLowerCase(), value])
      );
      row = { attributes, label: info[2].trim(), headers: {} };
    } else if (row && line.startsWith("#EXTVLCOPT:")) {
      const option = /^#EXTVLCOPT:http-(user-agent|referrer)=(.+)$/i.exec(line);
      if (option) row.headers[option[1].toLowerCase()] = option[2].trim();
    } else if (row && line && !line.startsWith("#")) {
      const { attributes, label, headers } = row;
      const tvgId = (attributes.get("tvg-id") ?? "").trim();
      const displayName = label.replace(/\s*\(\d{3,4}p\)/gi, "").replace(/\s*\[.*?\]/g, "").trim();
      const rawId = tvgId || slug(displayName) || "canal";
      let count = (identifiers.get(rawId) ?? 0) + 1;
      let id = count === 1 ? rawId : rawId + "~" + count;
      while (allocatedIds.has(id)) id = rawId + "~" + (++count);
      identifiers.set(rawId, count);
      allocatedIds.add(id);

      const group = attributes.get("group-title") ?? "";
      const groups = group.split(";").map((value) => value.trim()).filter(Boolean);
      if (groups.length === 0) groups.push("Undefined");
      const categoryIds = [...new Set(groups.map((value) => {
        const key = value.toLowerCase() === "undefined" ? "others" : slug(value) || "others";
        names.set(key, translations.get(key) ?? value);
        return key;
      }))];

      const height = Number(label.match(/\((\d{3,4})p\)(?:\s|$)/i)?.[1] ?? 0);
      const userAgent = headers["user-agent"] ?? attributes.get("http-user-agent");
      const referer = headers.referrer ?? attributes.get("http-referrer");
      const httpHeaders = {};
      if (userAgent) httpHeaders["User-Agent"] = userAgent;
      if (referer) httpHeaders.Referer = referer;
      const channel = {
        id,
        name: displayName || attributes.get("tvg-name") || tvgId || "Canal " + parsedCount,
        category_id: categoryIds[0],
        ...(categoryIds.length > 1 ? { category_ids: categoryIds } : {}),
        stream_url: line,
        stream_format: formatFor(line),
        ...(height > 0 && height <= 480 ? { source_height: height } : {}),
        ...(Object.keys(httpHeaders).length ? { http_headers: httpHeaders } : {}),
        live: true
      };
      channels.push(channel);
      row = undefined;
    }
  }

  if (row || channels.length === 0 || channels.length !== parsedCount) {
    throw new Error("A lista precisa ter um endereço para cada entrada EXTINF.");
  }

  const order = (id) => {
    const position = topCategories.indexOf(id);
    return position === -1 ? topCategories.length : position;
  };
  const categories = Array.from(names, ([id, name]) => ({ id, name }))
    .sort((a, b) => order(a.id) - order(b.id) || a.name.localeCompare(b.name, "pt-BR"));
  return { categories, channels };
}

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error("Uso: npm run import:catalog -- <URL ou arquivo M3U>.");
  const catalog = parsePlaylist(await readPlaylist(input));
  const staging = resultPath + "." + process.pid + ".tmp";
  try {
    await writeFile(staging, JSON.stringify(catalog) + "\n", { flag: "wx" });
    await rename(staging, resultPath);
  } finally {
    await unlink(staging).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  console.log(catalog.channels.length + " entradas em " + catalog.categories.length + " categorias.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
