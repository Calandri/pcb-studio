import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { DatasheetsPage } from "@/components/DatasheetsPage";

export default async function Datasheets({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const raw = (await searchParams).project;
  const projectId = (Array.isArray(raw) ? raw[0] : raw) || "default";
  return (
    <DatasheetsPage
      projectId={projectId}
      user={{ email: session.user.email ?? "", name: session.user.name ?? null }}
    />
  );
}
