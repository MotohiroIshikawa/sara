import Client from "./Client";
import type { GptsIdParam } from "@/utils/types";

type Ctx = { params: Promise<GptsIdParam> };

export default async function Page({ params }: Ctx) {
  const { id } = await params;
  return <Client id={id} />;
}
