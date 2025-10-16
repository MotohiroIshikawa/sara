import { type JSX } from "react";
import Client from "./Client";

export default async function Page(
  props: { params: Promise<{ id: string }> }
): Promise<JSX.Element> {
  const { id } = await props.params;
  return <Client id={id} />;
}