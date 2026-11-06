// 网页管理的页面。运行时零依赖、不用构建，所以是一个内联的 HTML 字符串。
// 设计语言：两只铁罐一根线。镀锌铁皮的蓝灰做底，麻绳黄是唯一的亮色；一根麻绳串起所有机器人，绳结的颜色就是状态。
export const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#131B22" media="(prefers-color-scheme:dark)"><meta name="theme-color" content="#EDF0EE" media="(prefers-color-scheme:light)">
<title>传声筒</title>
<style>
:root{color-scheme:light dark;
--zinc:#EDF0EE;--sheet:#FBFCFA;--raise:#E3E8E5;--ink:#15212B;--muted:#5A6874;--line:#D5DBD8;--twine:#9A7432;--on-primary:#FBFCFA;--primary:#15212B;
--ok:#1F7F5C;--wait:#A9701C;--bad:#BC3D33;
--r-s:6px;--r-m:10px;--r-l:18px;
--sans:"PingFang SC","HarmonyOS Sans SC","Microsoft YaHei UI","Noto Sans CJK SC",system-ui,sans-serif;
--serif:"Songti SC","Noto Serif CJK SC","Source Han Serif SC","STSong",ui-serif,serif;
--ease:cubic-bezier(.22,.8,.24,1)}
@media (prefers-color-scheme:dark){:root{
--zinc:#131B22;--sheet:#1A242D;--raise:#222E38;--ink:#E9EEEB;--muted:#93A2AD;--line:#2B3843;--twine:#D8B778;--on-primary:#1A1408;--primary:#D8B778;
--ok:#6CC9A1;--wait:#E5B767;--bad:#EF8A7E}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--zinc);color:var(--ink);font:15px/1.65 var(--sans);font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
button,input,textarea{font:inherit;color:inherit}
a{color:inherit}
h1,h2,h3,h4,p{margin:0}
.wrap{max-width:820px;margin:0 auto;padding:0 max(20px,env(safe-area-inset-left)) 96px}

/* 控件 */
.btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:40px;padding:0 16px;border-radius:var(--r-m);border:1px solid var(--line);background:transparent;cursor:pointer;white-space:nowrap;transition:background-color .15s,border-color .15s}
.btn:hover{background:var(--raise)}
.btn.primary{background:var(--primary);border-color:var(--primary);color:var(--on-primary);font-weight:600}
.btn.primary:hover{opacity:.9;background:var(--primary)}
.btn.bare{border-color:transparent;color:var(--muted)}
.btn.bare:hover{color:var(--ink);background:var(--raise)}
.btn.danger{color:var(--bad);border-color:currentColor}
.btn.danger:hover{background:transparent;opacity:.8}
.btn[disabled]{opacity:.5;cursor:default}
:focus-visible{outline:2px solid var(--twine);outline-offset:2px;border-radius:var(--r-s)}
input[type=text],input[type=password],input[type=search],textarea{width:100%;min-height:44px;padding:10px 12px;background:var(--zinc);border:1px solid var(--line);border-radius:var(--r-m);transition:border-color .15s}
input:focus,textarea:focus{outline:none;border-color:var(--twine)}
textarea{resize:vertical;min-height:112px;line-height:1.55}
label{display:block;font-weight:550;font-size:14px;margin:18px 0 6px}
.hint{color:var(--muted);font-size:13.5px;margin-top:6px}
.err{color:var(--bad);font-size:14px;margin-top:12px}
.note{color:var(--ok);font-size:14px;margin-top:12px}

/* 页头 */
header{display:flex;align-items:center;gap:10px;padding:24px 0 0}
.brand{display:flex;align-items:center;gap:9px;font-family:var(--serif);font-weight:700;font-size:19px;letter-spacing:.06em}
.brand svg{width:24px;height:24px;color:var(--ink)}
header .grow{flex:1}

/* 首屏：一句话说清现状，麻绳从这里垂下来 */
.lead{font-family:var(--serif);font-weight:600;font-size:clamp(25px,4.6vw,36px);line-height:1.42;letter-spacing:.01em;margin:44px 0 12px;max-width:21em}
.lead b{font-weight:700;color:var(--twine)}
.meta{color:var(--muted);font-size:14px}
.tools{display:flex;align-items:center;gap:6px;margin:36px 0 10px;flex-wrap:wrap}
.tab{appearance:none;border:0;background:none;padding:6px 12px;border-radius:var(--r-s);cursor:pointer;color:var(--muted);min-height:36px}
.tab:hover{color:var(--ink)}
.tab[aria-pressed=true]{color:var(--ink);background:var(--raise);font-weight:550}
.tools input{margin-left:auto;width:190px;min-height:36px;padding:5px 11px;font-size:14px}

/* 麻绳和绳结 */
.rope{position:relative;padding-left:34px}
.rope::before{content:"";position:absolute;left:9px;top:0;bottom:30px;width:1.5px;background:var(--twine);border-radius:1px}
.pulse{position:absolute;left:7px;top:0;width:5.5px;height:42px;border-radius:3px;background:linear-gradient(transparent,var(--twine));filter:brightness(1.35);opacity:0;animation:signal 9s 1.2s var(--ease) infinite;pointer-events:none}
@keyframes signal{0%{top:-20px;opacity:0}6%{opacity:1}28%{opacity:1}34%{top:calc(100% - 60px);opacity:0}100%{top:calc(100% - 60px);opacity:0}}
.row{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto 14px;align-items:center;gap:0 20px;width:100%;padding:17px 16px 17px 16px;text-align:left;background:none;border:0;border-radius:var(--r-m);cursor:pointer;transition:background-color .15s}
.row:hover{background:var(--raise)}
.row+.row{margin-top:2px}
.knot{position:absolute;left:-30px;top:25px;width:11px;height:11px;border-radius:50%;background:var(--muted);box-shadow:0 0 0 4px var(--zinc)}
.knot.ok{background:var(--ok)}.knot.wait{background:var(--wait)}.knot.bad{background:var(--bad)}
.name{font-size:17px;font-weight:600;letter-spacing:.005em;overflow-wrap:anywhere}
.who{color:var(--muted);font-size:14px;overflow-wrap:anywhere}
.who strong{color:var(--ink);font-weight:500}
.who.bad{color:var(--bad)}.who.wait{color:var(--wait)}
.nums{text-align:right;color:var(--muted);font-size:13.5px;line-height:1.5;white-space:nowrap}
.nums strong{color:var(--ink);font-weight:500}
.chev{width:14px;height:14px;color:var(--muted);opacity:.7}
.none{color:var(--muted);padding:20px 16px}

/* 空状态和登录：两只罐子一根线 */
.cans{display:block;width:min(340px,100%);height:auto;color:var(--ink)}
.cans .string{stroke:var(--twine)}
.cans .travel{stroke:var(--twine);stroke-width:3;stroke-linecap:round;stroke-dasharray:14 400;animation:travel 5s linear infinite;filter:brightness(1.3)}
@keyframes travel{from{stroke-dashoffset:14}to{stroke-dashoffset:-414}}
.empty{margin-top:52px}
.empty p{color:var(--muted);margin:20px 0;max-width:30em}
.login{min-height:100dvh;display:grid;place-items:center;padding:24px}
.login form{width:min(372px,100%)}
.login h1{font-family:var(--serif);font-weight:700;font-size:42px;letter-spacing:.08em;margin-top:26px}
.login .btn{width:100%;margin-top:22px;min-height:46px}

/* 侧滑面板 */
dialog.sheet{position:fixed;inset:0 0 0 auto;margin:0;width:min(460px,100vw);max-width:100vw;height:100dvh;max-height:100dvh;padding:0;border:0;border-left:1px solid var(--line);background:var(--sheet);color:var(--ink);overflow:auto;overscroll-behavior:contain;animation:slide .28s var(--ease)}
dialog.sheet::backdrop{background:rgba(9,15,20,.5);animation:fade .2s}
@keyframes slide{from{transform:translateX(26px);opacity:0}}
@keyframes fade{from{opacity:0}}
.pane{padding:24px 26px calc(32px + env(safe-area-inset-bottom))}
.pane-head{display:flex;align-items:flex-start;gap:12px}
.pane-head h3{flex:1;font-size:20px;font-weight:650;overflow-wrap:anywhere;line-height:1.35}
.x{appearance:none;border:0;background:none;width:34px;height:34px;margin:-5px -8px 0 0;border-radius:var(--r-s);color:var(--muted);cursor:pointer;font-size:20px;line-height:1}
.x:hover{background:var(--raise);color:var(--ink)}
.sub{color:var(--muted);font-size:14px;margin-top:3px;overflow-wrap:anywhere}
.send{display:flex;align-items:center;gap:10px;margin-top:18px;padding:12px 14px;background:var(--zinc);border-radius:var(--r-m)}
.send div{flex:1;min-width:0;font-size:14px;color:var(--muted)}
.send strong{display:block;color:var(--ink);font-weight:600;font-size:15px;overflow-wrap:anywhere}
.tabs{display:flex;gap:2px;margin:22px -4px 0;border-bottom:1px solid var(--line)}
.tabs button{appearance:none;background:none;border:0;padding:9px 12px 10px;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs button:hover{color:var(--ink)}
.tabs button[aria-selected=true]{color:var(--ink);font-weight:600;border-bottom-color:var(--twine)}
.acts{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
.owner{margin-top:18px;font-size:14px;color:var(--muted)}
.owner strong{display:block;color:var(--ink);font-size:16px;font-weight:600;overflow-wrap:anywhere}
.linkbox{margin-top:12px;padding:12px 14px;background:var(--zinc);border-radius:var(--r-m);font-size:13.5px;overflow-wrap:anywhere}
.switch{display:flex;align-items:center;gap:12px;margin-top:20px;cursor:pointer;font-weight:550;font-size:14px}
.switch span{flex:1}
.switch small{display:block;font-weight:400;color:var(--muted);font-size:13.5px}
.switch input{appearance:none;position:relative;flex:none;width:44px;height:26px;margin:0;border-radius:13px;background:var(--line);cursor:pointer;transition:background-color .18s}
.switch input::after{content:"";position:absolute;left:3px;top:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:transform .18s var(--ease)}
.switch input:checked{background:var(--ok)}
.switch input:checked::after{transform:translateX(18px)}
.section{margin-top:30px}
.section h4{font-size:14px;font-weight:600}
.results{list-style:none;padding:0;margin:16px 0 0;font-size:14px}
.results li{padding:9px 0;border-top:1px solid var(--line);display:flex;align-items:center;gap:8px;overflow-wrap:anywhere}
.results li span{flex:1;min-width:0}
.results .no{color:var(--bad)}
.toast{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:9;background:var(--ink);color:var(--zinc);padding:9px 16px;border-radius:var(--r-m);font-size:14px;max-width:calc(100vw - 32px);animation:fade .15s}

@media (max-width:600px){
.lead{margin-top:32px}
.nums{display:none}
.row{grid-template-columns:minmax(0,1fr) 14px;gap:0 10px;padding:14px 10px}
.rope{padding-left:26px}.rope::before{left:6px}.pulse{left:4px}.knot{left:-25px;top:22px}
.tools input{margin-left:0;width:100%;order:9}
dialog.sheet{inset:auto 0 0 0;width:100vw;height:auto;max-height:90dvh;border-left:0;border-top:1px solid var(--line);border-radius:var(--r-l) var(--r-l) 0 0;animation-name:rise}
.pane{padding:20px 20px calc(28px + env(safe-area-inset-bottom))}
@keyframes rise{from{transform:translateY(36px);opacity:0}}
}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}.pulse{display:none}}
</style></head><body><div id="app"></div>
<script>
const CAN='<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><ellipse cx="8.5" cy="5.5" rx="5.5" ry="2.3" stroke="currentColor" stroke-width="1.5"/><path d="M3 5.5v12.2c0 1.3 2.5 2.3 5.5 2.3s5.500-1 5.500-2.300V5.500" stroke="currentColor" stroke-width="1.5"/><path d="M14 13c3.500 0 3 5 8 5" stroke="var(--twine)" stroke-width="1.500" stroke-linecap="round"/></svg>';
const CANS='<svg class="cans" viewBox="0 0 340 96" fill="none" aria-hidden="true"><g stroke="currentColor" stroke-width="1.600"><ellipse cx="30" cy="22" rx="19" ry="7"/><path d="M11 22v44c0 4 8.500 7 19 7s19-3 19-7V22"/><path d="M11 36c0 4 8.500 7 19 7s19-3 19-7M11 52c0 4 8.500 7 19 7s19-3 19-7" opacity=".3"/><ellipse cx="310" cy="22" rx="19" ry="7"/><path d="M291 22v44c0 4 8.500 7 19 7s19-3 19-7V22"/><path d="M291 36c0 4 8.500 7 19 7s19-3 19-7M291 52c0 4 8.500 7 19 7s19-3 19-7" opacity=".3"/></g><path class="string" d="M49 44C120 78 220 78 291 44" stroke-width="1.600"/><path class="travel" d="M49 44C120 78 220 78 291 44"/></svg>';
const CHEV='<svg class="chev" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M5 2.500 9.500 7 5 11.500" stroke="currentColor" stroke-width="1.500" stroke-linecap="round" stroke-linejoin="round"/></svg>';
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
  app.innerHTML='<div class="login"><form id="f">'+CANS+'<h1>传声筒</h1><p class="hint">管理这台服务器上的机器人</p><label for="u">账号</label><input id="u" type="text" autocomplete="username" required autofocus><label for="p">密码</label><input id="p" type="password" autocomplete="current-password" required><p class="err" id="e" hidden></p><button class="btn primary">登录</button></form></div>';
  document.getElementById('f').onsubmit=async ev=>{ev.preventDefault();const e=document.getElementById('e');e.hidden=true;
    try{await call('/api/login','POST',{user:document.getElementById('u').value,password:document.getElementById('p').value});await load()}catch(err){e.textContent=err.message;e.hidden=false}};
}

const kind=b=>b.state==='failed'||(!b.bound&&!b.claimOpen)?'bad':b.bound?'ok':'wait';
function who(b){
  if(b.state==='failed')return '<div class="who bad">Token 失效了，点开换一个</div>';
  if(b.bound)return '<div class="who">管理员 <strong>'+esc(b.ownerUsername?'@'+b.ownerUsername:b.ownerName||'已绑定')+'</strong></div>';
  if(!b.claimOpen)return '<div class="who bad">绑定已过期，点开重新开放</div>';
  if(b.claimMode==='user')return '<div class="who wait">等 @'+esc(b.claimUser)+' 私聊，发消息就自动绑定</div>';
  if(b.claimMode==='link')return '<div class="who wait">等新管理员打开链接</div>';
  if(b.claimMode==='pair')return '<div class="who wait">等人绑定，配对图案是 '+esc(b.claimPair||'（已失效）')+'</div>';
  return '<div class="who wait">等人来：谁先点「成为管理员」就归谁用</div>';
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
  const tab=(k,l)=>counts[k]||k==='all'?'<button class="tab" data-f="'+k+'" aria-pressed="'+(filter===k)+'">'+l+' '+counts[k]+'</button>':'';
  const head='<header><div class="brand">'+CAN+'传声筒</div><span class="grow"></span><button class="btn bare" id="acct">账号</button><button class="btn primary" id="add">添加机器人</button></header>';
  if(!bots.length){
    app.innerHTML='<div class="wrap">'+head+'<div class="empty">'+CANS+'<h2 class="lead" style="margin-top:28px">这条线还没接上。</h2><p>在 Telegram 的 @BotFather 发 /newbot 新建一个机器人，把它给你的 Token 粘贴过来。</p><button class="btn primary" id="add2">添加第一个机器人</button></div></div>';
  }else{
    app.innerHTML='<div class="wrap">'+head+'<h1 class="lead">'+sentence()+'</h1><p class="meta">程序占 '+mb(server.rss)+' MB 内存，服务器还剩 '+mb(server.free)+' MB</p>'+
    '<div class="tools">'+tab('all','全部')+tab('ok','在用')+tab('wait','等人来')+tab('bad','要处理')+(bots.length>6?'<input id="q" type="search" placeholder="找机器人或管理员" aria-label="搜索" value="'+esc(query)+'">':'')+'</div>'+
    '<div class="rope"><span class="pulse"></span>'+(shown.length?shown.map(b=>'<button class="row" data-n="'+esc(b.name)+'"><span class="knot '+kind(b)+'"></span><span><div class="name">'+esc(title(b))+'</div>'+who(b)+'</span><span class="nums"><strong>'+b.contacts+'</strong> 个联系人<br><strong>'+b.inbound+'</strong> 条消息</span>'+CHEV+'</button>').join(''):'<p class="none">没有符合的机器人。</p>')+'</div></div>';
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
