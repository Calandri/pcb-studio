/**
 * Types for `altium-toolkit`, which ships JavaScript with JSDoc and no .d.ts.
 *
 * Only what we use is declared, and it is declared HONESTLY: `model` is the
 * Circuit JSON array, `diagnostics` is what the parser has to say about the
 * file. Declaring the whole surface would mean inventing types for code we do
 * not call, and inventing types is how you get a compiler that agrees with you
 * about something that is not true.
 */
declare module "altium-toolkit" {
  export interface AltiumDocument {
    /** Circuit JSON: the same array the rest of the pipeline works on */
    model?: unknown[];
    source?: { format?: string; fileName?: string; fileType?: string };
    diagnostics?: Array<{ severity?: string; message?: string; code?: string }>;
    statistics?: Record<string, unknown>;
  }

  export const Parser: {
    parse(
      input: { fileName: string; data: ArrayBuffer },
      options?: Record<string, unknown>,
    ): AltiumDocument;
    parseAsync(
      input: { fileName: string; data: ArrayBuffer },
      options?: Record<string, unknown>,
    ): Promise<AltiumDocument>;
  };
}
