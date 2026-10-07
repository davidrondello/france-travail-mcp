/** Outils MCP — API Offres d'emploi v2. */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiRequest } from "../services/client.js";
import { handleApiError } from "../services/errors.js";
import { OFFRES_BASE, SCOPES, MAX_SEARCH_OFFSET, MAX_SEARCH_DEPTH } from "../constants.js";
import { joinCodes, truncate } from "../util.js";
import {
  type RawOffre,
  toSummary,
  searchOutputSchema,
  summariesToMarkdown,
  detailToMarkdown,
} from "../schemas/offre.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const REFERENTIELS = [
  "communes",
  "departements",
  "regions",
  "metiers",
  "appellations",
  "themes",
  "domaines",
  "continents",
  "pays",
  "naturesContrats",
  "typesContrats",
  "niveauxFormations",
  "permis",
  "langues",
  "secteursActivites",
] as const;

interface SearchResponse {
  resultats?: RawOffre[];
  filtresPossibles?: Array<{ filtre?: string; agregation?: Array<{ valeur?: string; nbResultats?: number }> }>;
}

export function registerOffresTools(server: McpServer): void {
  server.registerTool(
    "ft_search_offres",
    {
      title: "Rechercher des offres d'emploi",
      description:
        "Recherche multicritères dans les offres d'emploi France Travail (temps réel). " +
        "Renvoie une liste paginée de résumés d'offres + le total de résultats correspondants.\n\n" +
        "Paramètres principaux :\n" +
        "- motsCles : mots-clés (ex. 'boulanger', 'développeur web'). Caractères autorisés : lettres, chiffres, espace, @#$%^&+./-.\n" +
        "- codeROME : 1 à 3 codes ROME (5 caractères, ex. ['D1102']). Utilisez ft_predict_rome ou ft_search_metiers pour les trouver.\n" +
        "- commune / departement / region : codes INSEE (commune = 5 chiffres). Récupérables via ft_list_referentiel. " +
        "⚠ Paris, Lyon et Marseille s'indiquent par ARRONDISSEMENT (ex. Lyon 1er = 69381, Paris 1er = 75101, Marseille 1er = 13201) : " +
        "les codes « globaux » 69123 / 75056 / 13055 sont rejetés (400).\n" +
        "- distance : rayon en km autour de la commune (défaut 10 ; 0 = uniquement la commune).\n" +
        "- typeContrat : codes (ex. ['CDI','CDD','MIS']) — voir ft_list_referentiel typesContrats.\n" +
        "- experience : '1' (<1 an), '2' (1-3 ans), '3' (>3 ans).\n" +
        "- qualification : '0' (non cadre), '9' (cadre).\n" +
        "- tempsPlein : true/false.\n" +
        "- salaireMin + periodeSalaire (M=mensuel, A=annuel, H=horaire, C=autre) : obligatoires ENSEMBLE.\n" +
        "- publieeDepuis : 1, 3, 7, 14 ou 31 jours.\n" +
        "- sort : '0' pertinence (défaut), '1' date, '2' distance.\n" +
        "- offset (défaut 0) / limit (défaut 15, max 150) : pagination. Profondeur max ≈ 1150 résultats ; au-delà, affinez.\n\n" +
        "Exemples : « offres de boulanger en CDI à Lyon » → motsCles='boulanger', commune='69381' (Lyon 1er), typeContrat=['CDI']. " +
        "« développeurs publiés cette semaine » → motsCles='développeur', publieeDepuis='7'.\n\n" +
        "Erreurs : 400 = paramètre/format invalide (vérifiez les codes) ; 403 = API non souscrite.",
      inputSchema: {
        motsCles: z.string().max(200).optional().describe("Mots-clés de recherche"),
        codeROME: z.array(z.string().regex(/^[A-Z]\d{4}$/i)).max(3).optional().describe("Codes ROME (ex. ['D1102'])"),
        commune: z
          .string()
          .optional()
          .describe(
            "Code commune INSEE (5 chiffres). Paris/Lyon/Marseille : utiliser le code d'ARRONDISSEMENT (ex. 69381), pas le code global 69123/75056/13055."
          ),
        departement: z.string().optional().describe("Code département INSEE"),
        region: z.string().optional().describe("Code région INSEE"),
        distance: z.number().int().min(0).max(200).optional().describe("Rayon en km (défaut 10, 0 = commune seule)"),
        typeContrat: z.array(z.string()).max(10).optional().describe("Codes type de contrat (CDI, CDD, MIS…)"),
        natureContrat: z.array(z.string()).optional().describe("Codes nature de contrat"),
        experience: z.enum(["1", "2", "3"]).optional().describe("1:<1an, 2:1-3ans, 3:>3ans"),
        qualification: z.enum(["0", "9"]).optional().describe("0: non cadre, 9: cadre"),
        tempsPlein: z.boolean().optional().describe("true = temps plein, false = temps partiel"),
        salaireMin: z.number().min(0).optional().describe("Salaire minimum (requiert periodeSalaire)"),
        periodeSalaire: z.enum(["M", "A", "H", "C"]).optional().describe("Période du salaire (requiert salaireMin)"),
        publieeDepuis: z.enum(["1", "3", "7", "14", "31"]).optional().describe("Publiée depuis N jours"),
        sort: z.enum(["0", "1", "2"]).optional().describe("0: pertinence, 1: date, 2: distance"),
        offset: z.number().int().min(0).max(1000).optional().describe("Index de départ (pagination)"),
        limit: z.number().int().min(1).max(150).optional().describe("Nombre d'offres (défaut 15, max 150)"),
        response_format: z.enum(["markdown", "json"]).optional().describe("Format du texte (défaut markdown)"),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        if ((args.salaireMin === undefined) !== (args.periodeSalaire === undefined)) {
          return {
            content: [
              {
                type: "text" as const,
                text: "salaireMin et periodeSalaire doivent être fournis ensemble (ex. salaireMin=1800, periodeSalaire='M').",
              },
            ],
            isError: true,
          };
        }

        const offset = args.offset ?? 0;
        const limit = args.limit ?? 15;
        const params: Record<string, unknown> = {
          motsCles: args.motsCles,
          codeROME: joinCodes(args.codeROME),
          commune: args.commune,
          departement: args.departement,
          region: args.region,
          distance: args.distance,
          typeContrat: joinCodes(args.typeContrat),
          natureContrat: joinCodes(args.natureContrat),
          experience: args.experience,
          qualification: args.qualification,
          tempsPlein: args.tempsPlein,
          salaireMin: args.salaireMin,
          periodeSalaire: args.periodeSalaire,
          publieeDepuis: args.publieeDepuis,
          sort: args.sort,
          range: `${offset}-${offset + limit - 1}`,
        };

        const { data, contentRange } = await apiRequest<SearchResponse>({
          baseUrl: OFFRES_BASE,
          path: "/offres/search",
          scope: SCOPES.offres,
          params,
        });

        const resultats = data?.resultats ?? [];
        const summaries = resultats.map(toSummary);
        const count = summaries.length;
        // total réel des offres correspondant aux critères (peut dépasser la profondeur paginable).
        const total = contentRange?.total ?? offset + count;
        const nextOffset = offset + count;
        // Y a-t-il une page suivante ? (en l'absence de Content-Range, on suppose oui si la page est pleine)
        const moreExist = contentRange ? nextOffset < total : count === limit;
        // … et est-elle réellement atteignable au regard des limites de l'API ?
        const has_more = moreExist && nextOffset <= MAX_SEARCH_OFFSET && nextOffset <= MAX_SEARCH_DEPTH;
        const structured = {
          total,
          count,
          offset,
          has_more,
          ...(has_more ? { next_offset: nextOffset } : {}),
          offres: summaries,
        };

        const text =
          args.response_format === "json"
            ? JSON.stringify(structured, null, 2)
            : summariesToMarkdown(summaries, { total, offset, count, has_more });

        return {
          content: [{ type: "text" as const, text: truncate(text) }],
          structuredContent: structured,
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleApiError(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    "ft_get_offre",
    {
      title: "Détail d'une offre d'emploi",
      description:
        "Récupère le détail complet d'une offre par son identifiant (champ 'id' renvoyé par ft_search_offres, ex. '209WHZN'). " +
        "Renvoie l'intitulé, l'entreprise, le lieu, le contrat, le salaire, la description complète, les compétences/formations " +
        "et le lien pour postuler. Erreur 404 si l'identifiant n'existe pas ou si l'offre n'est plus en ligne.",
      inputSchema: {
        id: z.string().min(1).describe("Identifiant de l'offre (ex. '209WHZN')"),
        response_format: z.enum(["markdown", "json"]).optional().describe("Format de sortie (défaut markdown)"),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const { data, status } = await apiRequest<RawOffre>({
          baseUrl: OFFRES_BASE,
          path: `/offres/${encodeURIComponent(args.id)}`,
          scope: SCOPES.offres,
        });
        if (status === 204 || !data || !data.id) {
          return {
            content: [{ type: "text" as const, text: `Offre '${args.id}' introuvable ou expirée.` }],
            isError: true,
          };
        }
        const text =
          args.response_format === "json" ? JSON.stringify(data, null, 2) : detailToMarkdown(data);
        return { content: [{ type: "text" as const, text: truncate(text) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleApiError(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    "ft_list_referentiel",
    {
      title: "Lister un référentiel (codes ↔ libellés)",
      description:
        "Restitue un référentiel de codes utilisé par la recherche d'offres (codes ↔ libellés). " +
        "Indispensable pour traduire un nom en code (ex. trouver le code INSEE d'une commune, " +
        "ou les codes de types de contrats). Types disponibles : " +
        REFERENTIELS.join(", ") +
        ". Astuce : pour 'communes', filtrez vous-même par nom dans le résultat (la liste est longue).",
      inputSchema: {
        type: z.enum(REFERENTIELS).describe("Référentiel à récupérer"),
        filtre: z
          .string()
          .optional()
          .describe("Filtre texte optionnel (insensible à la casse) appliqué sur le libellé, pratique pour les longs référentiels"),
        limit: z.number().int().min(1).max(500).optional().describe("Nombre max d'entrées affichées (défaut 100)"),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const { data } = await apiRequest<Array<{ code?: string; libelle?: string }>>({
          baseUrl: OFFRES_BASE,
          path: `/referentiel/${args.type}`,
          scope: SCOPES.offres,
        });
        let items = Array.isArray(data) ? data : [];
        const totalRef = items.length;
        if (args.filtre) {
          const needle = args.filtre.toLowerCase();
          items = items.filter((it) => (it.libelle ?? "").toLowerCase().includes(needle));
        }
        const filtered = items.length;
        items = items.slice(0, args.limit ?? 100);

        const lines = items.map((it) => `- \`${it.code ?? ""}\` — ${it.libelle ?? ""}`);
        const header =
          `Référentiel '${args.type}' : ${totalRef} entrée(s)` +
          (args.filtre ? `, ${filtered} correspondant à « ${args.filtre} »` : "") +
          `, affichage de ${items.length}.\n`;
        return { content: [{ type: "text" as const, text: truncate(header + "\n" + lines.join("\n")) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleApiError(error) }], isError: true };
      }
    }
  );
}
