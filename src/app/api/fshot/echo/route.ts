export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";

function json(d:any, s=200){return new NextResponse(JSON.stringify(d),{status:s,headers:{'content-type':'application/json; charset=utf-8'}});}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = (form.get("file") || form.get("image")) as Blob | null;
    if (!file) return json({ ok:false, error:"no file" }, 400);

    // ここで本物のOCRに差し替える（現状はダミー）
    const text = "（echoコア）ここにOCR結果が入ります";

    return json({ ok:true, text });
  } catch (e:any) {
    return json({ ok:false, error: e?.message || "unexpected" }, 500);
  }
}
