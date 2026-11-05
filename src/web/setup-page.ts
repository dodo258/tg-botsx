// 部署后的设置页，只有一个任务：贴 Token，点认领链接。
// 设计语言：题材是传声筒（两只铁罐一根线）。页面底色取马口铁灰，唯一的强调色是那根棉线的红；线从松到紧、接通就是整页唯一的动画。
// 不加载外部字体和脚本：这一页要在任何网络下都能打开，所以用系统自带的宋体做标题、黑体做正文。
export function setupPage(nonce: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>传声筒 · 接线</title>
<style nonce="${nonce}">
:root{
  --tin:#E4E6E3;--tin-deep:#C9CCC8;--paper:#F3F4F1;--ink:#1D2124;--ink-soft:#5B6266;
  --thread:#B5301C;--thread-ink:#FFFFFF;--ok:#2B6B4C;--can:#AEB3AF;--can-rim:#8B918D;
  --serif:"Songti SC","Noto Serif CJK SC","Source Han Serif SC","STSong",serif;
  --sans:-apple-system,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei UI",sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --tin:#1E2223;--tin-deep:#4A5052;--paper:#272B2C;--ink:#E9EBE8;--ink-soft:#A3AAAC;
  --thread:#E0553D;--thread-ink:#1A0D0A;--ok:#6FBF97;--can:#5E6566;--can-rim:#7C8385;
}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--tin);color:var(--ink);font:16px/1.65 var(--sans);min-height:100dvh;display:flex;justify-content:center;padding:48px 16px}
main{width:100%;max-width:440px}
h1{font:600 40px/1.15 var(--serif);margin:0 0 8px;letter-spacing:.02em}
.lede{margin:0 0 28px;color:var(--ink-soft)}
.line{display:block;width:100%;height:auto;margin:0 0 28px}
.thread{fill:none;stroke:var(--thread);stroke-width:2.5;stroke-linecap:round;transition:d .7s cubic-bezier(.3,.7,.2,1)}
.can{fill:var(--can)}.mouth{fill:var(--can-rim)}.rib{fill:none;stroke:var(--can-rim);stroke-width:1}
.panel{background:var(--paper);border-radius:10px;padding:20px}
label{display:block;font-weight:600;margin-bottom:6px}
.hint{margin:8px 0 0;font-size:14px;color:var(--ink-soft)}
input{width:100%;font:15px/1.4 var(--mono);padding:11px 12px;border:1px solid var(--tin-deep);border-radius:4px;background:transparent;color:var(--ink)}
input:focus{outline:2px solid var(--thread);outline-offset:1px}
button,.go{display:block;width:100%;margin-top:14px;padding:12px;border:0;border-radius:4px;background:var(--thread);color:var(--thread-ink);font:600 16px/1.4 var(--sans);text-align:center;text-decoration:none;cursor:pointer}
button:hover,.go:hover{filter:brightness(1.08)}
button[disabled]{opacity:.55;cursor:default}
.err{margin:12px 0 0;color:var(--thread)}
.done{color:var(--ok);font-weight:600}
h2{font:600 22px/1.3 var(--serif);margin:0 0 8px}
p{margin:0 0 10px}
[hidden]{display:none!important}
code{font:14px var(--mono)}
@media (prefers-reduced-motion:reduce){.thread{transition:none}}
</style>
</head>
<body>
<main>
  <h1>传声筒</h1>
  <p class="lede">机器人已经部署好了，还差最后一步：把线接上。</p>
  <svg class="line" viewBox="0 0 400 70" role="img" aria-label="两只铁罐之间连着一根线">
    <path id="thread" class="thread" d="M60 35 C 150 72, 250 72, 340 35"/>
    <g>
      <rect class="can" x="16" y="14" width="40" height="42"/>
      <path class="rib" d="M26 14v42M36 14v42M46 14v42"/>
      <ellipse class="mouth" cx="16" cy="35" rx="8" ry="21"/>
      <ellipse class="can" cx="56" cy="35" rx="8" ry="21"/>
    </g>
    <g>
      <rect class="can" x="344" y="14" width="40" height="42"/>
      <path class="rib" d="M354 14v42M364 14v42M374 14v42"/>
      <ellipse class="mouth" cx="384" cy="35" rx="8" ry="21"/>
      <ellipse class="can" cx="344" cy="35" rx="8" ry="21"/>
    </g>
  </svg>

  <section class="panel" id="step-token">
    <form id="form">
      <label for="token">Bot Token</label>
      <input id="token" name="token" autocomplete="off" spellcheck="false" placeholder="123456789:AAE…" required>
      <p class="hint">就是部署时填的那串，用来确认你是部署者。只做比对，不会存下来。</p>
      <button id="submit" type="submit">接上线</button>
      <p class="err" id="err" role="alert" hidden></p>
    </form>
  </section>

  <section class="panel" id="step-claim" hidden>
    <h2 id="claim-title">线接上了</h2>
    <p id="claim-body">点下面的按钮，在 Telegram 里按「开始」，你就成了这个机器人的管理员。链接 10 分钟内有效。</p>
    <a class="go" id="claim" target="_blank" rel="noopener noreferrer">打开 Telegram 认领</a>
    <p class="hint" id="waiting">等你在 Telegram 里点开始…</p>
  </section>

  <section class="panel" id="step-done" hidden>
    <h2 class="done">接好了</h2>
    <p>回到 Telegram，用另一个账号给 <code id="bot-name"></code> 发条消息试试，它会转到你这里，你回复那条消息就是回复对方。</p>
    <p class="hint">这个页面可以关了。以后所有设置都在机器人里用 /settings 改。</p>
  </section>
</main>
<script nonce="${nonce}">
(function(){
  var form=document.getElementById('form'),err=document.getElementById('err'),submit=document.getElementById('submit');
  var thread=document.getElementById('thread');
  function post(path,token){return fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:token})}).then(function(r){return r.json()})}
  function tighten(){thread.setAttribute('d','M60 35 C 150 35, 250 35, 340 35')}
  form.addEventListener('submit',function(event){
    event.preventDefault();
    var token=document.getElementById('token').value.trim();
    err.hidden=true;submit.disabled=true;submit.textContent='正在连接 Telegram…';
    post('setup',token).then(function(res){
      if(!res.ok){throw new Error(res.error||'出错了，请再试一次。')}
      tighten();
      document.getElementById('step-token').hidden=true;
      document.getElementById('step-claim').hidden=false;
      document.getElementById('claim').href=res.claimLink;
      document.getElementById('bot-name').textContent='@'+res.username;
      if(res.hasOwner){
        document.getElementById('claim-title').textContent='已经有管理员了';
        document.getElementById('claim-body').textContent='Webhook 已重新注册。如果要换管理员账号，用新账号点下面的按钮；不换就可以关掉这个页面。';
      }
      var timer=setInterval(function(){
        post('setup/status',token).then(function(s){
          if(s.ok&&s.claimed){clearInterval(timer);document.getElementById('step-claim').hidden=true;document.getElementById('step-done').hidden=false}
        }).catch(function(){});
      },2500);
      setTimeout(function(){clearInterval(timer);document.getElementById('waiting').textContent='链接已过期，刷新页面重新生成。'},600000);
    }).catch(function(e){
      err.textContent=e.message==='Failed to fetch'?'连不上服务，检查网络后再试。':e.message;err.hidden=false;
      submit.disabled=false;submit.textContent='接上线';
    });
  });
})();
</script>
</body>
</html>`;
}
