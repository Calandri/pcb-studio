import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const session = await auth();
  if (session?.user) redirect("/");
  const params = await searchParams;

  return (
    <div className="substrate-grid flex h-dvh items-center justify-center bg-substrate px-6">
      <div className="power-on w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md border border-solder-dim/40 bg-solder-dim/10">
            <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5 text-solder">
              <path
                d="M3 10h3.2l1.6-4 2.4 8 1.8-4H17"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-ink">PCB Studio</h1>
            <p className="silk mt-0.5">schematici · pcb · produzione</p>
          </div>
        </div>

        <div className="rounded-lg border border-edge bg-panel p-5">
          {params.sent ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="led led-live" />
                <p className="text-sm text-ink">Link inviato</p>
              </div>
              <p className="text-xs leading-relaxed text-dim">
                Controlla la posta (anche lo spam) e apri il link per accedere. Scade tra
                24 ore.
              </p>
            </div>
          ) : (
            <form
              className="space-y-3"
              action={async (formData) => {
                "use server";
                await signIn("email", {
                  email: String(formData.get("email") ?? ""),
                  redirectTo: "/",
                });
              }}
            >
              <label className="silk block">indirizzo email</label>
              <input
                type="email"
                name="email"
                required
                autoFocus
                placeholder="nome@azienda.com"
                className="w-full rounded-md border border-edge bg-substrate px-3 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-faint focus:border-solder-dim"
              />
              <button
                type="submit"
                className="w-full rounded-md bg-solder-dim px-4 py-2.5 text-sm font-medium text-substrate transition-colors hover:bg-solder"
              >
                Inviami il link di accesso
              </button>
            </form>
          )}

          {params.error && (
            <p className="mt-4 rounded-md border border-alert/40 bg-alert/10 px-3 py-2 font-mono text-[11px] text-alert">
              accesso non riuscito: {params.error}
            </p>
          )}
        </div>

        <p className="mt-4 text-center text-xs text-faint">
          Nessuna password: ricevi un link via email.
        </p>
      </div>
    </div>
  );
}
