/**
 * How long a file of a project may be, in characters. write_file refuses a
 * longer one, and whatever writes a project file on its own (the stitching of
 * the ground, ground-stitching-file.ts) holds itself to the same number: a file
 * past it could no longer be read whole by the agent (a read stops a little
 * above it) nor written again through write_file.
 */
export const MAX_FILE_CHARS = 200_000;
