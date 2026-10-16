// Rendering-level UI tests. No browser, network, or third-party DOM package.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function ui(){
 const app={innerHTML:'',addEventListener(){}};
 const toast={textContent:'',classList:{add(){},remove(){}}};
 const context=vm.createContext({document:{querySelector:s=>s==='#app'?app:toast,hidden:false},window:{addEventListener(){}},location:{hash:'#/'},structuredClone,console,setTimeout:()=>1,clearTimeout(){},fetch:()=>new Promise(()=>{})});
 vm.runInContext(fs.readFileSync('static/app.js','utf8'),context);
 vm.runInContext(`state.config={demo:true,demo_accounts:[{email:'owner@manyvo.local',name:'Мария',role:'owner'}]};state.user={id:'owner',name:'Мария',email:'owner@manyvo.local',role:'owner',balance:0};`,context);
 return {app,run:code=>vm.runInContext(code,context)};
}
const sample=`({id:'0123456789abcdef0123456789abcdef',title:'Исследование',question:'Вопрос?',status:'open',version:2,quota:5,count:1,age_min:18,age_max:65,country:'Россия',created_at:1800000000,published_at:1800000000,deadline:1800086400,options:[{id:'a',text:'A',position:0},{id:'b',text:'B',position:1}],my_answer:null})`;
test('login offers real fields and demo accounts without exposing an API key',()=>{
 const {app,run}=ui();run('renderLogin()');
 assert.match(app.innerHTML,/name="email"/);assert.match(app.innerHTML,/name="password"/);
 assert.match(app.innerHTML,/owner@manyvo.local/);assert.doesNotMatch(app.innerHTML,/OPENAI_API_KEY/);
});
test('study cards escape untrusted titles and render a meaningful action',()=>{
 const {app,run}=ui();run(`state.studies=[{...${sample},title:'<img src=x onerror=alert(1)>'}];renderList()`);
 assert.match(app.innerHTML,/&lt;img src=x onerror=alert\(1\)&gt;/);
 assert.doesNotMatch(app.innerHTML,/<img src=x/);
 assert.match(app.innerHTML,/Открыть исследование/);
});
test('draft supports an empty list and names every editable field',()=>{
 const {app,run}=ui();run(`state.detail={...${sample},status:'draft',options:[]};state.edit=structuredClone(state.detail);renderEditor(state.detail)`);
 for(const name of ['title','question','quota','age_min','age_max','country'])assert.match(app.innerHTML,new RegExp(`name="${name}"`));
 assert.match(app.innerHTML,/Добавить вариант/);assert.match(app.innerHTML,/Сохранить черновик/);
 assert.match(app.innerHTML,/Отправить на модерацию/);
});
test('owner open study renders count, hides distributions and has no fact form',()=>{
 const {app,run}=ui();run(`state.detail=${sample};renderOwner(state.detail)`);
 assert.match(app.innerHTML,/1 \/ 5/);assert.match(app.innerHTML,/только число принятых ответов/);
 assert.doesNotMatch(app.innerHTML,/chart-fill/);assert.doesNotMatch(app.innerHTML,/id="fact-form"/);
});
test('participant form requires both personal choice and prediction',()=>{
 const {app,run}=ui();run(`state.user.role='participant';state.detail=${sample};renderParticipant(state.detail)`);
 assert.match(app.innerHTML,/name="personal_id" value="a" required/);
 assert.match(app.innerHTML,/name="prediction_id" value="b" required/);
 assert.match(app.innerHTML,/Отправить два ответа/);
});
test('participant receipt shows own answers and base point, without owner report',()=>{
 const {app,run}=ui();run(`state.user.role='participant';state.detail={...${sample},my_answer:{personal_id:'a',prediction_id:'b'},points:{base:1}};renderParticipant(state.detail)`);
 assert.match(app.innerHTML,/Спасибо за ваш выбор/);assert.match(app.innerHTML,/до \+1/);
 assert.doesNotMatch(app.innerHTML,/id="answer-form"/);assert.doesNotMatch(app.innerHTML,/id="fact-form"/);
});
test('closed report renders two distributions, comparison, and fact editor',()=>{
 const {app,run}=ui();run(`state.detail={...${sample},status:'closed',count:5,closed_at:1800001000,complete:true,personal:[{id:'a',position:0,text:'A',count:3,percent:60},{id:'b',position:1,text:'B',count:2,percent:40}],predictions:[{id:'a',position:0,text:'A',count:1,percent:20},{id:'b',position:1,text:'B',count:4,percent:80}],personal_leaders:['a'],prediction_leaders:['b'],comparison:{label:'Нет данных',fact:null}};renderReport(state.detail)`);
 assert.match(app.innerHTML,/Личные предпочтения/);assert.match(app.innerHTML,/Прогноз большинства/);
 assert.match(app.innerHTML,/60,0%/);assert.match(app.innerHTML,/80,0%/);
 assert.match(app.innerHTML,/id="fact-form"/);assert.match(app.innerHTML,/name="value-a"/);
});
