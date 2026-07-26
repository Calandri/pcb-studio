import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { Studio } from "@/components/Studio";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // il progetto si legge qui, non da window: leggendolo nel client il server
  // renderizzava "default" e il client il nome vero, rompendo l'hydration
  const raw = (await searchParams).project;
  const projectId = (Array.isArray(raw) ? raw[0] : raw) || "default";

  // niente progetto in URL: il livello sopra i progetti e' l'organizzazione
  if (!raw) redirect("/org");

  return (
    <Studio
      projectId={projectId}
      user={{
        email: session.user.email ?? "",
        name: session.user.name ?? null,
      }}
    />
  );
}
