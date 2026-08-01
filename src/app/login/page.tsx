import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import { LogoMark } from "@/components/Logo";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const session = await auth();
  if (session?.user) redirect("/");
  const params = await searchParams;

  return (
    <div className="flex h-dvh items-center justify-center bg-canvas px-6">
      <div className="rise w-full max-w-[380px]">
        <div className="mb-6 flex flex-col items-center text-center">
          <LogoMark size={52} className="shadow-sm" />
          <h1 className="mt-3 text-xl font-bold tracking-tight text-text">PCB Studio</h1>
          <p className="mt-0.5 text-sm text-faint">AI PCB Designer</p>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Progetta schede elettroniche conversando con un agente AI.
          </p>
        </div>

        <div className="card p-6">
          {params.sent ? (
            <div className="space-y-2 text-center">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-brand-wash">
                <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5 text-brand">
                  <path
                    d="M3.5 6.5 10 11l6.5-4.5M3.5 5.5h13v9h-13v-9Z"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <p className="text-sm font-semibold text-text">Controlla la posta</p>
              <p className="text-xs leading-relaxed text-muted">
                Ti abbiamo inviato un link per accedere. Scade tra 24 ore; se non lo trovi,
                guarda nello spam.
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
              <label htmlFor="email" className="section-label">
                Il tuo indirizzo email
              </label>
              <input
                id="email"
                type="email"
                name="email"
                required
                autoFocus
                placeholder="nome@azienda.com"
                className="w-full rounded-lg border border-line bg-surface px-3.5 py-2.5 text-sm text-text outline-none transition-colors placeholder:text-faint focus:border-brand focus:ring-2 focus:ring-brand/15"
              />
              <button
                type="submit"
                className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-ink shadow-sm transition-colors hover:bg-brand-strong"
              >
                Inviami il link di accesso
              </button>
            </form>
          )}

          {params.error && (
            <p className="mt-4 rounded-lg bg-danger-wash px-3 py-2 text-xs text-danger">
              Accesso non riuscito ({params.error}). Riprova.
            </p>
          )}
        </div>

        <p className="mt-4 text-center text-xs text-faint">
          Nessuna password da ricordare: accedi con un link via email.
        </p>
      </div>
    </div>
  );
}
