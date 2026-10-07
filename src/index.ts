#!/usr/bin/env node
/**
 * Serveur MCP « France Travail ».
 *
 * Expose les API officielles de France Travail (Offres d'emploi v2, ROME 4.0,
 * ROMEO 2, La Bonne Boîte v2) à un client MCP via le transport stdio.
 *
 * Variables d'environnement requises : FT_CLIENT_ID, FT_CLIENT_SECRET
 * (identifiants OAuth2 d'une application créée sur https://francetravail.io).
 *
 * RÈGLE stdio : stdout est réservé au protocole JSON-RPC. Tout log/diagnostic
 * passe par stderr (console.error).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerOffresTools } from "./tools/offres.js";
import { registerRomeTools } from "./tools/rome.js";
import { registerRomeoTools } from "./tools/romeo.js";
import { registerLaBonneBoiteTools } from "./tools/labonneboite.js";
import { startHttpServer } from "./http.js";

// Charge le .env situé à la RACINE du projet (un cran au-dessus de dist/),
// afin qu'il soit trouvé même lorsque le serveur est lancé depuis un autre dossier
// (cas d'un client MCP). `quiet: true` évite toute écriture sur stdout (qui
// corromprait le JSON-RPC). dotenv n'écrase jamais les variables déjà définies,
// donc les identifiants fournis via le bloc `env` du client restent prioritaires.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: path.join(projectRoot, ".env"), quiet: true });

function validateEnv(): void {
  const missing = ["FT_CLIENT_ID", "FT_CLIENT_SECRET"].filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(
      `[france-travail-mcp] Variables d'environnement manquantes : ${missing.join(", ")}.\n` +
        "Créez une application sur https://francetravail.io et renseignez ces identifiants " +
        "(voir .env.example ou la configuration 'env' de votre client MCP)."
    );
    process.exit(1);
  }
}

function buildServer(): McpServer {
  const server = new McpServer({
    name: "france-travail-mcp",
    version: "0.1.0",
  });

  registerOffresTools(server);
  registerRomeTools(server);
  registerRomeoTools(server);

  // La Bonne Boîte est une API à ACCÈS CONDITIONNÉ : la souscription au catalogue
  // ne suffit pas, France Travail exige une habilitation validée manuellement
  // (sans elle, l'API répond 403 « Invalid scope »). L'outil reste donc désactivé
  // par défaut ; activez-le avec FT_ENABLE_LABONNEBOITE=true une fois l'accès accordé.
  if (process.env.FT_ENABLE_LABONNEBOITE === "true") {
    registerLaBonneBoiteTools(server);
  }

  return server;
}

async function main(): Promise<void> {
  validateEnv();

  // MCP_TRANSPORT=http : serveur Streamable HTTP (déploiement distant, ex. Docker
  // derrière Caddy). Par défaut : stdio (usage local).
  if (process.env.MCP_TRANSPORT === "http") {
    startHttpServer(buildServer);
    return;
  }

  const transport = new StdioServerTransport();
  await buildServer().connect(transport);
  console.error("[france-travail-mcp] Serveur démarré (transport stdio).");
}

main().catch((error) => {
  // On ne journalise que le message (jamais l'objet brut), pour éviter qu'un
  // éventuel corps de requête (et donc un secret) ne soit sérialisé sur stderr.
  console.error(
    "[france-travail-mcp] Erreur fatale au démarrage :",
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});
