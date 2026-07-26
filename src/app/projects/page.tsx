import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { ProjectsPage } from "@/components/ProjectsPage";

export default async function Projects({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const raw = (await searchParams).project;
  const projectId = (Array.isArray(raw) ? raw[0] : raw) || "default";
  return (
    <ProjectsPage
      projectId={projectId}
      user={{ email: session.user.email ?? "", name: session.user.name ?? null }}
    />
  );
}
