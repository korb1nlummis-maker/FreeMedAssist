/* FreeMedAssist — build the sign-in version (app.html) from the tested index.html.
 *
 * The sign-in version is the SAME app + engine as the no-login index.html, wrapped in an
 * on-device, encrypted account layer (WebCrypto: PBKDF2 -> AES-GCM). Generating it FROM
 * index.html means the engine never drifts between the two versions.
 *
 * Run:  node build_signin.mjs   ->   writes app.html
 *
 * Security model (honest): there is NO server. The password derives an AES-GCM key that
 * encrypts the user's saved bills in localStorage on THIS device. Wrong password = the key
 * cannot decrypt. No password reset, no recovery, nothing uploaded. Requires a secure
 * context (https / localhost) for crypto.subtle + localStorage — i.e. the hosted link.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "index.html");
const OUT = join(HERE, "app.html");

let html = readFileSync(SRC, "utf-8");

/* ---------------------------------------------------------------- auth CSS */
const AUTH_CSS = `
<style id="fma-auth-css">
  body.fma-locked #app{ display:none !important; }
  .fma-auth-wrap{ position:fixed; inset:0; z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px; overflow:auto;
    background:radial-gradient(1100px 700px at 80% -10%,#0e3a2e55,transparent),radial-gradient(900px 600px at -10% 110%,#0c4a4255,transparent),linear-gradient(160deg,#05130e,#0a201a); }
  .fma-auth-card{ width:100%; max-width:440px; background:rgba(14,38,30,.62); backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px);
    border:1px solid #ffffff22; border-radius:22px; box-shadow:0 18px 50px #00000055; padding:30px 26px; color:#f3fffb; }
  .fma-brand{ font-weight:900; font-size:28px; letter-spacing:-.5px; background:linear-gradient(135deg,#34d399,#2dd4bf 55%,#22d3ee); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .fma-sub{ color:#a9ccc1; font-size:15px; margin:8px 0 20px; line-height:1.55; }
  .fma-tabs{ display:flex; gap:8px; margin-bottom:18px; }
  .fma-tabs button{ flex:1; background:transparent; color:#cdeee4; border:2px solid #ffffff22; border-radius:13px; padding:12px; font-weight:800; font-size:16px; cursor:pointer; min-height:50px; }
  .fma-tabs button.on{ background:linear-gradient(135deg,#34d399,#2dd4bf 55%,#22d3ee); color:#04231a; border-color:transparent; }
  .fma-auth-card input{ margin:9px 0; }
  .fma-go{ width:100%; background:linear-gradient(135deg,#34d399,#2dd4bf 55%,#22d3ee); color:#04231a; border:0; border-radius:14px; padding:16px; font-weight:800; font-size:18px; cursor:pointer; min-height:56px; margin-top:6px; }
  .fma-go:hover{ filter:brightness(1.07); }
  .fma-go:focus-visible{ outline:3px solid #fff; outline-offset:3px; }
  .fma-msg{ min-height:22px; margin-top:10px; font-size:15px; color:#fbbf24; line-height:1.5; }
  .fma-msg.ok{ color:#34d399; }
  .fma-warn{ margin-top:14px; font-size:13.5px; color:#a9ccc1; line-height:1.55; background:rgba(0,0,0,.22); border:1px solid #ffffff18; border-radius:12px; padding:12px 13px; }
  .fma-foot{ margin-top:18px; font-size:14px; color:#a9ccc1; text-align:center; } .fma-foot a{ color:#2dd4bf; }
  #fma-bar{ display:flex; flex-wrap:wrap; gap:10px; align-items:center; justify-content:space-between; background:rgba(0,0,0,.22); border:1px solid #ffffff18; border-radius:14px; padding:10px 14px; margin-bottom:16px; font-size:15px; color:#cdeee4; }
  #fma-bar .fma-link{ background:transparent; border:0; color:#2dd4bf; font-weight:700; cursor:pointer; font-size:15px; padding:8px 10px; min-height:44px; }
  #fma-bar .fma-link:hover{ text-decoration:underline; }
  #fma-bar .fma-baracts{ display:flex; gap:4px; flex-wrap:wrap; }
  .fma-saverow{ margin-top:22px; padding-top:18px; border-top:1px solid #ffffff18; }
  .fma-saverow-note{ color:#a9ccc1; font-size:14px; margin-top:8px; }
  .fma-modal-wrap{ position:fixed; inset:0; z-index:10000; display:flex; align-items:center; justify-content:center; padding:20px; background:rgba(0,0,0,.55); }
  .fma-modal{ width:100%; max-width:520px; max-height:80vh; overflow:auto; background:#0f261e; border:1px solid #ffffff22; border-radius:20px; padding:22px; color:#f3fffb; box-shadow:0 18px 50px #00000077; }
  .fma-modal-head{ display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; font-size:20px; }
  .fma-x{ background:transparent; border:0; color:#cdeee4; font-size:22px; cursor:pointer; min-width:44px; min-height:44px; }
  .fma-saved-card{ display:flex; justify-content:space-between; align-items:center; gap:12px; background:rgba(0,0,0,.22); border:1px solid #ffffff18; border-radius:14px; padding:13px 15px; margin:10px 0; }
  .fma-saved-sub{ color:#a9ccc1; font-size:14px; margin-top:3px; }
  .fma-saved-acts{ display:flex; gap:8px; align-items:center; white-space:nowrap; }
  .fma-saved-acts .fma-del{ background:transparent; border:0; color:#fb7185; cursor:pointer; font-weight:700; min-height:44px; }
  .fma-empty{ color:#a9ccc1; padding:12px; line-height:1.5; }
  #fma-toast{ position:fixed; left:50%; bottom:26px; transform:translateX(-50%) translateY(20px); background:#04231a; border:1px solid #2dd4bf; color:#f3fffb; padding:13px 20px; border-radius:14px; font-weight:700; opacity:0; transition:.25s; z-index:10001; pointer-events:none; box-shadow:0 10px 30px #00000066; max-width:90vw; text-align:center; }
  #fma-toast.show{ opacity:1; transform:translateX(-50%) translateY(0); }
</style>`;

/* ----------------------------------------------------------- auth overlay */
const AUTH_OVERLAY = `
<div id="fma-auth" class="fma-auth-wrap" style="display:none" role="dialog" aria-label="Sign in to FreeMedAssist">
  <div class="fma-auth-card">
    <div class="fma-brand">➕ FreeMedAssist</div>
    <div class="fma-sub">Private sign-in. Your account and saved bills are encrypted on <b>this device only</b> with your password — nothing is uploaded, there is no server.</div>
    <div class="fma-tabs">
      <button id="fma-tab-in" class="on" type="button" onclick="fmaShowTab('in')">Sign in</button>
      <button id="fma-tab-up" type="button" onclick="fmaShowTab('up')">Create account</button>
    </div>
    <div id="fma-pane-in">
      <label for="fma-in-user" style="margin-top:4px">Username</label>
      <input id="fma-in-user" autocomplete="username" placeholder="Your username"/>
      <label for="fma-in-pass">Password</label>
      <input id="fma-in-pass" type="password" autocomplete="current-password" placeholder="Your password"/>
      <button class="fma-go" type="button" onclick="fmaSignIn()">Sign in</button>
      <div id="fma-in-msg" class="fma-msg" role="status" aria-live="polite"></div>
    </div>
    <div id="fma-pane-up" style="display:none">
      <label for="fma-up-user" style="margin-top:4px">Choose a username</label>
      <input id="fma-up-user" autocomplete="username" placeholder="e.g. robert"/>
      <label for="fma-up-pass">Choose a password (8+ characters)</label>
      <input id="fma-up-pass" type="password" autocomplete="new-password" placeholder="Make it memorable to you"/>
      <label for="fma-up-pass2">Type the password again</label>
      <input id="fma-up-pass2" type="password" autocomplete="new-password" placeholder="Confirm password"/>
      <button class="fma-go" type="button" onclick="fmaSignUp()">Create account</button>
      <div id="fma-up-msg" class="fma-msg" role="status" aria-live="polite"></div>
      <div class="fma-warn"><b>Please read:</b> this password protects bills saved on <b>this device</b>. There is no server and <b>no password reset</b> — if you forget it, your saved bills cannot be recovered. (You can always use the free tool without an account.)</div>
    </div>
    <div class="fma-foot">Don't want an account? <a href="index.html">Use the free no-login version →</a></div>
  </div>
</div>`;

/* --------------------------------------------------------------- auth JS */
const AUTH_JS = `
<script>
/* FreeMedAssist sign-in layer — on-device, encrypted (PBKDF2 -> AES-GCM). No server. */
(function(){
  "use strict";
  var LS, ACCT_KEY="fma_accounts_v1", VAULT_PREFIX="fma_vault_v1_", ITER=210000;
  try { LS = window.localStorage; var _t="__fma_t"; LS.setItem(_t,"1"); LS.removeItem(_t); }
  catch(e){ LS=null; }
  var fmaKey=null, fmaUser=null;

  function b64e(buf){ var b=new Uint8Array(buf), s=""; for(var i=0;i<b.length;i++) s+=String.fromCharCode(b[i]); return btoa(s); }
  function b64d(s){ var bin=atob(s), b=new Uint8Array(bin.length); for(var i=0;i<bin.length;i++) b[i]=bin.charCodeAt(i); return b; }
  function rand(n){ var a=new Uint8Array(n); crypto.getRandomValues(a); return a; }
  function accts(){ if(!LS) return {}; try{ return JSON.parse(LS.getItem(ACCT_KEY)||"{}"); }catch(e){ return {}; } }
  function setAccts(o){ if(LS) LS.setItem(ACCT_KEY, JSON.stringify(o)); }
  function escH(s){ return (s==null?"":String(s)).replace(/[&<>"]/g,function(c){return ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"})[c];}); }

  function deriveKey(pw, salt){
    return crypto.subtle.importKey("raw", new TextEncoder().encode(pw), {name:"PBKDF2"}, false, ["deriveKey"])
      .then(function(base){ return crypto.subtle.deriveKey({name:"PBKDF2", salt:salt, iterations:ITER, hash:"SHA-256"}, base, {name:"AES-GCM", length:256}, false, ["encrypt","decrypt"]); });
  }
  function enc(key, obj){ var iv=rand(12); return crypto.subtle.encrypt({name:"AES-GCM", iv:iv}, key, new TextEncoder().encode(JSON.stringify(obj))).then(function(ct){ return {iv:b64e(iv), ct:b64e(ct)}; }); }
  function dec(key, blob){ return crypto.subtle.decrypt({name:"AES-GCM", iv:b64d(blob.iv)}, key, b64d(blob.ct)).then(function(pt){ return JSON.parse(new TextDecoder().decode(pt)); }); }

  function loadVault(){ if(!LS) return Promise.resolve([]); var raw=LS.getItem(VAULT_PREFIX+fmaUser); if(!raw) return Promise.resolve([]);
    try{ return dec(fmaKey, JSON.parse(raw)).then(function(v){ return Array.isArray(v)?v:[]; }).catch(function(){ return []; }); }catch(e){ return Promise.resolve([]); } }
  function saveVault(list){ return enc(fmaKey, list).then(function(b){ if(LS) LS.setItem(VAULT_PREFIX+fmaUser, JSON.stringify(b)); }); }

  window.fmaShowTab=function(w){
    document.getElementById("fma-pane-in").style.display = w==="in"?"block":"none";
    document.getElementById("fma-pane-up").style.display = w==="up"?"block":"none";
    document.getElementById("fma-tab-in").classList.toggle("on", w==="in");
    document.getElementById("fma-tab-up").classList.toggle("on", w==="up");
  };

  window.fmaSignUp=function(){
    var u=(document.getElementById("fma-up-user").value||"").trim();
    var p=document.getElementById("fma-up-pass").value||"", p2=document.getElementById("fma-up-pass2").value||"";
    var msg=document.getElementById("fma-up-msg"); msg.className="fma-msg";
    if(!LS||!(window.crypto&&crypto.subtle)){ msg.textContent="This browser blocks secure local storage here. Open the hosted link (https), not a local file."; return; }
    if(u.length<2){ msg.textContent="Please choose a username (2+ characters)."; return; }
    if(p.length<8){ msg.textContent="Please choose a password with at least 8 characters."; return; }
    if(p!==p2){ msg.textContent="The two passwords don't match."; return; }
    if(accts()[u.toLowerCase()]){ msg.textContent="That username is already used on this device. Try signing in."; return; }
    msg.textContent="Creating your account…";
    var salt=rand(16);
    deriveKey(p, salt).then(function(key){
      return enc(key, "FMA-OK").then(function(ver){
        var a=accts(); a[u.toLowerCase()]={ user:u, salt:b64e(salt), iter:ITER, ver:ver }; setAccts(a);
        fmaKey=key; fmaUser=u.toLowerCase(); return saveVault([]);
      });
    }).then(function(){ unlock(u); }).catch(function(){ msg.textContent="Couldn't create the account in this browser (private mode may block storage)."; });
  };

  window.fmaSignIn=function(){
    var u=(document.getElementById("fma-in-user").value||"").trim().toLowerCase();
    var p=document.getElementById("fma-in-pass").value||"";
    var msg=document.getElementById("fma-in-msg"); msg.className="fma-msg";
    if(!LS||!(window.crypto&&crypto.subtle)){ msg.textContent="This browser blocks secure local storage here. Open the hosted link (https)."; return; }
    var a=accts()[u]; if(!a){ msg.textContent="No account with that username on this device."; return; }
    msg.textContent="Signing in…";
    deriveKey(p, b64d(a.salt)).then(function(key){
      return dec(key, a.ver).then(function(v){ if(v!=="FMA-OK") throw new Error("bad"); fmaKey=key; fmaUser=u; unlock(a.user); });
    }).catch(function(){ msg.textContent="Wrong password (or this account's saved data was cleared from this device)."; });
  };

  window.fmaSignOut=function(){
    fmaKey=null; fmaUser=null;
    var ip=document.getElementById("fma-in-pass"); if(ip) ip.value="";
    document.body.classList.add("fma-locked");
    document.getElementById("fma-auth").style.display="flex";
    var m=document.getElementById("fma-saved-modal"); if(m) m.style.display="none";
  };

  function unlock(name){
    document.body.classList.remove("fma-locked");
    document.getElementById("fma-auth").style.display="none";
    var bar=document.getElementById("fma-bar");
    if(!bar){ bar=document.createElement("div"); bar.id="fma-bar"; var app=document.getElementById("app"); app.insertBefore(bar, app.firstChild); }
    bar.innerHTML='<span>Signed in as <b>'+escH(name)+'</b></span><span class="fma-baracts">'+
      '<button type="button" class="fma-link" onclick="fmaShowSaved()">💾 My saved bills</button>'+
      '<button type="button" class="fma-link" onclick="fmaSignOut()">Sign out</button></span>';
  }

  function gv(id){ var el=document.getElementById(id); return el?el.value:""; }
  function sv(id,v){ var el=document.getElementById(id); if(el) el.value=(v==null?"":v); }

  window.fmaSaveCurrent=function(btn){
    if(!fmaKey) return;
    if(!window.currentBill){ toast("Add a bill first, then save."); return; }
    var snap={ t:isoNow(), label:(gv("f_provider")|| (window.currentBill&&window.currentBill.provider) || "Saved bill"),
      form:{ f_name:gv("f_name"), f_address:gv("f_address"), f_state:gv("f_state"), f_household:gv("f_household"),
        f_income:gv("f_income"), f_provider:gv("f_provider"), f_account:gv("f_account"),
        f_primary:gv("f_primary"), f_network:gv("f_network"), f_supplemental:gv("f_supplemental") },
      bill:window.currentBill||null, eob:window.currentEob||null };
    loadVault().then(function(list){ list.unshift(snap); if(list.length>50) list=list.slice(0,50); return saveVault(list); })
      .then(function(){ toast("Saved to your account ✓"); if(btn){ btn.textContent="Saved ✓"; btn.disabled=true; } })
      .catch(function(){ toast("Couldn't save just now."); });
  };

  window.fmaRestore=function(idx){
    loadVault().then(function(list){
      var s=list[idx]; if(!s) return; var f=s.form||{};
      Object.keys(f).forEach(function(k){ sv(k, f[k]); });
      if(typeof onPrimaryChange==="function"){ try{ onPrimaryChange(); }catch(e){} }
      window.currentEob = s.eob||null;
      if(s.bill && typeof setBill==="function"){ setBill(s.bill); } else { window.currentBill = s.bill||null; }
      var m=document.getElementById("fma-saved-modal"); if(m) m.style.display="none";
      if(typeof goStep==="function") goStep(4);
    });
  };

  window.fmaDelete=function(idx){
    loadVault().then(function(list){ list.splice(idx,1); return saveVault(list); }).then(function(){ fmaShowSaved(); });
  };

  window.fmaShowSaved=function(){
    var m=document.getElementById("fma-saved-modal");
    if(!m){ m=document.createElement("div"); m.id="fma-saved-modal"; m.className="fma-modal-wrap";
      m.innerHTML='<div class="fma-modal" role="dialog" aria-label="Your saved bills"><div class="fma-modal-head"><b>Your saved bills</b>'+
        '<button class="fma-x" type="button" aria-label="Close" onclick="document.getElementById(\\'fma-saved-modal\\').style.display=\\'none\\'">✕</button></div><div id="fma-saved-list"></div></div>';
      document.body.appendChild(m); }
    m.style.display="flex";
    loadVault().then(function(list){
      var host=document.getElementById("fma-saved-list");
      if(!list.length){ host.innerHTML='<div class="fma-empty">No saved bills yet. Open or check a bill, then press <b>Save this bill to my account</b> on the results page.</div>'; return; }
      host.innerHTML=list.map(function(s,i){
        var when=""; try{ when=new Date(s.t).toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric"}); }catch(e){}
        var n=(s.bill&&s.bill.line_items&&s.bill.line_items.length)||0;
        return '<div class="fma-saved-card"><div class="fma-saved-main"><b>'+escH(s.label||"Saved bill")+'</b>'+
          '<div class="fma-saved-sub">'+n+' line'+(n!==1?"s":"")+(when?(" · saved "+when):"")+'</div></div>'+
          '<div class="fma-saved-acts"><button class="btn sm" type="button" onclick="fmaRestore('+i+')">Open</button>'+
          '<button class="fma-del" type="button" onclick="fmaDelete('+i+')">Delete</button></div></div>';
      }).join("");
    });
  };

  function isoNow(){ try{ return new Date().toISOString(); }catch(e){ return ""; } }
  function toast(msg){ var t=document.getElementById("fma-toast"); if(!t){ t=document.createElement("div"); t.id="fma-toast"; document.body.appendChild(t); } t.textContent=msg; t.classList.add("show"); setTimeout(function(){ t.classList.remove("show"); }, 2600); }

  function installSaveButton(){
    if(typeof window.renderResults!=="function") return;
    var orig=window.renderResults;
    window.renderResults=function(d){
      orig(d);
      try{ var host=document.getElementById("results"); if(!host||host.querySelector(".fma-saverow")) return;
        var row=document.createElement("div"); row.className="fma-saverow";
        row.innerHTML='<button type="button" class="btn" onclick="fmaSaveCurrent(this)">💾 Save this bill to my account</button>'+
          '<div class="fma-saverow-note">Saved encrypted on this device only, so you can come back to it.</div>';
        host.appendChild(row);
      }catch(e){}
    };
  }

  function boot(){
    document.body.classList.add("fma-locked");
    var auth=document.getElementById("fma-auth"); if(auth) auth.style.display="flex";
    installSaveButton();
    if(window.fmaShowTab) window.fmaShowTab("in");
    var ip=document.getElementById("fma-in-pass"); if(ip) ip.addEventListener("keydown",function(e){ if(e.key==="Enter") fmaSignIn(); });
    var up2=document.getElementById("fma-up-pass2"); if(up2) up2.addEventListener("keydown",function(e){ if(e.key==="Enter") fmaSignUp(); });
  }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
<\/script>`;

/* ------------------------------------------------------------- inject */
function replaceOnce(hay, needle, repl, what) {
  const i = hay.indexOf(needle);
  if (i === -1) throw new Error("marker not found: " + what);
  if (hay.indexOf(needle, i + needle.length) !== -1 && what !== "</body>" && what !== "</head>") {
    // ok for </head>,</body> uniqueness is implied; for others we still take first
  }
  return hay.slice(0, i) + repl + hay.slice(i + needle.length);
}

// 1) title
html = html.replace(/<title>[\s\S]*?<\/title>/, "<title>FreeMedAssist — sign in &amp; save your bills (private, on your device)</title>");
// 2) auth CSS before </head>
html = replaceOnce(html, "</head>", AUTH_CSS + "\n</head>", "</head>");
// 3) lock body + inject overlay right after <body>
html = replaceOnce(html, "<body>", '<body class="fma-locked">\n' + AUTH_OVERLAY, "<body>");
// 4) auth JS before </body>
html = replaceOnce(html, "</body>", AUTH_JS + "\n</body>", "</body>");

writeFileSync(OUT, html, "utf-8");

/* ------------------------------------------------------------- sanity */
const checks = [
  ["overlay present", html.includes('id="fma-auth"')],
  ["auth css present", html.includes("fma-auth-css")],
  ["auth js present", html.includes("fmaSignIn")],
  ["engine still inlined", html.includes("FreeMedAssistEngine")],
  ["renderResults still present", html.includes("function renderResults")],
  ["body locked", html.includes('<body class="fma-locked">')],
  ["links to no-login version", html.includes('href="index.html"')],
  ["auth script block is closed exactly once", (AUTH_JS.match(/<\/scr"?\+?"?ipt>|<\/script>/g) || []).length === 1],
];
let ok = true;
for (const [name, cond] of checks) { if (!cond) { ok = false; console.error("  X " + name); } }
if (!ok) { console.error("build_signin: FAILED sanity checks"); process.exit(1); }
console.log("build_signin: wrote app.html (" + html.length + " bytes) — sign-in layer injected, engine in sync with index.html.");
