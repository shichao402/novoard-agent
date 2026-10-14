/**
 * M6 target 可视化编辑页（零构建单页，同磁贴页纪律）：
 * 双模式——表单（结构化编辑，保存重新生成 YAML）与 YAML 源码（原文落盘，保留注释）。
 * 数据源 GET /api/targets；保存 PUT /api/targets（服务端校验，不合法不上盘，422 内联报错）。
 * 仅经 localA2A 装配 store 时可达（127.0.0.1 边界即鉴权边界 + 写端点 Host/Origin 校验）。
 * 平台提示：win32 时顶部提示 cmd 语法（script 走 cmd.exe，openApp/openPath 经 start）。
 */
export function editorPage() {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Novoard · target 编辑器</title>
<style>
  body { font-family: -apple-system, "PingFang SC", "Segoe UI", sans-serif; background: #0f1115; color: #e6e8ee; margin: 0; padding: 20px 24px; }
  h1 { font-size: 18px; margin: 0; }
  .sub { color: #8b93a7; font-size: 12px; margin: 4px 0 16px; }
  .sub a { color: #4a90d9; text-decoration: none; }
  .bar { display: flex; gap: 8px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
  .bar .spacer { flex: 1; }
  button { background: #2a3040; color: #e6e8ee; border: 1px solid #3a4252; border-radius: 8px; padding: 6px 14px; font-size: 13px; cursor: pointer; }
  button:hover { border-color: #4a90d9; }
  button.primary { background: #2d6cb5; border-color: #2d6cb5; }
  button.danger { color: #ff8b84; }
  select, input, textarea { background: #1a1e26; color: #e6e8ee; border: 1px solid #3a4252; border-radius: 8px; padding: 6px 8px; font-size: 13px; box-sizing: border-box; }
  textarea { font-family: ui-monospace, Menlo, Consolas, monospace; width: 100%; }
  select:focus, input:focus, textarea:focus { outline: none; border-color: #4a90d9; }
  .layout { display: flex; gap: 20px; align-items: flex-start; }
  .targets-list { width: 210px; min-width: 170px; flex-shrink: 0; }
  .targets-list .item { padding: 8px 12px; border-radius: 8px; cursor: pointer; border: 1px solid transparent; margin-bottom: 4px; }
  .targets-list .item:hover { background: #1a1e26; }
  .targets-list .item.active { background: #1a1e26; border-color: #4a90d9; }
  .targets-list .id { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; }
  .targets-list .t { font-size: 11px; color: #8b93a7; margin-top: 2px; }
  .editor-pane { flex: 1; min-width: 0; max-width: 820px; }
  .field { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .field label { width: 150px; font-size: 12px; color: #8b93a7; text-align: right; flex-shrink: 0; }
  .field input, .field select { flex: 1; }
  .section { background: #151922; border: 1px solid #262c38; border-radius: 12px; padding: 14px 16px; margin-bottom: 14px; }
  .section h3 { margin: 0 0 10px; font-size: 13px; color: #aeb6c8; font-weight: 600; font-family: ui-monospace, Menlo, Consolas, monospace; }
  .step { background: #1a1e26; border: 1px solid #3a4252; border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; }
  .step .row { display: flex; gap: 6px; margin-bottom: 6px; align-items: center; }
  .step textarea { margin-bottom: 6px; }
  .kv { display: flex; gap: 6px; margin-bottom: 6px; }
  .kv input { flex: 1; min-width: 60px; }
  .hint { font-size: 11px; color: #8b93a7; margin: 4px 0 8px; }
  .win-hint { background: #242033; border: 1px solid #4a3f6b; color: #b3a6e0; border-radius: 10px; padding: 8px 14px; font-size: 12px; margin-bottom: 14px; display: none; }
  .errors { background: #2d1517; border: 1px solid #7a2c31; border-radius: 10px; padding: 10px 14px; margin-bottom: 14px; color: #ff8b84; font-size: 12px; display: none; }
  .errors div { font-family: ui-monospace, Menlo, Consolas, monospace; margin: 2px 0; }
  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #2a3040; padding: 8px 16px; border-radius: 8px; font-size: 13px; opacity: 0; transition: opacity .3s; }
  .toast.show { opacity: 1; }
  label.radio { font-size: 13px; color: #c3c9d6; }
</style></head><body>
<h1>Novoard · target 编辑器</h1>
<div class="sub">表单与 YAML 双模式 · 保存即校验（不合法不上盘）· 热生效 <a href="/">← 磁贴</a></div>
<div id="winhint" class="win-hint">Windows：script 步骤走 cmd.exe（cd /d、&amp;&amp; 连接），openApp/openPath 经 start 打开</div>
<div class="bar">
  <button id="modeform" class="primary" onclick="setMode('form')">表单模式</button>
  <button id="modeyaml" onclick="setMode('yaml')">YAML 源码</button>
  <span class="spacer"></span>
  <button class="primary" onclick="save()">保存（校验 + 备份 + 热生效）</button>
</div>
<div id="errors" class="errors"></div>
<div class="layout">
  <div class="targets-list">
    <div id="list"></div>
    <button style="width:100%;margin-top:6px" onclick="addTarget()">+ 新增 target</button>
  </div>
  <div class="editor-pane">
    <div id="formpane"></div>
    <div id="yamlpane" style="display:none">
      <textarea id="yamlta" rows="24" spellcheck="false"></textarea>
      <div class="hint">YAML 源码模式原文落盘（保留注释）；表单模式保存会重新生成 YAML（注释丢失）。</div>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
var state={targets:{},platform:"darwin",yaml:"",mode:"form",current:null};
function byId(i){return document.getElementById(i);}
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");}
function toast(m){var t=byId("toast");t.textContent=m;t.classList.add("show");setTimeout(function(){t.classList.remove("show");},2600);}
function showErrors(es){byId("errors").innerHTML=(es||[]).map(function(x){return "<div>"+esc(x)+"</div>";}).join("");byId("errors").style.display="block";}
function hideErrors(){byId("errors").style.display="none";}
function cur(){return state.current?state.targets[state.current]:null;}
function input(f,v){return '<input data-f="'+f+'" value="'+esc(v)+'" oninput="bind(this)">';}
function selectBox(f,opts,v){var h='<select data-f="'+f+'" onchange="bind(this)">';opts.forEach(function(o){h+='<option value="'+esc(o)+'"'+(o===v?" selected":"")+">"+esc(o)+"</option>";});return h+"</select>";}
function field(txt,ctrl){return '<div class="field"><label>'+txt+"</label>"+ctrl+"</div>";}
function bind(el){var t=cur();if(!t)return;var f=el.dataset.f;if(el.type==="checkbox")t[f]=el.checked;else t[f]=el.value;if(f==="title")renderList();}
async function load(){
  var r=await fetch("/api/targets");var b=await r.json();
  if(!b.ok){toast("读取失败："+(b.reason||""));return;}
  state.targets=b.targets||{};state.yaml=b.yaml||"";state.platform=b.platform||"darwin";
  if(state.platform==="win32")byId("winhint").style.display="block";
  if(!state.current||!state.targets[state.current])state.current=Object.keys(state.targets)[0]||null;
  renderList();renderPane();
}
function renderList(){
  var h="";
  for(var id in state.targets){
    var t=state.targets[id];
    h+='<div class="item'+(id===state.current?" active":"")+'" data-id="'+esc(id)+'"><div class="id">'+esc(id)+'</div><div class="t">'+esc(t.title||"")+"</div></div>";
  }
  byId("list").innerHTML=h||'<div class="hint">（无 target）</div>';
}
function renderPane(){
  if(state.mode==="yaml"){byId("formpane").style.display="none";byId("yamlpane").style.display="block";byId("yamlta").value=state.yaml;return;}
  byId("formpane").style.display="block";byId("yamlpane").style.display="none";renderForm();
}
function setMode(m){
  if(m===state.mode)return;
  if(m==="form"&&byId("yamlta").value!==state.yaml){if(!confirm("YAML 有未保存改动，切换将丢弃"))return;}
  state.mode=m;
  byId("modeform").className=m==="form"?"primary":"";
  byId("modeyaml").className=m==="yaml"?"primary":"";
  renderPane();
}
function setDefType(v){
  var t=cur();if(!t)return;
  if(v==="template"){delete t.steps;t.template="";}else{delete t.template;t.steps=[{script:"echo hello"}];}
  renderForm();
}
function renderForm(){
  var t=cur();
  if(!t){byId("formpane").innerHTML='<div class="hint">左侧选择或新增一个 target</div>';return;}
  var usesTpl=!!t.template&&!t.steps;
  var h="";
  h+='<div class="section"><h3>'+esc(state.current)+"</h3>";
  h+=field("标题",input("title",t.title||""));
  h+=field("schedule（可选）",input("schedule",t.schedule||""));
  h+=field("expose",selectBox("expose",["a2a","local"],t.expose||"a2a"));
  h+=field("audit",selectBox("audit",["none","summary","full"],t.audit||"summary"));
  h+=field("notify",selectBox("notify",["always","on-failure","never"],t.notify||"on-failure"));
  h+=field("offline",selectBox("offline",["reject","queue"],t.offline||"reject"));
  h+=field("offlineTtl（如 30m/2h）",input("offlineTtl",t.offlineTtl||""));
  h+=field("requiresApproval",'<input type="checkbox" data-f="requiresApproval" onchange="bind(this)"'+(t.requiresApproval?" checked":"")+">");
  h+="</div>";
  h+='<div class="section"><h3>执行定义</h3><div class="row" style="margin-bottom:10px">';
  h+='<label class="radio"><input type="radio" name="deftype" value="steps" onchange="setDefType(this.value)"'+(usesTpl?"":" checked")+"> 内联 steps</label>&nbsp;&nbsp;";
  h+='<label class="radio"><input type="radio" name="deftype" value="template" onchange="setDefType(this.value)"'+(usesTpl?" checked":"")+"> 模板引用</label></div>";
  if(usesTpl){
    h+=field("template 名",input("template",t.template||""));
    h+='<div class="hint">引用 agents/&lt;agentId&gt;/templates/&lt;名&gt;.yaml（模板文件暂不在编辑器管理范围）</div>';
  }else{
    h+='<div id="stepsbox"></div><button onclick="addStep()">+ 添加步骤</button>';
  }
  h+="</div>";
  h+='<div class="section"><h3>vars（steps 中 {{var}} 插值）</h3><div id="varsbox"></div><button onclick="addVar()">+ 添加变量</button></div>';
  h+='<button class="danger" onclick="delTarget()">删除此 target</button>';
  byId("formpane").innerHTML=h;
  if(!usesTpl)renderSteps();
  renderVars();
}
function renderSteps(){
  var t=cur();if(!t)return;
  if(!Array.isArray(t.steps))t.steps=[];
  var h="";
  t.steps.forEach(function(s,i){h+=stepCard(s,i,t.steps.length);});
  byId("stepsbox").innerHTML=h||'<div class="hint">（无步骤，至少 1 个）</div>';
}
function stepType(s){
  if(typeof s.script==="string")return "script";
  if(typeof s.openApp==="string")return "openApp";
  if(typeof s.openPath==="string")return "openPath";
  return "script";
}
function stepCard(s,i,n){
  var type=stepType(s);
  var h='<div class="step"><div class="row">';
  h+='<select onchange="setStepType('+i+',this.value)">';
  ["script","openApp","openPath"].forEach(function(o){h+='<option value="'+o+'"'+(o===type?" selected":"")+">"+o+"</option>";});
  h+='</select><span style="flex:1"></span>';
  if(i>0)h+='<button onclick="moveStep('+i+',-1)">↑</button>';
  if(i<n-1)h+='<button onclick="moveStep('+i+',1)">↓</button>';
  h+='<button class="danger" onclick="delStep('+i+')">删除</button></div>';
  if(type==="script"){
    h+='<textarea rows="3" spellcheck="false" data-i="'+i+'" data-sf="script" oninput="bindStep(this)">'+esc(s.script||"")+"</textarea>";
    h+='<input placeholder="cwd（可选）" data-i="'+i+'" data-sf="cwd" value="'+esc(s.cwd||"")+'" oninput="bindStep(this)">';
  }else{
    h+='<input placeholder="'+type+' 值" data-i="'+i+'" data-sf="'+type+'" value="'+esc(s[type]||"")+'" oninput="bindStep(this)">';
  }
  return h+"</div>";
}
function bindStep(el){var s=cur().steps[+el.dataset.i];if(s)s[el.dataset.sf]=el.value;}
function setStepType(i,v){var o;if(v==="script")o={script:""};else{o={};o[v]="";}cur().steps[i]=o;renderSteps();}
function addStep(){cur().steps.push({script:""});renderSteps();}
function delStep(i){cur().steps.splice(i,1);renderSteps();}
function moveStep(i,d){var a=cur().steps;var j=i+d;var t=a[i];a[i]=a[j];a[j]=t;renderSteps();}
function renderVars(){
  var t=cur();if(!t)return;
  if(!t.vars||typeof t.vars!=="object")t.vars={};
  var keys=Object.keys(t.vars);
  var h="";
  keys.forEach(function(k,i){
    h+='<div class="kv"><input value="'+esc(k)+'" onchange="varKey('+i+',this.value)">';
    h+='<input value="'+esc(t.vars[k])+'" oninput="varVal('+i+',this.value)">';
    h+='<button class="danger" onclick="delVarKey('+i+')">×</button></div>';
  });
  byId("varsbox").innerHTML=h||'<div class="hint">（无变量）</div>';
}
function varKey(i,v){var t=cur();var ks=Object.keys(t.vars);var k=ks[i];if(!k)return;var val=t.vars[k];delete t.vars[k];if(v)t.vars[v]=val;renderVars();}
function varVal(i,v){var t=cur();var ks=Object.keys(t.vars);if(ks[i]!==undefined)t.vars[ks[i]]=v;}
function delVarKey(i){var t=cur();var ks=Object.keys(t.vars);delete t.vars[ks[i]];renderVars();}
function addVar(){var t=cur();t.vars=t.vars||{};var n="var1";var i=1;while(t.vars[n]!==undefined)n="var"+(++i);t.vars[n]="";renderVars();}
function addTarget(){
  var id="new-target";var i=1;while(state.targets[id])id="new-target-"+(++i);
  state.targets[id]={title:"新 target",steps:[{script:"echo hello"}],vars:{},expose:"a2a",audit:"summary",requiresApproval:false,notify:"on-failure"};
  state.current=id;renderList();renderPane();
}
function delTarget(){
  if(!state.current)return;
  if(!confirm("删除 "+state.current+"？（保存后生效）"))return;
  delete state.targets[state.current];
  state.current=Object.keys(state.targets)[0]||null;
  renderList();renderPane();
}
function sanitize(ts){
  var out={};
  for(var id in ts){
    var t=JSON.parse(JSON.stringify(ts[id]));
    ["schedule","offlineTtl","template"].forEach(function(f){if(!String(t[f]||"").trim())delete t[f];});
    if(t.steps)delete t.template;else if(t.template)delete t.steps;
    if(!t.vars||Object.keys(t.vars).length===0)delete t.vars;
    out[id]=t;
  }
  return out;
}
async function save(){
  var body;
  if(state.mode==="yaml")body={yaml:byId("yamlta").value};
  else body={targets:sanitize(state.targets)};
  var r=await fetch("/api/targets",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  var b=null;
  try{b=await r.json();}catch(e){}
  if(!r.ok||!b||!b.ok){showErrors((b&&b.errors)||["保存失败：HTTP "+r.status]);return;}
  hideErrors();toast("已保存 · 校验通过 · 热生效");
  await load();
}
byId("list").addEventListener("click",function(e){
  var it=e.target.closest(".item");if(!it)return;
  state.current=it.dataset.id;renderList();renderPane();
});
load();
</script></body></html>`;
}
