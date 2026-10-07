/** Outils MCP — Référentiel ROME 4.0 (métiers, fiches, compétences). */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiRequest } from "../services/client.js";
import { handleApiError } from "../services/errors.js";
import { ROME_METIERS_BASE, ROME_FICHES_BASE, SCOPES } from "../constants.js";
import { truncate } from "../util.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

interface Metier {
  code?: string;
  libelle?: string;
  definition?: string;
  [k: string]: unknown;
}

const metierResultSchema = z.object({ code: z.string(), libelle: z.string() });

export function registerRomeTools(server: McpServer): void {
  server.registerTool(
    "ft_search_metiers",
    {
      title: "Rechercher un métier ROME",
      description:
        "Recherche un métier dans le référentiel ROME 4.0 par texte libre et renvoie les codes ROME correspondants " +
        "(à 5 caractères, ex. M1607). Ces codes alimentent ft_search_offres (paramètre codeROME) et ft_search_entreprises. " +
        "La recherche filtre sur le libellé des 532 métiers ROME (insensible à la casse/accents). " +
        "Pour un rapprochement sémantique plus fin à partir d'un intitulé de poste, préférez ft_predict_rome.\n\n" +
        "Nécessite que l'application soit abonnée à l'API « ROME 4.0 - Métiers » sur francetravail.io.",
      inputSchema: {
        query: z.string().min(2).describe("Terme recherché (ex. 'boulanger', 'développeur', 'infirmier')"),
        limit: z.number().int().min(1).max(50).optional().describe("Nombre max de résultats (défaut 15)"),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const { data } = await apiRequest<Metier[]>({
          baseUrl: ROME_METIERS_BASE,
          path: "/metiers/metier",
          scope: SCOPES.romeMetiers,
        });
        const all = Array.isArray(data) ? data : [];
        const needle = normalize(args.query);
        const matched = all
          .filter((m) => normalize(m.libelle ?? "").includes(needle))
          .slice(0, args.limit ?? 15)
          .map((m) => ({ code: m.code ?? "", libelle: m.libelle ?? "" }));

        const structured = { count: matched.length, metiers: matched };
        const text = matched.length
          ? `${matched.length} métier(s) ROME pour « ${args.query} » :\n\n` +
            matched.map((m) => `- \`${m.code}\` — ${m.libelle}`).join("\n")
          : `Aucun métier ROME ne correspond à « ${args.query} ». Essayez un terme plus générique.`;
        return { content: [{ type: "text" as const, text: truncate(text) }], structuredContent: structured };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleApiError(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    "ft_get_metier",
    {
      title: "Fiche d'un métier ROME",
      description:
        "Récupère la fiche d'un métier ROME 4.0 par son code (5 caractères, ex. 'M1607') : libellé, définition, " +
        "accès au métier et arborescence (domaine professionnel, grand domaine). " +
        "Nécessite l'abonnement à l'API « ROME 4.0 - Métiers ».",
      inputSchema: {
        code: z.string().regex(/^[A-Z]\d{4}$/i).describe("Code ROME (ex. 'M1607')"),
        response_format: z.enum(["markdown", "json"]).optional(),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const { data } = await apiRequest<Metier>({
          baseUrl: ROME_METIERS_BASE,
          path: `/metiers/metier/${encodeURIComponent(args.code.toUpperCase())}`,
          scope: SCOPES.romeMetiers,
        });
        if (!data || (!data.code && !data.libelle)) {
          return { content: [{ type: "text" as const, text: `Métier ROME '${args.code}' introuvable.` }], isError: true };
        }
        const text =
          args.response_format === "json"
            ? JSON.stringify(data, null, 2)
            : renderMetier(data);
        return { content: [{ type: "text" as const, text: truncate(text) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleApiError(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    "ft_get_fiche_metier",
    {
      title: "Compétences et savoirs d'un métier ROME",
      description:
        "Récupère la fiche métier détaillée (format Fiche ROME) pour un code ROME : groupes de compétences " +
        "(savoir-faire) et groupes de savoirs associés au métier. Utile pour préparer un CV, identifier des " +
        "compétences à valoriser ou comprendre les attendus d'un métier. " +
        "Nécessite l'abonnement à l'API « ROME 4.0 - Fiches métiers ».",
      inputSchema: {
        code: z.string().regex(/^[A-Z]\d{4}$/i).describe("Code ROME (ex. 'M1607')"),
        response_format: z.enum(["markdown", "json"]).optional().describe("Format de sortie (défaut markdown)"),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const { data } = await apiRequest<FicheMetier>({
          baseUrl: ROME_FICHES_BASE,
          path: `/fiches-rome/fiche-metier/${encodeURIComponent(args.code.toUpperCase())}`,
          scope: SCOPES.romeFiches,
        });
        if (!data) {
          return { content: [{ type: "text" as const, text: `Fiche métier ROME '${args.code}' introuvable.` }], isError: true };
        }
        const text =
          args.response_format === "json"
            ? JSON.stringify(data, null, 2)
            : renderFiche(data, args.code.toUpperCase());
        return { content: [{ type: "text" as const, text: truncate(text) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleApiError(error) }], isError: true };
      }
    }
  );
}

/** Normalise pour une recherche tolérante (minuscules, sans accents). */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

interface FicheItem {
  libelle?: string;
}
interface FicheMetier {
  code?: string;
  metier?: { code?: string; libelle?: string };
  groupesCompetencesMobilisees?: Array<{ enjeu?: { libelle?: string }; competences?: FicheItem[] }>;
  groupesSavoirs?: Array<{ categorieSavoirs?: { libelle?: string }; savoirs?: FicheItem[] }>;
}

/** Rend une fiche métier ROME (compétences + savoirs) en markdown lisible. */
function renderFiche(f: FicheMetier, code: string): string {
  const groupesC = f.groupesCompetencesMobilisees ?? [];
  const groupesS = f.groupesSavoirs ?? [];
  // Structure inattendue : on ne masque rien, on rend le JSON brut (repli défensif).
  if (groupesC.length === 0 && groupesS.length === 0) {
    return "```json\n" + JSON.stringify(f, null, 2) + "\n```";
  }
  const parts = [`# Compétences & savoirs — ${f.metier?.libelle ?? "Métier"}  \`${f.metier?.code ?? code}\``];

  if (groupesC.length) {
    const blocs = groupesC.map((g) => {
      const items = (g.competences ?? []).map((c) => `- ${c.libelle ?? ""}`).join("\n");
      return `### ${g.enjeu?.libelle ?? "Compétences"}\n${items}`;
    });
    parts.push("## 🛠️ Compétences (savoir-faire)\n\n" + blocs.join("\n\n"));
  }
  if (groupesS.length) {
    const blocs = groupesS.map((g) => {
      const items = (g.savoirs ?? []).map((s) => `- ${s.libelle ?? ""}`).join("\n");
      return `### ${g.categorieSavoirs?.libelle ?? "Savoirs"}\n${items}`;
    });
    parts.push("## 📚 Savoirs\n\n" + blocs.join("\n\n"));
  }
  return parts.join("\n\n");
}

function renderMetier(m: Metier): string {
  const parts = [`# ${m.libelle ?? "Métier"}  \`${m.code ?? ""}\``];
  if (typeof m.definition === "string") parts.push(`## Définition\n${m.definition}`);
  const acces = (m as Record<string, unknown>)["acces"] ?? (m as Record<string, unknown>)["accesEmploi"];
  if (typeof acces === "string") parts.push(`## Accès au métier\n${acces}`);
  // Champs résiduels utiles, rendus en JSON compact pour ne rien perdre.
  const known = new Set(["code", "libelle", "definition", "acces", "accesEmploi"]);
  const rest = Object.fromEntries(Object.entries(m).filter(([k, v]) => !known.has(k) && v != null));
  if (Object.keys(rest).length) parts.push("## Autres informations\n```json\n" + JSON.stringify(rest, null, 2) + "\n```");
  return parts.join("\n\n");
}
