// 网页管理的页面。运行时零依赖、不用构建，所以是一个内联的 HTML 字符串。
// 设计语言：两只铁罐一根线。镀锌铁皮的蓝灰做底，麻绳黄是唯一的亮色；一根麻绳串起所有机器人，绳结的颜色就是状态。
export const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#F2F4F2">
<title>传声筒</title>
<style>
:root{color-scheme:light;
--zinc:#F2F4F2;--ink:#14202A;--muted:#5C6A76;--faint:#8996A0;--twine:#94702F;
--panel:linear-gradient(137deg,#FFFFFF 5%,#FBFCFB 76%);--knot-ring:#FFFFFF;--edge:rgba(20,32,42,.09);--hi:inset 0 1px 1px rgba(255,255,255,.9);--lift:0 1px 2px rgba(20,32,42,.05),0 8px 24px -12px rgba(20,32,42,.14);
--well:#EFF2F0;--well-shadow:inset 0 1px 2px rgba(20,32,42,.07);--hover:rgba(20,32,42,.035);--rule:rgba(20,32,42,.075);
--key:linear-gradient(180deg,#FFFFFF,#EEF1EF);--key-shadow:0 0 0 1px rgba(20,32,42,.1),0 1px 2px rgba(20,32,42,.1),inset 0 1px .4px #fff;
--primary:linear-gradient(180deg,#2B3B48,#1A2732);--on-primary:#F7F9F8;--primary-shadow:0 0 0 1px #0C151C,0 1px 3px rgba(20,32,42,.3),inset 0 1px .4px rgba(255,255,255,.25);
--dot:#33475A;--ok:#1E7F5B;--wait:#A96F1B;--bad:#BC3D33;
--r-s:7px;--r-m:10px;--r-l:18px;
--sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","HarmonyOS Sans SC","Segoe UI Variable","Microsoft YaHei UI","Noto Sans CJK SC",system-ui,sans-serif;
--serif:"Songti SC","Noto Serif CJK SC","Source Han Serif SC","STSong",ui-serif,serif;
--ease:cubic-bezier(.22,.8,.24,1)}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--zinc);color:var(--ink);font:14.5px/1.6 var(--sans);font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
button,input,textarea{font:inherit;color:inherit}
a{color:inherit}
h1,h2,h3,h4,p{margin:0}
.wrap{max-width:860px;margin:0 auto;padding:0 max(20px,env(safe-area-inset-left)) 88px}

/* 控件：按钮像实体键帽 */
.btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:0 14px;border:0;border-radius:var(--r-m);background:var(--key);box-shadow:var(--key-shadow);font-size:14px;font-weight:500;letter-spacing:.01em;cursor:pointer;white-space:nowrap;transition:filter .15s,transform .08s}
.btn:hover{filter:brightness(1.06)}
.btn:active{transform:translateY(.5px);filter:brightness(.97)}
.btn.primary{background:var(--primary);box-shadow:var(--primary-shadow);color:var(--on-primary);font-weight:600}
.btn.bare{background:none;box-shadow:none;color:var(--muted)}
.btn.bare:hover{color:var(--ink);background:var(--hover);filter:none}
.btn.danger{background:none;box-shadow:inset 0 0 0 1px currentColor;color:var(--bad)}
.btn[disabled]{opacity:.45;cursor:default;filter:none;transform:none}
:focus-visible{outline:2px solid var(--twine);outline-offset:2px}
input[type=text],input[type=password],input[type=search],textarea{width:100%;min-height:42px;padding:9px 12px;background:var(--well);border:1px solid var(--edge);border-radius:var(--r-m);box-shadow:var(--well-shadow);transition:border-color .15s,box-shadow .15s}
input::placeholder,textarea::placeholder{color:var(--faint)}
input:focus,textarea:focus{outline:none;border-color:var(--twine);box-shadow:var(--well-shadow),0 0 0 3px color-mix(in srgb,var(--twine) 18%,transparent)}
textarea{resize:vertical;min-height:112px;line-height:1.55}
label{display:block;font-weight:500;font-size:13.5px;margin:18px 0 7px}
.hint{color:var(--muted);font-size:13px;line-height:1.6;margin-top:7px}
.err{color:var(--bad);font-size:13.5px;margin-top:12px}
.note{color:var(--ok);font-size:13.5px;margin-top:12px}
.panel{position:relative;background:var(--panel);border:1px solid var(--edge);border-radius:var(--r-l);box-shadow:var(--hi),var(--lift)}

/* 页头 */
header{display:flex;align-items:center;gap:8px;padding:18px 0}
.brand{display:flex;align-items:center;gap:9px;font-family:var(--serif);font-weight:700;font-size:18px;letter-spacing:.08em}
.brand svg{width:26px;height:26px}
header .grow{flex:1}

/* 首屏面板：一句话说清现状，右边是两只铁罐，声波点阵铺在背后 */
.hero{overflow:hidden;padding:24px 28px 22px;min-height:0}
.waves{position:absolute;inset:0;width:100%;height:100%;color:var(--dot);pointer-events:none}
.art{position:absolute;right:20px;top:50%;width:216px;transform:translateY(-50%);pointer-events:none}
.lead{position:relative;font-family:var(--serif);font-weight:600;font-size:21px;line-height:1.55;letter-spacing:.012em;max-width:calc(100% - 230px)}
.lead b{font-weight:700;color:var(--twine);font-size:1.08em}
.meta{position:relative;color:var(--muted);font-size:13px;margin-top:6px}

.tools{display:flex;align-items:center;gap:10px;margin:18px 0 10px;flex-wrap:wrap}
.seg{display:inline-flex;gap:2px;padding:3px;border-radius:var(--r-m);background:var(--well);box-shadow:var(--well-shadow)}
.tab{appearance:none;border:0;background:none;padding:0 12px;min-height:30px;border-radius:var(--r-s);cursor:pointer;color:var(--muted);font-size:13.5px;transition:color .15s}
.tab:hover{color:var(--ink)}
.tab[aria-pressed=true]{color:var(--ink);background:var(--key);box-shadow:var(--key-shadow);font-weight:500}
.tab i{font-style:normal;color:var(--faint);margin-left:4px}
.tab[aria-pressed=true] i{color:var(--muted)}
.tools input{margin-left:auto;width:210px;min-height:36px;padding:6px 11px;font-size:13.5px}

/* 麻绳和绳结 */
.list{padding:6px 0}
.rope{position:absolute;left:29px;top:0;bottom:0;width:1.5px;background:var(--twine);opacity:.75;overflow:hidden}
.pulse{position:absolute;left:0;top:-60px;width:100%;height:60px;background:linear-gradient(transparent,#fff);animation:signal 8s 1s var(--ease) infinite}
@keyframes signal{0%{top:-60px}28%,100%{top:100%}}
.row{position:relative;display:grid;grid-template-columns:38px minmax(0,1fr) auto 12px;align-items:center;gap:0 14px;width:100%;padding:14px 20px 14px 56px;text-align:left;background:none;border:0;cursor:pointer;transition:background-color .12s}
.row:hover{background:var(--hover)}
.row+.row::before{content:"";position:absolute;left:56px;right:0;top:0;height:1px;background:var(--rule)}
.knot{position:absolute;left:24.5px;top:50%;width:11px;height:11px;margin-top:-5.5px;border-radius:50%;background:var(--faint);box-shadow:0 0 0 3.5px var(--knot-ring,var(--zinc))}
.knot.ok{background:var(--ok)}.knot.wait{background:var(--wait)}.knot.bad{background:var(--bad)}
.cap{display:grid;place-items:center;width:38px;height:38px;border-radius:var(--r-m);background:var(--key);box-shadow:var(--key-shadow);font-size:13px;font-weight:600;letter-spacing:.02em;color:var(--muted)}
.name{font-size:15px;font-weight:550;letter-spacing:-.006em;line-height:1.35;overflow-wrap:anywhere}
.who{color:var(--muted);font-size:13px;line-height:1.5;margin-top:2px;overflow-wrap:anywhere}
.who strong{color:var(--ink);font-weight:450}
.who.bad{color:var(--bad)}
.nums{display:flex;gap:18px;color:var(--faint);font-size:12.5px;white-space:nowrap;text-align:right}
.nums strong{display:block;color:var(--ink);font-weight:500;font-size:14px;line-height:1.3}
.chev{width:12px;height:12px;color:var(--faint)}
.none{color:var(--muted);padding:26px 56px}

/* 空状态和登录 */
.empty{text-align:left;padding:30px 36px 36px;margin-top:6px;overflow:hidden}
.empty .art{position:relative;right:auto;top:auto;transform:none;width:min(320px,100%);margin-bottom:16px}
.empty h2{position:relative;font-family:var(--serif);font-weight:600;font-size:26px;letter-spacing:.01em}
.empty p{position:relative;color:var(--muted);margin:10px 0 20px;max-width:30em}
.login{min-height:100dvh;display:grid;place-items:center;padding:24px}
.login form{width:min(392px,100%);padding:30px 30px 32px;overflow:hidden}
.login .art{position:relative;right:auto;top:auto;transform:none;width:100%;margin:-4px 0 10px}
.login h1{position:relative;font-family:var(--serif);font-weight:700;font-size:32px;letter-spacing:.1em}
.login .hint,.login label,.login input,.login .err{position:relative}
.login .btn{position:relative;width:100%;margin-top:22px;min-height:42px}

/* 侧滑面板 */
dialog.sheet{position:fixed;inset:10px 10px 10px auto;margin:0;width:min(452px,calc(100vw - 20px));max-width:none;height:calc(100dvh - 20px);max-height:none;padding:0;border:1px solid var(--edge);border-radius:var(--r-l);background:#fff;box-shadow:var(--hi),0 24px 56px -16px rgba(20,32,42,.32);color:var(--ink);overflow:auto;overscroll-behavior:contain;animation:slide .3s var(--ease)}
dialog.sheet::backdrop{background:rgba(20,32,42,.22);animation:fade .2s}
@keyframes slide{from{transform:translateX(24px);opacity:0}}
@keyframes fade{from{opacity:0}}
.pane{padding:22px 24px calc(28px + env(safe-area-inset-bottom))}
.pane-head{display:flex;align-items:flex-start;gap:12px}
.pane-head h3{flex:1;font-size:18px;font-weight:600;letter-spacing:-.01em;overflow-wrap:anywhere;line-height:1.35}
.x{appearance:none;border:0;background:none;width:30px;height:30px;margin:-3px -6px 0 0;border-radius:var(--r-s);color:var(--muted);cursor:pointer;font-size:19px;line-height:1}
.x:hover{background:var(--hover);color:var(--ink)}
.sub{color:var(--muted);font-size:13px;margin-top:2px;overflow-wrap:anywhere}
.send{display:flex;align-items:center;gap:10px;margin-top:16px;padding:12px 12px 12px 14px;background:var(--well);box-shadow:var(--well-shadow);border-radius:var(--r-m)}
.send div{flex:1;min-width:0;font-size:12.5px;color:var(--muted)}
.send strong{display:block;color:var(--ink);font-weight:550;font-size:14.5px;overflow-wrap:anywhere}
.tabs{display:flex;gap:2px;margin-top:18px;padding:3px;border-radius:var(--r-m);background:var(--well);box-shadow:var(--well-shadow)}
.tabs button{appearance:none;flex:1;background:none;border:0;min-height:30px;border-radius:var(--r-s);color:var(--muted);font-size:13.5px;cursor:pointer}
.tabs button:hover{color:var(--ink)}
.tabs button[aria-selected=true]{color:var(--ink);font-weight:500;background:var(--key);box-shadow:var(--key-shadow)}
.acts{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
.owner{margin-top:18px;font-size:13px;color:var(--muted)}
.owner strong{display:block;color:var(--ink);font-size:15px;font-weight:550;overflow-wrap:anywhere;margin:1px 0}
.linkbox{margin-top:12px;padding:11px 13px;background:var(--well);box-shadow:var(--well-shadow);border-radius:var(--r-m);font-size:13px;overflow-wrap:anywhere}
.switch{display:flex;align-items:center;gap:12px;margin-top:20px;cursor:pointer;font-weight:500;font-size:13.5px}
.switch span{flex:1}
.switch small{display:block;font-weight:400;color:var(--muted);font-size:13px}
.switch input{appearance:none;position:relative;flex:none;width:40px;height:24px;margin:0;border-radius:12px;background:var(--well);box-shadow:var(--well-shadow),inset 0 0 0 1px var(--edge);cursor:pointer;transition:background-color .18s}
.switch input::after{content:"";position:absolute;left:3px;top:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.35);transition:transform .2s var(--ease)}
.switch input:checked{background:var(--ok)}
.switch input:checked::after{transform:translateX(16px)}
.section{margin-top:26px}
.section h4{font-size:13.5px;font-weight:550}
.results{list-style:none;padding:0;margin:16px 0 0;font-size:13.5px}
.results li{padding:9px 0;border-top:1px solid var(--rule);display:flex;align-items:center;gap:8px;overflow-wrap:anywhere}
.results li span{flex:1;min-width:0}
.results .no{color:var(--bad)}
.toast{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:9;background:var(--ink);color:var(--zinc);padding:8px 14px;border-radius:var(--r-m);font-size:13.5px;font-weight:500;max-width:calc(100vw - 32px);box-shadow:0 8px 24px -8px rgba(0,0,0,.5);animation:fade .15s}

@media (max-width:640px){
.wrap{padding:0 12px 56px}
header{padding:14px 4px}
.hero{padding:20px 18px 18px}
.art{display:none}.empty .art,.login .art{display:block}
.lead{font-size:19px;max-width:none}
.nums{display:none}
.row{grid-template-columns:34px minmax(0,1fr) 12px;gap:0 12px;padding:12px 14px 12px 42px}
.row+.row::before{left:42px}
.cap{width:34px;height:34px}
.rope{left:20px}.knot{left:15.5px}
.none{padding:22px 42px}
.tools{margin-top:18px}
.tools input{margin-left:0;width:100%;order:9}
dialog.sheet{inset:auto 0 0 0;width:100vw;height:auto;max-height:90dvh;border-width:1px 0 0;border-radius:var(--r-l) var(--r-l) 0 0;animation-name:rise}
.pane{padding:20px 18px calc(26px + env(safe-area-inset-bottom))}
@keyframes rise{from{transform:translateY(36px);opacity:0}}
}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}.pulse,.travel{display:none}}
</style></head><body><div id="app"></div>
<script>
// 两只有金属光泽的铁罐。defs 只放一份，主视觉和页头的小图标共用
const DEFS='<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><linearGradient id="tin" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#46535E"/><stop offset=".14" stop-color="#AEBAC1"/><stop offset=".3" stop-color="#EEF3F4"/><stop offset=".52" stop-color="#94A2AC"/><stop offset=".8" stop-color="#4C5A65"/><stop offset="1" stop-color="#7E8C96"/></linearGradient><linearGradient id="rim" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#6B7883"/><stop offset=".3" stop-color="#F6F9FA"/><stop offset=".65" stop-color="#8896A0"/><stop offset="1" stop-color="#C9D2D7"/></linearGradient><linearGradient id="inside" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#10171D"/><stop offset="1" stop-color="#3B4852"/></linearGradient></defs></svg>';
const ONE=(x,y,r,scale)=>'<g transform="translate('+x+' '+y+') rotate('+r+') scale('+scale+')"><path d="M-22 -30V30C-22 35.500 -12 39 0 39S22 35.500 22 30V-30Z" fill="url(#tin)"/><g fill="none" stroke="#10171D" stroke-opacity=".2"><path d="M-22 -14C-22 -9 -12 -6 0 -6S22 -9 22 -14"/><path d="M-22 2C-22 7 -12 10 0 10S22 7 22 2"/><path d="M-22 18C-22 23 -12 26 0 26S22 23 22 18"/></g><g fill="none" stroke="#fff" stroke-opacity=".28"><path d="M-22 -13C-22 -8 -12 -5 0 -5S22 -8 22 -13"/><path d="M-22 3C-22 8 -12 11 0 11S22 8 22 3"/><path d="M-22 19C-22 24 -12 27 0 27S22 24 22 19"/></g><ellipse cx="0" cy="-30" rx="22" ry="8" fill="url(#rim)"/><ellipse cx="0" cy="-30" rx="19.500" ry="6.400" fill="url(#inside)"/></g>';
const ART=()=>'<svg class="art" viewBox="0 0 300 130" fill="none" aria-hidden="true">'+ONE(44,62,-90+78,1.05)+ONE(256,62,90-78,1.05)+'<path class="string" d="M66 62C120 112 180 112 234 62" stroke="var(--twine)" stroke-width="2.200" stroke-linecap="round"/><path d="M66 62C120 112 180 112 234 62" stroke="#000" stroke-opacity=".28" stroke-width="2.200" stroke-dasharray="1.500 2.500"/><path class="travel" d="M66 62C120 112 180 112 234 62" stroke="#fff" stroke-width="2.600" stroke-linecap="round" stroke-dasharray="10 400"/></svg>';
// 声波：从右上方的罐子往外一圈圈散开的点阵
function waves(){let dots='';const cx=640,cy=86;for(let ring=1;ring<=16;ring++){const rad=ring*30,count=Math.round(rad/5.2);for(let i=0;i<count;i++){const a=Math.PI*.42+(i/count)*Math.PI*1.16,x=cx+Math.cos(a)*rad,y=cy+Math.sin(a)*rad*.86;if(x<-4||y<-4||y>330)continue;const o=(.2*(1-ring/17)*(.45+.55*Math.abs(Math.sin(a*5+ring*.9)))).toFixed(3);dots+='<circle cx="'+x.toFixed(1)+'" cy="'+y.toFixed(1)+'" r="1.100" opacity="'+o+'"/>'}}return '<svg class="waves" viewBox="0 0 860 240" preserveAspectRatio="xMaxYMid slice" fill="currentColor" aria-hidden="true">'+dots+'</svg>'}
const CAN='<svg viewBox="0 0 30 30" aria-hidden="true"><g transform="translate(11 16) scale(.33)"><path d="M-22 -30V30C-22 35.500 -12 39 0 39S22 35.500 22 30V-30Z" fill="url(#tin)"/><ellipse cx="0" cy="-30" rx="22" ry="8" fill="url(#rim)"/><ellipse cx="0" cy="-30" rx="19.500" ry="6.400" fill="url(#inside)"/></g><path d="M18 16c5 0 4 9 10 9" fill="none" stroke="var(--twine)" stroke-width="1.600" stroke-linecap="round"/></svg>';
const CHEV='<svg class="chev" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M5 2.500 9.500 7 5 11.500" stroke="currentColor" stroke-width="1.500" stroke-linecap="round" stroke-linejoin="round"/></svg>';
document.body.insertAdjacentHTML('afterbegin',DEFS);
const app=document.getElementById('app');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function call(path,method='GET',body){
  const res=await fetch(path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined,credentials:'same-origin'});
  const data=await res.json().catch(()=>({error:'服务器没有正常响应，刷新页面再试。'}));
  if(res.status===401&&path!=='/api/login'&&path!=='/api/password'){showLogin();throw new Error('请先登录。')}
  if(!res.ok)throw new Error(data.error||'这一步没成功，再试一次。');
  return data;
}
function toast(text){document.querySelector('.toast')?.remove();const t=document.createElement('div');t.className='toast';t.setAttribute('role','status');t.textContent=text;(document.querySelector('dialog[open]')||document.body).append(t);setTimeout(()=>t.remove(),2400)}
async function copy(text,done){try{await navigator.clipboard.writeText(text);toast(done)}catch{toast('复制不了，请手动选中复制。')}}

function showLogin(){
  stopRefresh();document.querySelectorAll('dialog').forEach(d=>d.close());
  app.innerHTML='<div class="login"><form id="f" class="panel">'+waves()+ART()+'<h1>传声筒</h1><p class="hint">管理这台服务器上的机器人</p><label for="u">账号</label><input id="u" type="text" autocomplete="username" required autofocus><label for="p">密码</label><input id="p" type="password" autocomplete="current-password" required><p class="err" id="e" hidden></p><button class="btn primary">登录</button></form></div>';
  document.getElementById('f').onsubmit=async ev=>{ev.preventDefault();const e=document.getElementById('e');e.hidden=true;
    try{await call('/api/login','POST',{user:document.getElementById('u').value,password:document.getElementById('p').value});await load()}catch(err){e.textContent=err.message;e.hidden=false}};
}

const kind=b=>b.state==='failed'||(!b.bound&&!b.claimOpen)?'bad':b.bound?'ok':'wait';
function who(b){
  if(b.state==='failed')return '<div class="who bad">Token 失效了，点开换一个</div>';
  if(b.bound)return '<div class="who">管理员 <strong>'+esc(b.ownerUsername?'@'+b.ownerUsername:b.ownerName||'已绑定')+'</strong></div>';
  if(!b.claimOpen)return '<div class="who bad">绑定已过期，点开重新开放</div>';
  if(b.claimMode==='user')return '<div class="who">等 @'+esc(b.claimUser)+' 私聊，发消息就自动绑定</div>';
  if(b.claimMode==='link')return '<div class="who">等新管理员打开链接</div>';
  if(b.claimMode==='pair')return '<div class="who">等人绑定，配对图案是 '+esc(b.claimPair||'（已失效）')+'</div>';
  return '<div class="who">等人来：谁先点「成为管理员」就归谁用</div>';
}
const title=b=>b.username?'@'+b.username:b.name;
const mb=n=>Math.round(n/1048576);

let bots=[],server=null,filter='all',query='',timer=null;
function stopRefresh(){clearInterval(timer);timer=null}
async function load(){
  let data;try{data=await call('/api/bots')}catch(e){if(e.message!=='请先登录。')toast(e.message);return}
  bots=data.bots;server=data.server;render();
  if(!timer)timer=setInterval(()=>{if(!document.hidden&&!document.querySelector('dialog[open]'))refresh()},20000);
}
async function refresh(){try{const data=await call('/api/bots');bots=data.bots;server=data.server;render()}catch{}}
function sentence(){
  const n=bots.length,on=bots.filter(b=>kind(b)==='ok').length,wait=bots.filter(b=>kind(b)==='wait').length,bad=bots.filter(b=>kind(b)==='bad').length;
  let s='<b>'+n+'</b> 个机器人连着这台服务器';
  if(on)s+='，<b>'+on+'</b> 个有人在用';
  if(wait)s+='，<b>'+wait+'</b> 个在等人来';
  if(bad)s+='，<b>'+bad+'</b> 个要处理';
  return s+'。';
}
function render(){
  const focused=document.activeElement?.id;
  const counts={all:bots.length,ok:0,wait:0,bad:0};bots.forEach(b=>counts[kind(b)]++);
  if(filter!=='all'&&!counts[filter])filter='all';
  const q=query.trim().toLowerCase();
  const shown=bots.filter(b=>(filter==='all'||kind(b)===filter)&&(!q||(b.username+' '+b.name+' '+b.ownerName+' '+b.ownerUsername+' '+b.claimUser).toLowerCase().includes(q)));
  const tab=(k,l)=>counts[k]||k==='all'?'<button class="tab" data-f="'+k+'" aria-pressed="'+(filter===k)+'">'+l+'<i>'+counts[k]+'</i></button>':'';
  const head='<header><div class="brand">'+CAN+'传声筒</div><span class="grow"></span><button class="btn bare" id="acct">账号</button><button class="btn primary" id="add">添加机器人</button></header>';
  if(!bots.length){
    app.innerHTML='<div class="wrap">'+head+'<div class="panel empty">'+waves()+ART()+'<h2>这条线还没接上。</h2><p>在 Telegram 的 @BotFather 发 /newbot 新建一个机器人，把它给你的 Token 粘贴过来。</p><button class="btn primary" id="add2" style="position:relative">添加第一个机器人</button></div></div>';
  }else{
    const cap=b=>esc((b.username||b.name).replace(/[^a-zA-Z0-9]/g,'').slice(0,2).toUpperCase()||'#');
    app.innerHTML='<div class="wrap">'+head+'<section class="panel hero">'+waves()+ART()+'<h1 class="lead">'+sentence()+'</h1><p class="meta">程序占 '+mb(server.rss)+' MB 内存，服务器还剩 '+mb(server.free)+' MB</p></section>'+
    '<div class="tools"><div class="seg">'+tab('all','全部')+tab('ok','在用')+tab('wait','等人来')+tab('bad','要处理')+'</div>'+(bots.length>6?'<input id="q" type="search" placeholder="找机器人或管理员" aria-label="搜索" value="'+esc(query)+'">':'')+'</div>'+
    '<div class="panel list"><div class="rope"><span class="pulse"></span></div>'+(shown.length?shown.map(b=>'<button class="row" data-n="'+esc(b.name)+'"><span class="knot '+kind(b)+'"></span><span class="cap">'+cap(b)+'</span><span><div class="name">'+esc(title(b))+'</div>'+who(b)+'</span><span class="nums"><span><strong>'+b.contacts+'</strong>联系人</span><span><strong>'+b.inbound+'</strong>消息</span></span>'+CHEV+'</button>').join(''):'<p class="none">没有符合的机器人。</p>')+'</div></div>';
  }
  document.getElementById('add').onclick=showAdd;
  document.getElementById('add2')?.addEventListener('click',showAdd);
  document.getElementById('acct').onclick=showAccount;
  app.querySelectorAll('[data-f]').forEach(el=>el.onclick=()=>{filter=el.dataset.f;render()});
  app.querySelectorAll('.row').forEach(el=>el.onclick=()=>showManage(bots.find(b=>b.name===el.dataset.n)));
  const input=document.getElementById('q');
  if(input){input.oninput=()=>{query=input.value;render()};if(focused==='q'){input.focus();input.setSelectionRange(query.length,query.length)}}
}

function sheet(html){
  const d=document.createElement('dialog');d.className='sheet';d.innerHTML='<div class="pane">'+html+'</div>';document.body.append(d);
  d.addEventListener('close',()=>d.remove());d.showModal();
  d.addEventListener('click',ev=>{if(ev.target===d)d.close()});
  d.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>d.close());
  return d;
}
const headOf=(t,sub)=>'<div class="pane-head"><h3>'+t+'</h3><button class="x" data-close aria-label="关闭">×</button></div>'+(sub?'<p class="sub">'+sub+'</p>':'');
function fail(d,err){const n=d.querySelector('.note');if(n)n.hidden=true;const e=d.querySelector('.err');e.textContent=err.message;e.hidden=false}
function ok(d,t){d.querySelector('.err').hidden=true;const n=d.querySelector('.note');n.textContent=t;n.hidden=false}

function showAdd(){
  const d=sheet(headOf('添加机器人','在 Telegram 的 @BotFather 发 /newbot 新建，把 Token 粘贴到这里。')+'<form><label for="t">Token</label><textarea id="t" placeholder="123456:ABC-DEF…" required autofocus></textarea><p class="hint">可以一次粘贴多个，一行一个。</p><label for="w">指定谁来用（选填）</label><input id="w" type="text" placeholder="@zhangsan" autocomplete="off"><p class="hint">填了，他私聊机器人就直接能用，不用点按钮，别人也抢不走。不填，谁先点「成为管理员」就归谁。一次粘贴多个时这项不生效。</p><p class="err" hidden></p><ul class="results" hidden></ul><div class="acts"><button class="btn primary" id="go">添加</button></div></form>');
  d.querySelector('form').onsubmit=async ev=>{ev.preventDefault();const go=d.querySelector('#go');go.disabled=true;d.querySelector('.err').hidden=true;
    try{const r=await call('/api/bots','POST',{tokens:d.querySelector('#t').value,user:d.querySelector('#w').value});
      const list=d.querySelector('.results');list.hidden=false;
      list.innerHTML=r.results.map(x=>x.ok?'<li><span>已添加 <strong>@'+esc(x.username)+'</strong></span><button type="button" class="btn" data-c="@'+esc(x.username)+'">复制用户名</button></li>':'<li class="no"><span>'+esc(x.hint)+' 没加上：'+esc(x.error)+'</span></li>').join('');
      list.querySelectorAll('[data-c]').forEach(b=>b.onclick=()=>copy(b.dataset.c,'已复制，发给朋友就行。'));
      if(r.results.every(x=>x.ok))d.querySelector('#t').value='';refresh();
    }catch(err){fail(d,err)}finally{go.disabled=false}};
}

function showManage(b){
  if(!b)return;
  const path='/api/bots/'+encodeURIComponent(b.name);
  const d=sheet(headOf(esc(title(b)),b.contacts+' 个联系人，收到 '+b.inbound+' 条消息')+
   (b.username?'<div class="send"><div>把它发给要用的人<strong>@'+esc(b.username)+'</strong></div><button class="btn" id="cp">复制</button></div>':'')+
   '<div class="tabs" role="tablist"><button role="tab" data-t="owner" aria-selected="true">管理员</button><button role="tab" data-t="set" aria-selected="false">设置</button><button role="tab" data-t="more" aria-selected="false">更多</button></div>'+
   '<div data-p="owner"><div class="owner" id="cur"></div><form id="a"><label for="w">'+(b.bound?'换一个人':'指定谁来用')+'</label><input id="w" type="text" placeholder="@zhangsan" autocomplete="off"><p class="hint" id="wh"></p><div class="acts"><button class="btn primary" id="assign"></button></div></form><div id="lb"></div></div>'+
   '<div data-p="set" hidden><form id="s"><label for="welcome">欢迎语</label><textarea id="welcome" placeholder="读取中…"></textarea><label class="switch"><span>人机验证<small>第一次发消息要答一道 10 以内的加减题</small></span><input id="v" type="checkbox" role="switch"></label><div class="acts"><button class="btn primary">保存设置</button></div></form></div>'+
   '<div data-p="more" hidden>'+(b.canDelete?'<form id="k" class="section" style="margin-top:18px"><h4>换 Token</h4><p class="hint">在 @BotFather 重置过 Token，或者这个机器人连不上时用。</p><input id="tk" type="password" placeholder="新的 Token" autocomplete="off" style="margin-top:10px"><div class="acts"><button class="btn">换 Token</button></div></form><div class="section"><h4>删除机器人</h4><p class="hint">它的聊天记录会一起删掉，不能恢复。要删的话，输入 <strong>'+esc(b.name)+'</strong> 确认。</p><input id="dn" type="text" autocomplete="off" style="margin-top:10px"><div class="acts"><button type="button" class="btn danger" id="del" disabled>删除机器人</button></div></div>':'<p class="hint" style="margin-top:18px">这是安装时的默认机器人，它的 Token 和卸载都在服务器上用 tgbot 命令操作。</p>')+'</div>'+
   '<p class="err" hidden></p><p class="note" hidden></p>');
  const paint=()=>{
    const cur=d.querySelector('#cur');
    cur.innerHTML=b.bound?'现在的管理员<strong>'+esc(b.ownerName||'已绑定')+(b.ownerUsername?' @'+esc(b.ownerUsername):'')+'</strong>ID '+esc(b.ownerId??''):who(b);
    d.querySelector('#wh').textContent=b.contacts>0?'填用户名，他私聊就直接成为管理员。留空会生成一个一次性链接，发给新管理员就行：老客户不能靠点按钮看到别人的聊天记录。聊天记录保留。':'填用户名，他私聊就直接成为管理员。留空就谁先点「成为管理员」归谁。';
    d.querySelector('#assign').textContent=b.bound?'换管理员':'开放绑定';
    const lb=d.querySelector('#lb');
    lb.innerHTML=b.link?'<div class="linkbox">'+esc(b.link)+'</div><div class="acts"><button type="button" class="btn" id="cl">复制链接</button></div>':'';
    lb.querySelector('#cl')?.addEventListener('click',()=>copy(b.link,'链接已复制，发给新管理员。'));
  };
  paint();
  d.querySelector('#cp')?.addEventListener('click',()=>copy('@'+b.username,'已复制，发给朋友就行。'));
  d.querySelectorAll('[data-t]').forEach(t=>t.onclick=()=>{d.querySelectorAll('[data-t]').forEach(x=>x.setAttribute('aria-selected',x===t));d.querySelectorAll('[data-p]').forEach(p=>p.hidden=p.dataset.p!==t.dataset.t);d.querySelector('.err').hidden=true;d.querySelector('.note').hidden=true});
  call(path+'/settings').then(s=>{d.querySelector('#welcome').value=s.welcome;d.querySelector('#v').checked=s.verify}).catch(e=>fail(d,e));
  let armed=false;
  d.querySelector('#a').onsubmit=async ev=>{ev.preventDefault();const w=d.querySelector('#w').value.trim(),btn=d.querySelector('#assign');
    if(b.bound&&!armed){armed=true;btn.textContent='再点一次确认：清除现在的管理员';return}
    armed=false;
    try{const r=await call(path+'/assign','POST',{user:w});Object.assign(b,r);paint();d.querySelector('#w').value='';refresh();
      ok(d,w?'已指定 '+w+'，让他私聊机器人，发条消息就能用了。':b.link?'已生成链接，发给新管理员，打开就绑定。':'已开放，谁先点「成为管理员」就归谁。')}catch(e){paint();fail(d,e)}};
  d.querySelector('#w').oninput=()=>{if(armed){armed=false;paint()}};
  d.querySelector('#s').onsubmit=async ev=>{ev.preventDefault();try{await call(path+'/settings','POST',{welcome:d.querySelector('#welcome').value,verify:d.querySelector('#v').checked});ok(d,'设置已保存，马上生效。')}catch(e){fail(d,e)}};
  d.querySelector('#k')?.addEventListener('submit',async ev=>{ev.preventDefault();try{await call(path+'/token','POST',{token:d.querySelector('#tk').value});d.querySelector('#tk').value='';ok(d,'Token 已换好，几秒后生效。');refresh()}catch(e){fail(d,e)}});
  const dn=d.querySelector('#dn'),del=d.querySelector('#del');
  if(dn){dn.oninput=()=>{del.disabled=dn.value!==b.name};del.onclick=async()=>{try{await call(path,'DELETE');d.close();toast('已删除 '+title(b));refresh()}catch(e){fail(d,e)}}}
}

function showAccount(){
  const d=sheet(headOf('账号','改密码后，其他设备要重新登录。')+'<form><label for="c">现在的密码</label><input id="c" type="password" autocomplete="current-password" required autofocus><label for="u">新账号（不改就留空）</label><input id="u" type="text" autocomplete="username"><label for="n">新密码（至少 8 位）</label><input id="n" type="password" autocomplete="new-password" required minlength="8"><p class="err" hidden></p><p class="note" hidden></p><div class="acts"><button class="btn primary">保存</button><button type="button" class="btn bare" id="out">退出登录</button></div></form>');
  d.querySelector('#out').onclick=async()=>{await call('/api/logout','POST');d.close();showLogin()};
  d.querySelector('form').onsubmit=async ev=>{ev.preventDefault();try{await call('/api/password','POST',{current:d.querySelector('#c').value,user:d.querySelector('#u').value,password:d.querySelector('#n').value});d.close();toast('已保存')}catch(e){fail(d,e)}};
}
load();
</script></body></html>`;
