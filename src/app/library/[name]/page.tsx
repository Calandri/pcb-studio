import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { LibraryDetailPage } from "@/components/LibraryDetailPage";

export default async function LibraryDetail({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const { name } = await params;
  const raw = (await searchParams).project;
  const projectId = (Array.isArray(raw) ? raw[0] : raw) || "default";
  return (
    <LibraryDetailPage
      name={name}
      projectId={projectId}
      user={{ email: session.user.email ?? "", name: session.user.name ?? null }}
    />
  );
}
