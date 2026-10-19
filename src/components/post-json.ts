/** whatever the endpoint answers, as loosely typed as `res.json()` itself */
type JsonBody = Awaited<ReturnType<Response["json"]>>;

/**
 * A JSON POST that never throws: it answers with the data, or with the error
 * to show.
 *
 * The settings pages each had their own `post`, and in all of them a network
 * error (offline, a proxy dropping the request) threw before `setBusy(false)`:
 * every button stayed disabled until the page was reloaded. With the failure
 * turned into a value, the caller's `finally` is the only place left to care.
 */
export async function postJson(
  url: string,
  body: Record<string, unknown>,
): Promise<{ data: JsonBody | null; error: string | null }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d: JsonBody = await res.json().catch(() => ({}));
    if (!res.ok) return { data: null, error: String(d?.error ?? `Errore ${res.status}`) };
    return { data: d, error: null };
  } catch (err) {
    return {
      data: null,
      error: `Rete non raggiungibile: riprova (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}
