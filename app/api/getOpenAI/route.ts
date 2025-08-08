import { NextResponse } from "next/server";
import { connectOpenAI } from "@/utils/connectOpenAI";

export async function POST(request: Request) {
  const { message } = await request.json();
  const data = await connectOpenAI(message);
  return NextResponse.json(data);
}