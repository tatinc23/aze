// LOCAL TEST ONLY: stands in for x402.org/facilitator, which this container's network policy blocks.
import http from "node:http";
const PAYER = "0x0000000000000000000000000000000000000001";
http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  console.log("FAKE-FAC", req.method, req.url);
  if (req.url.endsWith("/supported")) return send({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: [], signers: {} });
  const j = JSON.parse(body || "{}"); const payer = j?.paymentPayload?.payload?.authorization?.from ?? PAYER;
  if (req.url.endsWith("/verify")) return send({ isValid: true, payer });
  if (req.url.endsWith("/settle")) return send({ success: true, transaction: "0xFAKE_LOCAL_TX", network: "eip155:84532", payer });
  res.writeHead(404); res.end();
}).listen(4999, () => console.log("fake facilitator :4999"));
