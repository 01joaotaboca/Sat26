// /api/satelite.js
// Vercel Serverless Function
// Busca imagem de satélite (Sentinel-2) da área da fazenda via Sentinel Hub Process API
//
// Variáveis de ambiente necessárias no Vercel:
//   SENTINEL_CLIENT_ID     -> ex: sh-3618db2b-22a7-4f52-92dc-92cad1c28e34
//   SENTINEL_CLIENT_SECRET -> o secret gerado no dashboard (NUNCA no código/HTML)
//
// Uso no front-end:
//   GET /api/satelite?tipo=rgb    -> imagem em cor natural (true color)
//   GET /api/satelite?tipo=ndvi   -> imagem de índice de vegetação (NDVI)
//
// Coordenadas da área (bbox) definidas abaixo — AJUSTAR para o polígono real
// da Fazenda Santa Rosa antes de usar em produção.

const TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";
const PROCESS_URL = "https://sh.dataspace.copernicus.eu/api/v1/process";

// Área ao redor de São Benedito do Rio Preto - MA (ponto central do município)
// Formato: [oeste, sul, leste, norte] em graus decimais (WGS84 / EPSG:4326)
// ATENÇÃO: isto é uma aproximação (~6km ao redor da sede do município).
// Se souber as coordenadas exatas do talhão/perímetro da fazenda, ajuste aqui
// para uma área mais precisa (bbox menor = mais detalhe na imagem).
const BBOX_FAZENDA = [-43.559, -3.365, -43.499, -3.305];

const EVALSCRIPT_RGB = `
//VERSION=3
function setup() {
  return {
    input: ["B04", "B03", "B02"],
    output: { bands: 3 }
  };
}
function evaluatePixel(sample) {
  return [2.5 * sample.B04, 2.5 * sample.B03, 2.5 * sample.B02];
}
`;

const EVALSCRIPT_NDVI = `
//VERSION=3
function setup() {
  return {
    input: ["B04", "B08", "dataMask"],
    output: { bands: 4 }
  };
}
function evaluatePixel(sample) {
  let ndvi = (sample.B08 - sample.B04) / (sample.B08 + sample.B04);
  // Paleta simples: vermelho (baixo) -> amarelo -> verde (alto)
  let color;
  if (ndvi < 0) color = [0.65, 0.65, 0.65];
  else if (ndvi < 0.2) color = [0.8, 0.2, 0.2];
  else if (ndvi < 0.4) color = [0.9, 0.7, 0.2];
  else if (ndvi < 0.6) color = [0.6, 0.8, 0.2];
  else color = [0.1, 0.6, 0.1];
  return [...color, sample.dataMask];
}
`;

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiry) {
    return cachedToken;
  }

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
    const text = await resp.text();
    throw new Error(`Falha ao obter token (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  cachedToken = data.access_token;
  // Renova um pouco antes de expirar (margem de 30s)
  cachedTokenExpiry = now + (data.expires_in - 30) * 1000;
  return cachedToken;
}

export default async function handler(req, res) {
  try {
    const tipo = (req.query.tipo || "rgb").toLowerCase();
    const evalscript = tipo === "ndvi" ? EVALSCRIPT_NDVI : EVALSCRIPT_RGB;

    const token = await getToken();

    const hoje = new Date();
    const de = new Date(hoje);
    de.setDate(de.getDate() - 15); // últimos 15 dias para achar imagem sem nuvem

    const body = {
      input: {
        bounds: {
          bbox: BBOX_FAZENDA
        },
        data: [
          {
            type: "sentinel-2-l2a",
            dataFilter: {
              timeRange: {
                from: de.toISOString(),
                to: hoje.toISOString()
              },
              mosaickingOrder: "leastCC" // prioriza imagem com menos nuvens
            }
          }
        ]
      },
      output: {
        width: 1024,
        height: 1024,
        responses: [
          {
            identifier: "default",
            format: { type: "image/png" }
          }
        ]
      },
      evalscript
    };

    const imgResp = await fetch(PROCESS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!imgResp.ok) {
      const text = await imgResp.text();
      res.status(imgResp.status).json({ erro: "Falha ao buscar imagem", detalhe: text });
      return;
    }

    const buffer = Buffer.from(await imgResp.arrayBuffer());
    res.setHeader("Content-Type", "image/png");
    // Cache de 6h no CDN da Vercel, já que imagens de satélite não mudam a cada minuto
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=21600");
    res.status(200).send(buffer);
  } catch (err) {
    res.status(500).json({ erro: "Erro interno", detalhe: err.message });
  }
}
