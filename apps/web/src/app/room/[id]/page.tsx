import { notFound } from "next/navigation";
import { z } from "zod";
import { WatchRoom } from "@/components/watch-room";

export default async function RoomPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  return <WatchRoom id={id} />;
}
