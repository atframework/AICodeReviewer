import { defineCollection } from "astro:content";
import { docsLoader, i18nLoader } from "@astrojs/starlight/loaders";
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema";

// Starlight content collections. `docs` holds the Markdown pages under
// src/content/docs/<locale>/...; `i18n` holds UI-string overrides per BCP-47
// lang tag under src/content/i18n/<lang>.json.
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
