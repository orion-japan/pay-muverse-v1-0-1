import fs from 'fs'; import crypto from 'crypto';

function b64url(buf){return Buffer.from(buf).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')}
function b64urlJSON(o){return b64url(JSON.stringify(o))}
const now=()=>Math.floor(Date.now()/1000);

async function main(){
  const [,, uid, saPath, webApiKey] = process.argv;
  if(!uid||!saPath||!webApiKey){ console.error('ARG_ERR'); process.exit(90); }
  const sa = JSON.parse(fs.readFileSync(saPath,'utf8'));
  let pk = sa.private_key?.replace(/\\n/g,'\n'); const email = sa.client_email;
  if(!pk||!email){ console.error('SA_MISSING_FIELDS'); process.exit(91); }

  // Custom Token 生成
  const header={alg:'RS256',typ:'JWT'};
  const payload={
    iss:email, sub:email,
    aud:'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat:now(), exp:now()+300,
    uid, claims:{ role:'admin', user_code:'669933' }
  };
  const toSign=`${b64urlJSON(header)}.${b64urlJSON(payload)}`;
  const signer=crypto.createSign('RSA-SHA256'); signer.update(toSign); signer.end();
  const sig=b64url(signer.sign(pk));
  const customToken=`${toSign}.${sig}`;

  // 交換
  const url=`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${webApiKey}`;
  const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:customToken,returnSecureToken:true})});
  const text=await res.text();
  if(!res.ok){
    console.error('XCHG_HTTP', res.status);
    console.error('XCHG_BODY', text);
    process.exit(92);
  }
  const j=JSON.parse(text);
  if(!j.idToken){ console.error('NO_IDTOKEN', text); process.exit(93); }

  fs.writeFileSync('/tmp/_IDTOKEN', j.idToken, {mode:0o600});
  console.log('MINT_OK');
  // JWT ペイロード解析（既存変数と重複しないよう rename）
  const mid=j.idToken.split('.')[1];
  const pad='='.repeat((4-(mid.length%4))%4);
  const jwtPayload=JSON.parse(Buffer.from(mid+pad,'base64').toString('utf8'));
  console.log('PAYLOAD', JSON.stringify({
    aud:jwtPayload.aud, iss:jwtPayload.iss, sub:jwtPayload.sub,
    iat:jwtPayload.iat, exp:jwtPayload.exp
  }));
}
main().catch(e=>{ console.error('MINT_ERR', e.message||e); process.exit(99); });
