// src/lib/iros/rewrite.ts
/** ユーザー原文とAI出力の近似を測る（オウム返し抑制用） */
export function parrotScore(userText: string, aiText: string) {
  const norm = (s:string)=>s.replace(/\s+/g,'');
  const A = norm(userText), B = norm(aiText);
  if (!A || !B) return 0;
  const bi = (s:string)=>Array.from({length:Math.max(0,s.length-1)},(_,i)=>s.slice(i,i+2));
  const cnt = (xs:string[])=>xs.reduce((m,x)=>(m.set(x,(m.get(x)||0)+1),m),new Map<string,number>());
  const MA = cnt(bi(A)), MB = cnt(bi(B));
  let inter=0, uni=0;
  const keys = new Set([...MA.keys(), ...MB.keys()]);
  for (const k of keys){const a=(MA.get(k)||0), b=(MB.get(k)||0); inter+=Math.min(a,b); uni+=Math.max(a,b);}
  const jacc = uni===0?0:inter/uni;

  // Longest Common Substring ratio
  let best=0; const n=A.length,m=B.length; const dp=new Array(m+1).fill(0);
  for(let i=1;i<=n;i++){let prev=0;for(let j=1;j<=m;j++){const tmp=dp[j];dp[j]=(A[i-1]===B[j-1])?prev+1:0;if(dp[j]>best)best=dp[j];prev=tmp;}}
  const lcs = best/Math.max(n,m);

  return Math.max(jacc, lcs);
}
