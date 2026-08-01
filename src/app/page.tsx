import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { Studio } from "@/components/Studio";
import { Landing } from "@/components/landing/Landing";

/**
 * work.pcb-studio.com is the WORKSPACE, pcb-studio.com is the shop window.
 *
 * Same app, same deployment: what changes is only what an anonymous visitor
 * finds at the root. On the apex the marketing page, on the work subdomain the
 * login — nobody types work.pcb-studio.com to read what the product does.
 */
async function isWorkspaceHost(): Promise<boolean> {
  const host = (await headers()).get("host") ?? "";
  return host.startsWith("work.");
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  // unregistered users get the public landing page: the studio opens from the login
  if (!session?.user) {
    if (await isWorkspaceHost()) redirect("/login");
    return <Landing />;
  }

  // the project is read here, not from window: reading it on the client made
  // the server render "default" and the client the real name, breaking hydration
  const raw = (await searchParams).project;
  const projectId = (Array.isArray(raw) ? raw[0] : raw) || "default";

  // no project in the URL: the level above projects is the organization
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
