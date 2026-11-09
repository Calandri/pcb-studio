import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildSchematicModel, type SchematicModel } from "@/lib/schematic-model";
import { parseSchematicNotes } from "@/lib/schematic-notes";
import { SchematicSheet, fitView, sheetFrame, type SheetTheme } from "./SchematicSheet";

/**
 * The schematic sheet as an SVG string, drawn by the same component the app
 * uses. It exists to look at the drawing without a browser: the tests read
 * it, and a PNG made from it (resvg) is what a person checks by eye.
 */
export function renderSchematicSvg(
  circuitJson: unknown[] | SchematicModel,
  {
    width = 1600,
    height = 1000,
    projectId = "schematico",
    fontFamily = "IBM Plex Mono, Menlo, monospace",
    /** zoom on a region of the sheet, in drawing units; default the whole sheet */
    region,
    theme = "dark",
    /** content of the project's schematico.json, when drawing from a Circuit JSON */
    notes,
  }: {
    width?: number;
    height?: number;
    projectId?: string;
    fontFamily?: string;
    region?: { x: number; y: number; w: number; h: number };
    theme?: SheetTheme;
    notes?: string;
  } = {},
): string {
  const model = Array.isArray(circuitJson)
    ? notes === undefined
      ? buildSchematicModel(circuitJson)
      : buildSchematicModel(circuitJson, parseSchematicNotes(notes))
    : circuitJson;
  const sheet = sheetFrame(model);
  const size = { w: width, h: height };
  const view = fitView(region ?? sheet, size, region ? 0 : 40);
  const markup = renderToStaticMarkup(
    createElement(SchematicSheet, { model, sheet, view, size, projectId, fontFamily, theme }),
  );
  return markup.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ');
}
