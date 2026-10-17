// Local dev: npx tsx scripts/serve.ts (PORT defaults to 3000).
import server from "../index.js";
(server as any).listen(Number(process.env.PORT ?? 3000));
