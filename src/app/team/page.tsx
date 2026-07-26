import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { TeamPage } from "@/components/TeamPage";

export default async function Team({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const raw = (await searchParams).project;
  const projectId = (Array.isArray(raw) ? raw[0] : raw) || "default";
  return (
    <TeamPage
      projectId={projectId}
      user={{ email: session.user.email ?? "", name: session.user.name ?? null }}
    />
  );
}
