import { NextResponse } from "next/server";
import { connectOpenAI } from "@/utils/connectOpenAI";

export async function POST(request: Request) {
  const { text } = await request.json();
  const data = await connectOpenAI(text);
  console.log("getOpenAI");
  console.log(data);
  return NextResponse.json({content: data}); // content : choices[0].message.content
}