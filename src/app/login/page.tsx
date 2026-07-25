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
    <div className="flex h-dvh items-center justify-center bg-neutral-950 text-neutral-200">
      <div className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-900 p-6">
        <h1 className="text-lg font-semibold text-neutral-100">PCB Studio</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Progetta elettronica conversando con un agente AI.
        </p>

        {params.sent ? (
          <p className="mt-6 rounded border border-emerald-800 bg-emerald-950/40 px-3 py-3 text-sm text-emerald-300">
            Ti abbiamo inviato un link di accesso. Controlla la posta (anche lo spam).
          </p>
        ) : (
          <form
            className="mt-6 space-y-3"
            action={async (formData) => {
              "use server";
              await signIn("email", {
                email: String(formData.get("email") ?? ""),
                redirectTo: "/",
              });
            }}
          >
            <input
              type="email"
              name="email"
              required
              placeholder="nome@azienda.com"
              className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none placeholder:text-neutral-600 focus:border-emerald-600"
            />
            <button
              type="submit"
              className="w-full rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
            >
              Inviami il link di accesso
            </button>
          </form>
        )}

        {params.error && (
          <p className="mt-4 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
            Accesso non riuscito ({params.error}). Riprova.
          </p>
        )}

        <p className="mt-6 text-xs text-neutral-600">
          Ricevi un link via email: nessuna password da ricordare.
        </p>
      </div>
    </div>
  );
}
