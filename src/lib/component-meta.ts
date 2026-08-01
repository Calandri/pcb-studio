import { readAttr, scanJsxTags } from "./manual-edits";

/**
 * What the designer says about each component, read from the sources.
 *
 * WHY FROM THE SOURCES AND NOT FROM THE CIRCUIT. tscircuit accepts
 * `description`, `kind`, `domain` and `tags` on components but does NOT carry
 * them into the Circuit JSON: they stay in the code and nowhere else. The
 * result was that on bat-bs all 50 components had a hand-written description,
 * and not a single one showed up in the UI: instead of the name it displayed
 * `ftype`, which for a crystal packaged as a library component is "chip".
 * Looking at the board there was no way to know what X1 was.
 *
 * The previous fallback (`inferRoles`) guesses the role from the network
 * topology. It works for a decoupling capacitor, not for a crystal inside a
 * `<chip>`: the topology does not know that chip is a 16 MHz crystal. Only
 * the person who wrote it knows that, and they had written it.
 */

export interface ComponentMeta {
  /** the hand-written sentence: what it is and why it is there */
  description: string | null;
  /** active / passive */
  kind: string | null;
  /** which part of the board it belongs to: power, brain, audio... */
  domain: string | null;
  /** what it is exactly: crystal, ldo, psram, crystal-load... */
  tags: string | null;
}

const EMPTY: ComponentMeta = { description: null, kind: null, domain: null, tags: null };

/**
 * Component name -> what the source says about it.
 *
 * ALL files are read, not just main.tsx: a component can be declared in a
 * submodule, and looking for it in one place only would mean showing its
 * description depending on where someone decided to write it.
 */
export function readComponentMeta(
  sources: Record<string, string>,
): Map<string, ComponentMeta> {
  const out = new Map<string, ComponentMeta>();
  for (const [path, content] of Object.entries(sources ?? {})) {
    if (!path.endsWith(".tsx") || !content) continue;
    for (const tag of scanJsxTags(content)) {
      // nets and schematic sections have a name but are not components:
      // describing them means nothing and would pollute the list
      if (tag.name === "net" || tag.name.toLowerCase() === "schematicsection") continue;
      const attrs = content.slice(tag.attrsStart, tag.attrsEnd);
      const name = readAttr(attrs, "name");
      if (!name) continue;
      const meta: ComponentMeta = {
        description: readAttr(attrs, "description"),
        kind: readAttr(attrs, "kind"),
        domain: readAttr(attrs, "domain"),
        tags: readAttr(attrs, "tags"),
      };
      if (!meta.description && !meta.kind && !meta.domain && !meta.tags) continue;
      /*
       * If the same name appears more than once, the entry carrying more
       * information wins, not the last one read: file order is arbitrary and
       * must not decide what the user sees.
       */
      const prev = out.get(name);
      if (!prev || score(meta) > score(prev)) out.set(name, meta);
    }
  }
  return out;
}

export function metaOf(
  meta: Map<string, ComponentMeta> | null | undefined,
  name: string,
): ComponentMeta {
  return meta?.get(name) ?? EMPTY;
}

/**
 * Components missing a description. Needed so we can SAY it instead of
 * leaving holes around the UI: anyone looking at the board must understand
 * what each part is, and a part without a description is a project defect
 * just like a rule violation.
 */
export function componentsWithoutDescription(
  sources: Record<string, string>,
  names: string[],
): string[] {
  const meta = readComponentMeta(sources);
  return names.filter((n) => !meta.get(n)?.description).sort();
}

const score = (m: ComponentMeta): number =>
  (m.description ? 8 : 0) + (m.tags ? 4 : 0) + (m.domain ? 2 : 0) + (m.kind ? 1 : 0);
