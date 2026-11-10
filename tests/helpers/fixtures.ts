import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Liest eine Datei aus fixtures/ (siehe fixtures/README.md). */
export async function readFixture(name: string): Promise<Uint8Array> {
  const path = fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));
  return new Uint8Array(await readFile(path));
}

/** Datei, wie sie ein Browser im Multipart-Formular schickt. */
export function uploadRequest(file: File, headers: Record<string, string> = {}): Request {
  const form = new FormData();
  form.append("file", file);
  return new Request("http://localhost/api/ingest", { method: "POST", body: form, headers });
}

export function fileFrom(bytes: Uint8Array | string, name: string, type: string): File {
  const part: BlobPart = typeof bytes === "string" ? bytes : new Uint8Array(bytes);
  return new File([part], name, { type });
}
