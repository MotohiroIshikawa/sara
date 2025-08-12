import { NextResponse } from "next/server";
import { connectOpenAI } from "@/utils/connectOpenAI";

export async function POST(request: Request) {
  const { text } = await request.json();
  const data = await connectOpenAI(text);
  return NextResponse.json(data);
}