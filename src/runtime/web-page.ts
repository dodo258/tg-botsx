// 网页管理的页面。运行时零依赖、不用构建，所以是一个内联的 HTML 字符串。
export const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>传声筒</title>
<style>
/* 题材：两只铁罐一根线。搪瓷白底、藏青墨字、搪瓷蓝做动作色；一根贯穿列表的线是页面唯一的记忆点，线上的结显示每个机器人的状态。 */
:root{color-scheme:light dark;
--enamel:#EDF0EC;--sheet:#F8FAF6;--ink:#14263A;--muted:#5E6C78;--rule:#D3D9D3;--string:#A58A5B;
--blue:#1F4E8C;--blue-ink:#fff;--ok:#2E7D5B;--wait:#B5690F;--bad:#B23A32;
--r-s:4px;--r-m:8px;--r-l:14px;
--sans:"PingFang SC","HarmonyOS Sans SC","Microsoft YaHei UI","Noto Sans CJK SC",system-ui,sans-serif;
--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--enamel:#101A25;--sheet:#17232F;--ink:#E7ECE8;--muted:#93A1AD;--rule:#2B3946;--string:#B79C6C;--blue:#7FB0EE;--blue-ink:#0D1A29;--ok:#63BC93;--wait:#E5A44F;--bad:#EC7D74}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--enamel);color:var(--ink);font:15px/1.6 var(--sans);font-variant-numeric:tabular-nums}
button,input,textarea{font:inherit;color:inherit}
a{color:var(--blue)}
.wrap{max-width:880px;margin:0 auto;padding:0 20px 72px}
header{display:flex;align-items:center;gap:12px;padding:26px 0 22px}
header h1{font-size:20px;margin:0;font-weight:650;letter-spacing:.02em}
header .spacer{flex:1}
.can{width:26px;height:26px;flex:none}
.btn{appearance:none;border:1px solid var(--rule);background:var(--sheet);padding:7px 14px;border-radius:var(--r-m);cursor:pointer;white-space:nowrap;min-height:38px}
.btn:hover{border-color:var(--muted)}
.btn:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--blue);outline-offset:1px}
.btn.primary{background:var(--blue);border-color:var(--blue);color:var(--blue-ink);font-weight:600}
.btn.danger{color:var(--bad);border-color:currentColor;background:transparent}
.btn.quiet{border-color:transparent;background:transparent;color:var(--muted)}
.btn.quiet:hover{color:var(--ink)}
.btn[disabled]{opacity:.55;cursor:default}
.summary{color:var(--muted);margin:0 0 18px;font-size:14px}
.summary b{color:var(--ink);font-weight:600}
.empty{padding:56px 24px;text-align:center;background:var(--sheet);border:1px dashed var(--rule);border-radius:var(--r-l)}
.empty p{margin:0 0 16px;color:var(--muted)}
.line{position:relative;padding-left:30px}
.line::before{content:"";position:absolute;left:8px;top:14px;bottom:14px;width:1.5px;background:var(--string)}
.bot{position:relative;background:var(--sheet);border:1px solid var(--rule);border-radius:var(--r-l);padding:15px 18px;margin-bottom:10px;display:grid;grid-template-columns:1fr auto;gap:4px 16px;align-items:center}
.knot{position:absolute;left:-27px;top:22px;width:12px;height:12px;border-radius:50%;background:var(--muted);border:2.5px solid var(--enamel)}
.knot.ok{background:var(--ok)}.knot.wait{background:var(--wait)}.knot.bad{background:var(--bad)}
.bot h2{font-size:16px;margin:0;font-weight:600;font-family:var(--mono);overflow-wrap:anywhere}
.bot h2 a{color:inherit;text-decoration:none}.bot h2 a:hover{text-decoration:underline}
.who{grid-column:1;font-size:14px;color:var(--muted);overflow-wrap:anywhere}
.who strong{color:var(--ink);font-weight:550}
.who.bad{color:var(--bad)}
.acts{grid-column:2;grid-row:1/3}
.stat{font-size:13px;color:var(--muted);grid-column:1}
dialog{border:1px solid var(--rule);border-radius:var(--r-l);background:var(--sheet);color:var(--ink);padding:0;width:min(480px,calc(100vw - 32px));max-height:calc(100dvh - 32px)}
dialog::backdrop{background:rgba(10,20,30,.45)}
.dlg{padding:20px 22px 18px}
.dlg h3{margin:0 0 4px;font-size:17px;font-weight:650;overflow-wrap:anywhere}
.dlg .sub{margin:0 0 14px;color:var(--muted);font-size:13.5px}
label{display:block;font-size:13.5px;font-weight:550;margin:14px 0 5px}
.hint{color:var(--muted);font-size:13px;font-weight:400;margin:5px 0 0}
input[type=text],input[type=password],textarea{width:100%;background:var(--enamel);border:1px solid var(--rule);border-radius:var(--r-m);padding:9px 11px;min-height:40px}
textarea{resize:vertical;min-height:110px}
textarea.mono,input.mono{font-family:var(--mono);font-size:13.5px}
.row{display:flex;gap:8px;justify-content:flex-end;margin-top:18px;flex-wrap:wrap}
.row .left{margin-right:auto}
.section{border-top:1px solid var(--rule);margin-top:18px;padding-top:4px}
.section h4{font-size:13.5px;margin:12px 0 2px;font-weight:600}
.check{display:flex;gap:8px;align-items:center;font-weight:400;margin:10px 0 0;min-height:32px}
.check input{width:18px;height:18px;margin:0}
.err{color:var(--bad);font-size:14px;margin:12px 0 0}
.note{color:var(--ok);font-size:14px;margin:12px 0 0}
.result{margin:10px 0 0;padding:0;list-style:none;font-size:14px}
.result li{padding:5px 0;border-top:1px solid var(--rule);overflow-wrap:anywhere}
.login{min-height:100dvh;display:grid;place-items:center;padding:20px}
.login form{width:min(360px,100%);background:var(--sheet);border:1px solid var(--rule);border-radius:var(--r-l);padding:26px 24px}
.login h1{display:flex;align-items:center;gap:10px;margin:0 0 6px;font-size:20px;font-weight:650}
.login .btn{width:100%;margin-top:18px}
.toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:var(--ink);color:var(--enamel);padding:8px 16px;border-radius:var(--r-m);font-size:14px;max-width:calc(100vw - 32px)}
@media (max-width:560px){.wrap{padding:0 14px 56px}.bot{padding:13px 14px;gap:3px 10px}.line{padding-left:26px}.line::before{left:6px}.knot{left:-25px}.bot h2{font-size:15px}}
</style></head><body><div id="app"></div>
<script>
const CAN='<svg class="can" viewBox="0 0 26 26" fill="none" aria-hidden="true"><ellipse cx="9" cy="6" rx="6" ry="2.4" stroke="currentColor" stroke-width="1.6"/><path d="M3 6v13c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4V6" stroke="currentColor" stroke-width="1.6"/><path d="M15 14c3 0 3 5 8 5" stroke="var(--string)" stroke-width="1.6" stroke-linecap="round"/></svg>';
const app=document.getElementById('app');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function call(path,method='GET',body){
  const res=await fetch(path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined,credentials:'same-origin'});
  const data=await res.json().catch(()=>({error:'服务器没有正常响应。'}));
  if(res.status===401&&path!=='/api/login'&&path!=='/api/password'){showLogin();throw new Error('请先登录。')}
  if(!res.ok)throw new Error(data.error||'出错了。');
  return data;
}
function toast(text){const t=document.createElement('div');t.className='toast';t.setAttribute('role','status');t.textContent=text;document.body.append(t);setTimeout(()=>t.remove(),2600)}
function showLogin(){
  app.innerHTML='<div class="login"><form id="f"><h1>'+CAN+'传声筒</h1><p class="hint">管理这台服务器上的机器人</p><label for="u">账号</label><input id="u" type="text" autocomplete="username" required autofocus><label for="p">密码</label><input id="p" type="password" autocomplete="current-password" required><p class="err" id="e" hidden></p><button class="btn primary">登录</button></form></div>';
  document.getElementById('f').onsubmit=async ev=>{ev.preventDefault();const e=document.getElementById('e');e.hidden=true;
    try{await call('/api/login','POST',{user:document.getElementById('u').value,password:document.getElementById('p').value});await load()}catch(err){e.textContent=err.message;e.hidden=false}};
}
function whoText(b){
  if(b.state==='failed')return '<div class="who bad">Token 失效了，到 @BotFather 拿新的再更换</div>';
  if(b.bound)return '<div class="who">管理员 <strong>'+esc((b.ownerName||'已绑定').replace(/（ID \\d+）$/,''))+'</strong></div>';
  if(!b.claimOpen)return '<div class="who bad">绑定已过期，点「管理」重新开放</div>';
  if(b.claimMode==='user')return '<div class="who">等 <strong>@'+esc(b.claimUser)+'</strong> 私聊机器人并点按钮</div>';
  if(b.claimMode==='pair')return '<div class="who">等人绑定，配对图案 <strong>'+esc(b.claimPair||'已失效')+'</strong></div>';
  return '<div class="who">等人绑定：谁先私聊并点按钮，就归谁用</div>';
}
function knot(b){return b.state==='failed'||(!b.bound&&!b.claimOpen)?'bad':b.bound&&b.state==='online'?'ok':b.state==='online'?'wait':''}
const mb=n=>Math.round(n/1048576);
let bots=[];
async function load(){
  let data;try{data=await call('/api/bots')}catch(e){if(e.message!=='请先登录。')toast(e.message);return}
  bots=data.bots;
  const bound=bots.filter(b=>b.bound).length;
  app.innerHTML='<div class="wrap"><header>'+CAN+'<h1>传声筒</h1><span class="spacer"></span><button class="btn quiet" id="acct">账号</button><button class="btn primary" id="add">添加机器人</button></header>'+
  (bots.length?'<p class="summary"><b>'+bots.length+'</b> 个机器人，<b>'+bound+'</b> 个有人在用 · 程序占内存 <b>'+mb(data.server.rss)+' MB</b>，服务器剩余 '+mb(data.server.free)+' MB</p><div class="line">'+bots.map((b,i)=>'<article class="bot"><span class="knot '+knot(b)+'" title="'+(b.state==='online'?'在线':b.state==='failed'?'出错':'连接中')+'"></span><h2>'+(b.chatLink?'<a href="'+esc(b.chatLink)+'" target="_blank" rel="noopener">@'+esc(b.username)+'</a>':esc(b.name))+'</h2>'+whoText(b)+'<div class="stat">'+b.contacts+' 个联系人 · 收到 '+b.inbound+' 条消息</div><div class="acts"><button class="btn" data-i="'+i+'">管理</button></div></article>').join('')+'</div>'
  :'<div class="empty"><p>还没有机器人。在 @BotFather 发 /newbot 新建，把 Token 粘贴过来。</p><button class="btn primary" id="add2">添加第一个机器人</button></div>')+'</div>';
  document.getElementById('add').onclick=showAdd;
  document.getElementById('add2')?.addEventListener('click',showAdd);
  document.getElementById('acct').onclick=showAccount;
  app.querySelectorAll('[data-i]').forEach(el=>el.onclick=()=>showManage(bots[+el.dataset.i]));
}
function dialog(html){
  const d=document.createElement('dialog');d.innerHTML='<div class="dlg">'+html+'</div>';document.body.append(d);
  d.addEventListener('close',()=>d.remove());d.showModal();
  d.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>d.close());
  return d;
}
function fail(d,err){const e=d.querySelector('.err');e.textContent=err.message;e.hidden=false}
function showAdd(){
  const d=dialog('<h3>添加机器人</h3><p class="sub">加好以后，把机器人的用户名发给要用的人。对方私聊机器人，点「成为管理员」就能用。</p><form><label for="t">Token</label><textarea id="t" class="mono" placeholder="123456:ABC-DEF…" required autofocus></textarea><p class="hint">在 @BotFather 发 /newbot 得到。可以一次粘贴多个，一行一个。</p><label for="w">只让这个人当管理员（选填）</label><input id="w" type="text" class="mono" placeholder="@zhangsan" autocomplete="off"><p class="hint">不填就谁先点算谁。粘贴多个 Token 时这一项不生效。</p><p class="err" hidden></p><ul class="result" hidden></ul><div class="row"><button type="button" class="btn" data-close>关闭</button><button class="btn primary">添加</button></div></form>');
  d.querySelector('form').onsubmit=async ev=>{ev.preventDefault();const go=d.querySelector('.primary');go.disabled=true;d.querySelector('.err').hidden=true;
    try{const r=await call('/api/bots','POST',{tokens:d.querySelector('#t').value,user:d.querySelector('#w').value});
      const list=d.querySelector('.result');list.hidden=false;
      list.innerHTML=r.results.map(x=>x.ok?'<li>已添加 <b>@'+esc(x.username)+'</b></li>':'<li style="color:var(--bad)">'+esc(x.hint)+'：'+esc(x.error)+'</li>').join('');
      if(r.results.every(x=>x.ok))d.querySelector('#t').value='';load();
    }catch(err){fail(d,err)}finally{go.disabled=false}};
}
function showManage(b){
  const d=dialog('<h3>@'+esc(b.username||b.name)+'</h3><p class="sub">'+(b.bound?'管理员：'+esc(b.ownerName||'已绑定'):'还没有管理员')+'</p>'+
  '<form id="a"><label for="w">'+(b.bound?'换管理员':'谁来当管理员')+'</label><input id="w" type="text" class="mono" placeholder="@zhangsan" autocomplete="off" value="'+(b.claimMode==='user'&&!b.bound?'@'+esc(b.claimUser):'')+'"><p class="hint">填用户名就只有他能点「成为管理员」。留空就谁先点算谁。聊天记录保留。</p><div class="row"><button class="btn">'+(b.bound?'清除现有管理员并开放':'开放绑定')+'</button></div></form>'+
  '<form id="s" class="section"><h4>机器人设置</h4><label for="welcome">欢迎语</label><textarea id="welcome" placeholder="读取中…"></textarea><label class="check"><input id="v" type="checkbox">第一次发消息要答题（10 以内加减）</label><div class="row"><button class="btn">保存设置</button></div></form>'+
  (b.canDelete?'<form id="k" class="section"><h4>更换 Token</h4><input id="tk" type="password" class="mono" placeholder="新的 Token" autocomplete="off" style="margin-top:8px"><div class="row"><button class="btn">更换</button></div></form>':'')+
  '<p class="err" hidden></p><p class="note" hidden></p><div class="row">'+(b.canDelete?'<button type="button" class="btn danger left" id="del">删除机器人</button>':'')+'<button type="button" class="btn" data-close>关闭</button></div>');
  const say=t=>{const n=d.querySelector('.note');n.textContent=t;n.hidden=false;d.querySelector('.err').hidden=true};
  const path='/api/bots/'+encodeURIComponent(b.name);
  call(path+'/settings').then(s=>{d.querySelector('#welcome').value=s.welcome;d.querySelector('#v').checked=s.verify}).catch(e=>fail(d,e));
  d.querySelector('#a').onsubmit=async ev=>{ev.preventDefault();const w=d.querySelector('#w').value.trim();
    if(b.bound&&!confirm('清除现有管理员？之后由'+(w?w:'第一个点按钮的人')+'接管。聊天记录保留。'))return;
    try{await call(path+'/assign','POST',{user:w});say(w?'已开放给 '+w+'，让他私聊机器人并点按钮。':'已开放，谁先点算谁。');load()}catch(e){fail(d,e)}};
  d.querySelector('#s').onsubmit=async ev=>{ev.preventDefault();try{await call(path+'/settings','POST',{welcome:d.querySelector('#welcome').value,verify:d.querySelector('#v').checked});say('设置已保存，立刻生效。')}catch(e){fail(d,e)}};
  d.querySelector('#k')?.addEventListener('submit',async ev=>{ev.preventDefault();try{await call(path+'/token','POST',{token:d.querySelector('#tk').value});d.querySelector('#tk').value='';say('Token 已更换，几秒后生效。');load()}catch(e){fail(d,e)}});
  d.querySelector('#del')?.addEventListener('click',async()=>{
    if(prompt('会删除这个机器人和它的全部聊天数据，不能恢复。\\n确认的话请输入机器人的名字：'+b.name)!==b.name)return;
    try{await call(path,'DELETE');d.close();toast('已删除');load()}catch(e){fail(d,e)}});
}
function showAccount(){
  const d=dialog('<h3>账号</h3><p class="sub">改密码后，其他设备要重新登录。</p><form><label for="c">当前密码</label><input id="c" type="password" autocomplete="current-password" required autofocus><label for="u">新账号（不改就留空）</label><input id="u" type="text" autocomplete="username"><label for="n">新密码（至少 8 位）</label><input id="n" type="password" autocomplete="new-password" required minlength="8"><p class="err" hidden></p><div class="row"><button type="button" class="btn quiet left" id="out">退出登录</button><button type="button" class="btn" data-close>取消</button><button class="btn primary">保存</button></div></form>');
  d.querySelector('#out').onclick=async()=>{await call('/api/logout','POST');d.close();showLogin()};
  d.querySelector('form').onsubmit=async ev=>{ev.preventDefault();try{await call('/api/password','POST',{current:d.querySelector('#c').value,user:d.querySelector('#u').value,password:d.querySelector('#n').value});d.close();toast('已保存')}catch(e){fail(d,e)}};
}
load();
</script></body></html>`;
