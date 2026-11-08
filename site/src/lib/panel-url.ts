/** The hosted panel. The site never creates hosted agents itself; it hands the visitor's words to the panel's draft. */
export const PANEL = 'https://app.agentenact.io';

/** Same cap as the panel's own prompt box. */
const MAX_PROMPT = 500;

/** `/draft?prompt=` with the trimmed first 500 characters; a blank prompt opens the panel's first screen instead. */
export function panelUrl(prompt: string): string {
  const text = prompt.trim().slice(0, MAX_PROMPT).trim();
  if (!text) return `${PANEL}/`;
  return `${PANEL}/draft?${new URLSearchParams({ prompt: text })}`;
}

/** `/draft?template=`: the panel opens a ready agent's plan at once, with no model call. */
export function templateUrl(id: string): string {
  return `${PANEL}/draft?${new URLSearchParams({ template: id })}`;
}
