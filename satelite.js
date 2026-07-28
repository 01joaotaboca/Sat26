// api/satelite.js — proxy Vercel para Copernicus Data Space
// Deploy: projeto Vercel separado (ou dentro de um existente).
// Configurar em Vercel > Settings > Environment Variables:
//   SENTINEL_CLIENT_ID
//   SENTINEL_CLIENT_SECRET

const TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";
const PROCESS_URL = "https://sh.dataspace.copernicus.eu/api/v1/process";

// Área ao redor de São Benedito do Rio Preto - MA
// Formato: [oeste, sul, leste, norte] em graus decimais (WGS84)
const BBOX_FAZENDA = [-43.559, -3.365, -43.499, -3.305];

const EVALSCRIPT_RGB = `
//VERSION=3
function setup() {
  return { input: ["B04","B03","B02"], output: { bands: 3 } };
}
function evaluatePixel(sample) {
  return [2.5*sample.B04, 2.5*sample.B03, 2.5*sample.B02];
}`;

const EVALSCRIPT_NDVI = `
//VERSION=3
function setup() {
  return { input: ["B04","B08","dataMask"], output: { bands: 4 } };
}
function evaluatePixel(sample) {
  let ndvi = (sample.B08 - sample.B04) / (sample.B08 + sample.B04);
  let color;
  if (ndvi < 0) color = [0.65,0.65,0.65];
  else if (ndvi < 0.2) color = [0.8,0.2,0.2];
  else if (ndvi < 0.4) color = [0.9,0.7,0.2];
  else if (ndvi < 0.6) color = [0.6,0.8,0.2];
  else color = [0.1,0.6,0.1];
  return [...color, sample.dataMask];
}`;

let tokenCache = null;
let tokenExpiraEm = 0;

async function obterToken() {
  const agora = Date.now();
  if (tokenCache && agora < tokenExpiraEm) return tokenCache;

  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");
  params.append("client_id", process.env.SENTINEL_CLIENT_ID);
  params.append("client_secret", process.env.SENTINEL_CLIENT_SECRET);

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });

  if (!resp.ok) {
    const texto = await resp.text().catch(() => "");
    throw new Error(`Token (${resp.status}): ${texto}`);
  }

  const dados = await resp.json();
  tokenCache = dados.access_token;
  tokenExpiraEm = agora + (dados.expires_in - 30) * 1000;
  return tokenCache;
}

async function buscarImagemSentinel(tipo) {
  const token = await obterToken();
  const evalscript = tipo === "ndvi" ? EVALSCRIPT_NDVI : EVALSCRIPT_RGB;

  const hoje = new Date();
  const de = new Date(hoje);
  de.setDate(de.getDate() - 15);

  const corpo = {
    input: {
      bounds: { bbox: BBOX_FAZENDA },
      data: [{
        type: "sentinel-2-l2a",
        dataFilter: {
          timeRange: { from: de.toISOString(), to: hoje.toISOString() },
          mosaickingOrder: "leastCC"
        }
      }]
    },
    output: {
      width: 1024,
      height: 1024,
      responses: [{ identifier: "default", format: { type: "image/png" } }]
    },
    evalscript
  };

  const resp = await fetch(PROCESS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(corpo)
  });

  if (!resp.ok) {
    const texto = await resp.text().catch(() => "");
    throw new Error(`Imagem (${resp.status}): ${texto}`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export default async function handler(req, res) {
  // Libera acesso pro domínio do PWA (GitHub Pages). Pode trocar '*' pelo
  // domínio exato (ex: 'https://joaotaboca.github.io') se quiser restringir.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  const tipo = req.query.tipo === "ndvi" ? "ndvi" : "rgb";

  try {
    const imagemBuffer = await buscarImagemSentinel(tipo);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=1800");
    res.status(200).send(imagemBuffer);
  } catch (e) {
    res.status(502).json({ erro: e.message || String(e) });
  }
}
